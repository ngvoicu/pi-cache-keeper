import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isPlainObject } from "./cached-request.ts";

/** Where the model data comes from: a public, read-only API. No key, no account. */
export const DATA_SOURCE = "https://providers.dev";
const DATA_API = `${DATA_SOURCE}/api/v1`;
/** providers.dev is asked again once the saved data is this old. */
export const DATA_MAX_AGE_MS = 24 * 60 * 60_000;
const PAGE_SIZE = 200;
const REQUEST_TIMEOUT_MS = 20_000;
/** A shorter lifetime cannot carry a countdown or a refresh, so it is treated as "no safe lifetime". */
const MIN_LIFETIME_SECONDS = 60;
/** The provider id pi-cliproxyapi-provider registers by default, and the name it shows. */
const PROXY_PROVIDER_ID = "cliproxyapi";
const PROXY_PROVIDER_NAME = "CLIProxyAPI";

const storePath = () => join(getAgentDir(), "cache-keeper-models.json");
const modelsPath = () => join(getAgentDir(), "models.json");
const label = (path: string) => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);
export const modelsPathLabel = () => label(modelsPath());

export interface CostTier {
	inputTokensAbove: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** Prices in USD per million tokens, in the shape of pi's `cost`. */
export interface Cost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tiers?: CostTier[];
}

/** What providers.dev says about one model at one provider, reduced to what pi can use. */
export interface Facts {
	/** The largest input, in tokens, the model takes. */
	window?: number;
	/** True when `window` is only the largest input an evaluation saw accepted, so the real limit may be higher. */
	windowAtLeast?: boolean;
	maxOutput?: number;
	/** Seconds a cache entry can be counted on, per retention tier. 0: evaluations found no safe lifetime. */
	short?: number;
	long?: number;
	cost?: Cost;
}

export type Field = "window" | "short" | "long" | "price";
export const FIELDS: readonly Field[] = ["window", "short", "long", "price"];

/** What this extension put into models.json for one model. */
export interface Written {
	contextWindow?: number;
	maxTokens?: number;
	promptCache?: { short?: number; long?: number };
	cost?: Cost;
}

export interface DataStore {
	version: 1;
	/** When providers.dev was last asked, and the dataset it answered with. */
	checkedAt?: number;
	datasetVersion?: string;
	/** providers.dev provider id → model id → facts. */
	providers: Record<string, Record<string, Facts>>;
	/** pi provider id of a proxy → model id → the lab the proxy says owns the model. */
	owners: Record<string, Record<string, string>>;
	/** pi provider id of a proxy → model id → the credentials that serve it, when the proxy lists them. */
	accounts: Record<string, Record<string, ProxyAccount[]>>;
	/** pi provider id → model id → what this extension wrote into models.json. */
	written: Record<string, Record<string, Written>>;
}

export const emptyStore = (): DataStore => ({ version: 1, providers: {}, owners: {}, accounts: {}, written: {} });

const positive = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined);
const atLeastZero = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

interface Predicate {
	field: string;
	op: string;
	value: unknown;
}

/** A rule's condition as a list of predicates that must all hold; undefined when it is any other shape. */
function conjunction(when: unknown): Predicate[] | undefined {
	if (when === null || when === undefined) return [];
	if (!isPlainObject(when)) return undefined;
	if (when.kind === "predicate" && typeof when.field === "string" && typeof when.op === "string") return [{ field: when.field, op: when.op, value: when.value }];
	if (when.kind === "all" && Array.isArray(when.conditions)) {
		const all: Predicate[] = [];
		for (const condition of when.conditions) {
			const inner = conjunction(condition);
			if (!inner) return undefined;
			all.push(...inner);
		}
		return all;
	}
	return undefined;
}

const METERS = { "text.input": "input", "text.output": "output", "text.cache_read": "cacheRead", "text.cache_write": "cacheWrite" } as const;
type Rate = (typeof METERS)[keyof typeof METERS];

/**
 * providers.dev prices as pi's `cost`: the base prices, the write price of the shortest cache lifetime (pi's own
 * convention), and one tier per context size a price changes at. Prices that depend on anything pi cannot express
 * (region, service tier, time of day) are left out. Undefined when there is no base input or output price.
 */
export function costOf(pricing: unknown): Cost | undefined {
	if (!isPlainObject(pricing) || !Array.isArray(pricing.rules)) return undefined;
	// Context size a price starts at (0: always) → cache lifetime it is for (0: any) → price.
	const prices = new Map<Rate, Map<number, Map<number, number>>>();
	for (const rule of pricing.rules) {
		if (!isPlainObject(rule) || rule.operation !== "set" || !isPlainObject(rule.unit) || rule.unit.name !== "token") continue;
		const rate = METERS[rule.meter as keyof typeof METERS];
		const amount = atLeastZero(rule.amount);
		const quantity = positive(rule.unit.quantity);
		const conditions = conjunction(rule.when);
		if (!rate || amount === undefined || quantity === undefined || !conditions) continue;
		let above = 0;
		let retention = 0;
		let expressible = true;
		for (const { field, op, value } of conditions) {
			const number = positive(value);
			if (field === "request.context_tokens" && number !== undefined && (op === "gt" || op === "gte") && above === 0) above = op === "gt" ? number : number - 1;
			else if (field === "cache.retention_s" && number !== undefined && op === "eq" && rate === "cacheWrite" && retention === 0) retention = number;
			else expressible = false;
		}
		if (!expressible) continue;
		let bySize = prices.get(rate);
		if (!bySize) prices.set(rate, (bySize = new Map()));
		let byRetention = bySize.get(above);
		if (!byRetention) bySize.set(above, (byRetention = new Map()));
		if (!byRetention.has(retention)) byRetention.set(retention, (amount * 1_000_000) / quantity);
	}
	const retentions = [...(prices.get("cacheWrite")?.values() ?? [])].flatMap((byRetention) => [...byRetention.keys()]).filter((seconds) => seconds > 0);
	const shortest = retentions.length > 0 ? Math.min(...retentions) : 0;
	const price = (rate: Rate, above: number): number | undefined => {
		const byRetention = prices.get(rate)?.get(above);
		return byRetention?.get(0) ?? (rate === "cacheWrite" ? byRetention?.get(shortest) : undefined);
	};
	const input = price("input", 0);
	const output = price("output", 0);
	if (input === undefined || output === undefined) return undefined;
	const cost: Cost = { input, output, cacheRead: price("cacheRead", 0) ?? 0, cacheWrite: price("cacheWrite", 0) ?? 0 };
	const sizes = [...new Set([...prices.values()].flatMap((bySize) => [...bySize.keys()]))].filter((above) => above > 0).sort((a, b) => a - b);
	const tiers: CostTier[] = [];
	let previous: Omit<CostTier, "inputTokensAbove"> = cost;
	for (const above of sizes) {
		const tier: CostTier = {
			inputTokensAbove: above,
			input: price("input", above) ?? previous.input,
			output: price("output", above) ?? previous.output,
			cacheRead: price("cacheRead", above) ?? previous.cacheRead,
			cacheWrite: price("cacheWrite", above) ?? previous.cacheWrite,
		};
		if (tier.input !== previous.input || tier.output !== previous.output || tier.cacheRead !== previous.cacheRead || tier.cacheWrite !== previous.cacheWrite) tiers.push(tier);
		previous = tier;
	}
	if (tiers.length > 0) cost.tiers = tiers;
	return cost;
}

/** One entry of the providers.dev API (a model at a provider and access method) as facts. */
export function factsOf(entry: unknown): Facts {
	const facts: Facts = {};
	if (!isPlainObject(entry)) return facts;
	const window = isPlainObject(entry.input_window) ? entry.input_window : undefined;
	const tokens = positive(window?.tokens);
	if (tokens !== undefined) {
		facts.window = tokens;
		if (window?.bound === "at_least") facts.windowAtLeast = true;
	}
	const maxOutput = positive(entry.max_output);
	if (maxOutput !== undefined) facts.maxOutput = maxOutput;
	const lifetime = isPlainObject(entry.cache_lifetime) ? entry.cache_lifetime : {};
	for (const tier of ["short", "long"] as const) {
		const tierData = lifetime[tier];
		const seconds = atLeastZero(isPlainObject(tierData) ? tierData.safe_s : undefined);
		if (seconds !== undefined) facts[tier] = seconds;
	}
	const cost = costOf(entry.pricing);
	if (cost) facts.cost = cost;
	return facts;
}

/** A lifetime pi can use, or undefined when there is none or evaluations found no safe one. */
export const usableLifetime = (seconds: number | undefined): number | undefined => (seconds !== undefined && seconds >= MIN_LIFETIME_SECONDS ? seconds : undefined);

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Facts for a model that one of several providers.dev entries describes, without knowing which (a proxy that does not
 * say whether a login or an API key serves a model). Where every entry has a value, the smallest is taken: a shorter
 * cache lifetime only costs an early refresh or compaction, a longer one a cache that expires unnoticed. `assumed`
 * names the fields where the entries differ, so the value is that guess. A field some entries lack is left out and
 * named in `unsure`; so are prices that differ.
 */
export function mergeFacts(found: Facts[]): { facts: Facts; unsure: Field[]; assumed: Field[] } {
	if (found.length === 0) return { facts: {}, unsure: [], assumed: [] };
	if (found.length === 1) return { facts: found[0], unsure: [], assumed: [] };
	const facts: Facts = {};
	const unsure: Field[] = [];
	const assumed: Field[] = [];
	const smallest = (field: Field, values: Array<number | undefined>): number | undefined => {
		if (!values.every((value) => value !== undefined)) {
			if (values.some((value) => value !== undefined)) unsure.push(field);
			return undefined;
		}
		const numbers = values as number[];
		if (numbers.some((value) => value !== numbers[0])) assumed.push(field);
		return Math.min(...numbers);
	};
	const window = smallest("window", found.map((one) => one.window));
	if (window !== undefined) {
		facts.window = window;
		if (found.some((one) => one.window === window && one.windowAtLeast)) facts.windowAtLeast = true;
	}
	const outputs = found.map((one) => one.maxOutput);
	if (outputs.every((tokens) => tokens !== undefined)) facts.maxOutput = Math.min(...(outputs as number[]));
	for (const tier of ["short", "long"] as const) {
		const seconds = smallest(tier, found.map((one) => one[tier]));
		if (seconds !== undefined) facts[tier] = seconds;
	}
	const costs = found.map((one) => one.cost);
	if (costs.every((cost) => cost !== undefined && same(cost, costs[0]))) facts.cost = costs[0];
	else if (costs.some((cost) => cost !== undefined)) unsure.push("price");
	return { facts, unsure, assumed };
}

export interface Lookup {
	provider: string;
	model: string;
}

/** A credential a proxy serves a model from, as CLIProxyAPI's `/v1/models?include=accounts` lists it. */
export interface ProxyAccount {
	/** CLIProxyAPI's provider name: claude, codex, meta, devin, antigravity, openai-compatible-<name> … */
	provider: string;
	/** "oauth" for a subscription login, "apikey" for an API key. */
	kind: string;
	priority: number;
}

export interface Access {
	/** The login in use is a subscription (pi marks its own OAuth logins as one or not). */
	subscription?: boolean;
	/** The provider is CLIProxyAPI. */
	proxy?: boolean;
	/** For a proxy model: the lab the proxy's model list names as its owner. */
	ownedBy?: string;
	/** For a proxy model: the credentials that serve it, in the order the proxy tries them. Absent on a proxy that does not list them. */
	accounts?: ProxyAccount[];
	/** For a proxy model: the kind of credential that answered the last request ("oauth" or "apikey"), when the proxy said. */
	servedKind?: string;
}

/** The providers.dev provider that holds a pi provider's subscription login. */
const SUBSCRIPTION_PROVIDERS: Record<string, string[]> = {
	anthropic: ["claude-subscription"],
	meta: ["meta-subscription"],
	// pi's ChatGPT login on the OpenAI API: providers.dev has no entry of its own for it, so both stay possible.
	openai: ["openai-codex", "openai"],
};

/** Which labs a proxy can serve from a subscription login as well as an API key. */
const PROXY_OWNERS: Record<string, string[]> = {
	anthropic: ["claude-subscription", "anthropic"],
	openai: ["openai-codex", "openai"],
	meta: ["meta-subscription", "meta"],
};

/** The providers.dev provider of a CLIProxyAPI credential, by its provider and kind. */
const PROXY_CREDENTIALS: Record<string, { oauth?: string; apikey?: string }> = {
	claude: { oauth: "claude-subscription", apikey: "anthropic" },
	codex: { oauth: "openai-codex", apikey: "openai" },
	meta: { oauth: "meta-subscription", apikey: "meta" },
	devin: { oauth: "devin", apikey: "devin" },
	antigravity: { oauth: "antigravity" },
	gemini: { oauth: "google", apikey: "google" },
	"openai-compatible-openrouter": { apikey: "openrouter" },
};

const providerOfAccount = (account: ProxyAccount | undefined): string | undefined =>
	account ? PROXY_CREDENTIALS[account.provider]?.[account.kind as "oauth" | "apikey"] : undefined;

/**
 * The providers.dev entries that can describe a pi model. One entry means the access method is known; several mean
 * it is one of them (see mergeFacts). Through CLIProxyAPI: `devin/…` is Devin and `lab/model` is OpenRouter. A plain
 * name is looked up under the credential the proxy tries first (or, when `servedKind` is given, the first credential
 * of that kind); a proxy that does not list its credentials leaves both the lab's subscription login and its API key.
 */
export function lookupsFor(model: { provider: string; id: string }, access: Access = {}): Lookup[] {
	if (!access.proxy) {
		const providers = (access.subscription ? SUBSCRIPTION_PROVIDERS[model.provider] : undefined) ?? [model.provider];
		return providers.map((provider) => ({ provider, model: model.id }));
	}
	const slash = model.id.indexOf("/");
	if (model.id.startsWith("devin/")) return [{ provider: "devin", model: model.id.slice("devin/".length) }];
	if (slash > 0) return [{ provider: "openrouter", model: model.id }];
	if (access.accounts && access.accounts.length > 0) {
		const account = access.servedKind ? access.accounts.find((one) => one.kind === access.servedKind) : access.accounts[0];
		const provider = providerOfAccount(account);
		return provider ? [{ provider, model: model.id }] : [];
	}
	if (!access.ownedBy) return [];
	return (PROXY_OWNERS[access.ownedBy] ?? [access.ownedBy]).map((provider) => ({ provider, model: model.id }));
}

/** How a model is reached: a subscription login ("sub"), an API key ("api"), or either (a proxy that does not say). */
export type Via = "sub" | "api" | "sub or api";

/** For a proxy model, the credential that answered, else the one the proxy tries first. */
export function accessVia(model: { provider: string; id: string }, access: Access = {}): Via {
	if (!access.proxy) return access.subscription ? "sub" : "api";
	const kind = access.servedKind ?? access.accounts?.[0]?.kind;
	if (kind) return kind === "apikey" ? "api" : "sub";
	if (model.id.startsWith("devin/")) return "sub";
	return model.id.indexOf("/") > 0 ? "api" : "sub or api";
}

export const isProxyProvider = (providerId: string, displayName?: string): boolean => providerId === PROXY_PROVIDER_ID || displayName === PROXY_PROVIDER_NAME;

export interface Found {
	facts: Facts;
	/** Fields some possible entries have and others lack, or prices that differ: left out. */
	unsure: Field[];
	/** Fields where the possible entries differ, so the smallest value is used. */
	assumed: Field[];
	/** The entries that were found, as `provider/model`. */
	refs: string[];
}

export function findFacts(lookups: Lookup[], providers: DataStore["providers"]): Found {
	const refs: string[] = [];
	const found: Facts[] = [];
	for (const lookup of lookups) {
		const facts = providers[lookup.provider]?.[lookup.model];
		if (!facts) continue;
		found.push(facts);
		refs.push(`${lookup.provider}/${lookup.model}`);
	}
	// One of the possible entries is not in the data: what the others say may not hold for it, so nothing is sure.
	if (found.length > 0 && found.length < lookups.length) found.push({});
	return { ...mergeFacts(found), refs };
}

export type FieldState = "found" | "assumed" | "unsure" | "missing";

/** What providers.dev has for each field: a value, a guess (the smallest of values that differ), values that cannot be combined, or nothing. */
export function fieldStates(found: Found): Record<Field, FieldState> {
	const { facts, unsure, assumed } = found;
	const state = (field: Field, has: boolean): FieldState => (has ? (assumed.includes(field) ? "assumed" : "found") : unsure.includes(field) ? "unsure" : "missing");
	return {
		window: state("window", facts.window !== undefined),
		short: state("short", usableLifetime(facts.short) !== undefined),
		long: state("long", usableLifetime(facts.long) !== undefined),
		price: state("price", facts.cost !== undefined),
	};
}

const FIELD_LABELS: Record<Field, string> = { window: "window", short: "cache short", long: "long", price: "price" };
const MARKS: Record<FieldState, string> = { found: "✓", assumed: "⚠", unsure: "?", missing: "✗" };

/** Painted in the warning color, at the end of the footer, when the footer shows a guess. */
export const UNKNOWN_ACCESS_WARNING = "⚠ login or API key unknown: shorter values";
/** The same, when the login is known but providers.dev has no entry of its own for it (Pi's ChatGPT login on OpenAI). */
export const NO_LOGIN_ENTRY_WARNING = "⚠ no entry for this login: shorter values";
const servedWarning = (kind: string) => `⚠ answered by ${kind === "apikey" ? "an API key" : "a login"}`;

/**
 * The footer text: "· window ✓ · cache short ✓ · long ✗ · price ✓", led by a dot that sets it apart from what the
 * footer shows before it. A guess ends it with a warning. `served` names the kind of credential that answered the
 * last request when it is not the one the values are for. `paint` colors one mark or the warning.
 */
export function formatFieldStates(
	found: Found,
	paint: (text: string, state: FieldState) => string = (text) => text,
	{ served, tier, via }: { served?: string; tier?: "short" | "long"; via?: Via } = {},
): string {
	const warnings = served ? [paint(servedWarning(served), "assumed")] : [];
	const lead = via ? [via] : [];
	if (found.refs.length === 0) return `· ${[...lead, "providers.dev: no data for this model", ...(tier ? [`cache in use: ${tier}`] : []), ...warnings].join(" · ")}`;
	const states = fieldStates(found);
	if (Object.values(states).includes("assumed")) warnings.push(paint(via === "sub" || via === "api" ? NO_LOGIN_ENTRY_WARNING : UNKNOWN_ACCESS_WARNING, "assumed"));
	const inUse = (field: Field) => (field === tier ? " (in use)" : "");
	return `· ${[...lead, ...FIELDS.map((field) => `${FIELD_LABELS[field]} ${paint(MARKS[states[field]], states[field])}${inUse(field)}`), ...warnings].join(" · ")}`;
}

/** The fields of a pi model this extension looks at. */
export interface PiModel {
	provider: string;
	id: string;
	contextWindow: number;
	maxTokens: number;
	promptCache?: { short?: number; long?: number };
	cost: { input: number; output: number };
}

/**
 * What models.json should hold for a model. `model` is the model as pi has it now, which includes what `owned` (this
 * extension's earlier values, still in place) put there.
 *
 * - Window: providers.dev's value replaces pi's. A value that is only "at least this much" can raise it, never lower it.
 * - Cache lifetimes: fill a tier pi has no lifetime for. A lifetime pi's own catalog declares matches the request pi
 *   sends, so it stays.
 * - Output limit and prices: fill them when pi has none.
 */
export function desiredOverride(model: PiModel, facts: Facts, owned: Written = {}): Written {
	const want: Written = {};
	if (facts.window !== undefined) {
		const tokens = facts.windowAtLeast ? Math.max(facts.window, owned.contextWindow ?? 0) : facts.window;
		const changes = facts.windowAtLeast ? tokens > model.contextWindow : tokens !== model.contextWindow;
		if (changes || owned.contextWindow !== undefined) want.contextWindow = tokens;
	}
	if (facts.maxOutput !== undefined && (owned.maxTokens !== undefined || !(model.maxTokens > 0))) want.maxTokens = facts.maxOutput;
	for (const tier of ["short", "long"] as const) {
		const seconds = usableLifetime(facts[tier]);
		if (seconds !== undefined && (owned.promptCache?.[tier] !== undefined || model.promptCache?.[tier] === undefined)) (want.promptCache ??= {})[tier] = seconds;
	}
	if (facts.cost && (owned.cost !== undefined || (model.cost.input === 0 && model.cost.output === 0))) want.cost = facts.cost;
	return want;
}

type Json = Record<string, unknown>;

/** The override fields of models.json this extension manages, with the parts of `promptCache` handled one by one. */
const SLOTS: Array<{ get: (o: Written) => unknown; set: (o: Json, value: unknown) => void; remove: (o: Json) => void; read: (o: Json) => unknown }> = [
	...(["contextWindow", "maxTokens", "cost"] as const).map((key) => ({
		get: (o: Written) => o[key],
		read: (o: Json) => o[key],
		set: (o: Json, value: unknown) => void (o[key] = value),
		remove: (o: Json) => void delete o[key],
	})),
	...(["short", "long"] as const).map((tier) => ({
		get: (o: Written) => o.promptCache?.[tier],
		read: (o: Json) => (isPlainObject(o.promptCache) ? o.promptCache[tier] : undefined),
		set: (o: Json, value: unknown) => {
			if (!isPlainObject(o.promptCache)) o.promptCache = {};
			(o.promptCache as Json)[tier] = value;
		},
		remove: (o: Json) => {
			if (!isPlainObject(o.promptCache)) return;
			delete o.promptCache[tier];
			if (Object.keys(o.promptCache).length === 0) delete o.promptCache;
		},
	})),
];

/** The values of `written` that are still in models.json as this extension wrote them. A changed one is the user's. */
export function ownedIn(override: unknown, written: Written | undefined): Written {
	const owned: Json = {};
	if (!written || !isPlainObject(override)) return owned;
	for (const slot of SLOTS) {
		const mine = slot.get(written);
		if (mine !== undefined && same(slot.read(override), mine)) slot.set(owned, mine);
	}
	return owned;
}

export interface OverridePlan {
	/** The new content of models.json; the object passed in is not changed. */
	file: Json;
	written: DataStore["written"];
	/** The models whose overrides changed. */
	changed: Array<{ provider: string; id: string }>;
}

/**
 * Puts the wanted values into the `modelOverrides` of models.json. `want` gives, for each of `models`, what this
 * extension should hold there; it is told which of its earlier values are still in place. A field the user set is
 * never touched. A value this extension wrote earlier and no longer wants, or wrote for a model that is not in
 * `models` any more, is removed, which brings pi's own value back.
 */
export function planOverrides(
	file: Json,
	written: DataStore["written"],
	models: Array<{ provider: string; id: string }>,
	want: (provider: string, id: string, owned: Written) => Written,
): OverridePlan {
	const next: Json = structuredClone(file);
	if (!isPlainObject(next.providers)) next.providers = {};
	const providers = next.providers as Json;
	const nextWritten: DataStore["written"] = {};
	const changed: OverridePlan["changed"] = [];
	const visit = (provider: string, id: string, wanted: ((owned: Written) => Written) | undefined) => {
		const providerNode = isPlainObject(providers[provider]) ? providers[provider] : undefined;
		const overrides = providerNode && isPlainObject(providerNode.modelOverrides) ? providerNode.modelOverrides : undefined;
		const existing = overrides && isPlainObject(overrides[id]) ? overrides[id] : undefined;
		const owned = ownedIn(existing, written[provider]?.[id]);
		const desired = wanted ? wanted(owned) : {};
		const target: Json = existing ?? {};
		const kept: Json = {};
		let touched = false;
		for (const slot of SLOTS) {
			const value = slot.get(desired);
			const current = slot.read(target);
			const mine = slot.get(owned) !== undefined;
			// Set by the user: theirs to keep.
			if (current !== undefined && !mine) continue;
			if (value === undefined) {
				if (mine) {
					slot.remove(target);
					touched = true;
				}
				continue;
			}
			if (!same(current, value)) {
				slot.set(target, value);
				touched = true;
			}
			slot.set(kept, value);
		}
		if (touched) {
			changed.push({ provider, id });
			if (!isPlainObject(providers[provider])) providers[provider] = {};
			const node = providers[provider] as Json;
			if (!isPlainObject(node.modelOverrides)) node.modelOverrides = {};
			const all = node.modelOverrides as Json;
			if (Object.keys(target).length > 0) all[id] = target;
			else delete all[id];
			if (Object.keys(all).length === 0) delete node.modelOverrides;
			if (Object.keys(node).length === 0) delete providers[provider];
		}
		if (Object.keys(kept).length > 0) (nextWritten[provider] ??= {})[id] = kept as Written;
	};
	const seen = new Set<string>();
	for (const { provider, id } of models) {
		seen.add(`${provider}\n${id}`);
		visit(provider, id, (owned) => want(provider, id, owned));
	}
	for (const [provider, ids] of Object.entries(written)) {
		for (const id of Object.keys(ids)) if (!seen.has(`${provider}\n${id}`)) visit(provider, id, undefined);
	}
	if (Object.keys(providers).length === 0 && !isPlainObject(file.providers)) delete next.providers;
	return { file: next, written: nextWritten, changed };
}

export function loadStore(): DataStore {
	try {
		const parsed: unknown = JSON.parse(readFileSync(storePath(), "utf8"));
		if (!isPlainObject(parsed) || parsed.version !== 1) return emptyStore();
		const part = (key: string) => (isPlainObject(parsed[key]) ? parsed[key] : {});
		return {
			version: 1,
			checkedAt: positive(parsed.checkedAt),
			datasetVersion: typeof parsed.datasetVersion === "string" ? parsed.datasetVersion : undefined,
			providers: part("providers") as DataStore["providers"],
			owners: part("owners") as DataStore["owners"],
			accounts: part("accounts") as DataStore["accounts"],
			written: part("written") as DataStore["written"],
		};
	} catch {
		// Missing, cut short or from another version: start again; the next refresh fills it.
		return emptyStore();
	}
}

function writeAtomic(path: string, text: string, mode?: number): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, text, mode === undefined ? undefined : { mode });
	if (mode !== undefined) chmodSync(temporary, mode);
	renameSync(temporary, path);
}

export function saveStore(store: DataStore): void {
	writeAtomic(storePath(), `${JSON.stringify(store)}\n`);
}

/** models.json as an object; `{}` when there is none. Throws when it is not plain JSON (pi allows comments in it). */
export function readModelsFile(): Json {
	const path = modelsPath();
	if (!existsSync(path)) return {};
	const text = readFileSync(path, "utf8");
	const parsed: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
	if (!isPlainObject(parsed)) throw new Error("it does not hold an object");
	return parsed;
}

/** Keeps the file's permissions: models.json can hold API keys. */
export function writeModelsFile(file: Json): void {
	const path = modelsPath();
	const mode = existsSync(path) ? statSync(path).mode & 0o777 : undefined;
	writeAtomic(path, `${JSON.stringify(file, null, 2)}\n`, mode);
}

export interface FetchResponse {
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}
export type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<FetchResponse>;

async function getJson(fetchImpl: Fetch, url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const response = await fetchImpl(url, { headers: { accept: "application/json", "user-agent": "pi-cache-keeper", ...headers }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
	if (!response.ok) throw new Error(`${url} answered ${response.status}`);
	return response.json();
}

const datasetVersionOf = (body: unknown): string | undefined => {
	const meta = isPlainObject(body) && isPlainObject(body.meta) ? body.meta : undefined;
	return typeof meta?.dataset_version === "string" ? meta.dataset_version : undefined;
};

export interface Dataset {
	datasetVersion?: string;
	providers: DataStore["providers"];
	/** False when the saved data was already this dataset, so nothing was downloaded. */
	downloaded: boolean;
}

/**
 * The facts for `providerIds` from providers.dev. One small request tells whether the dataset changed; when it did
 * not and every provider is already saved, nothing else is fetched. Throws when providers.dev cannot be read, so
 * the caller keeps what it has.
 */
export async function fetchDataset(providerIds: string[], saved: DataStore, fetchImpl: Fetch, options: { force?: boolean; signal?: AbortSignal } = {}): Promise<Dataset> {
	const datasetVersion = datasetVersionOf(await getJson(fetchImpl, `${DATA_API}/meta`, {}, options.signal));
	const complete = providerIds.every((id) => saved.providers[id] !== undefined);
	if (!options.force && complete && datasetVersion !== undefined && datasetVersion === saved.datasetVersion) {
		return { datasetVersion, providers: Object.fromEntries(providerIds.map((id) => [id, saved.providers[id]])), downloaded: false };
	}
	const providers: DataStore["providers"] = {};
	const one = async (id: string) => {
		const models: Record<string, Facts> = {};
		for (let offset: number | undefined = 0; offset !== undefined; ) {
			const body = await getJson(fetchImpl, `${DATA_API}/entries?provider=${encodeURIComponent(id)}&limit=${PAGE_SIZE}&offset=${offset}`, {}, options.signal);
			if (!isPlainObject(body) || !Array.isArray(body.data)) throw new Error(`providers.dev answered without a list for ${id}`);
			for (const entry of body.data) if (isPlainObject(entry) && typeof entry.model === "string") models[entry.model] = factsOf(entry);
			offset = positive(body.next_offset);
		}
		providers[id] = models;
	};
	// A few at a time: the list is short, and a public API deserves a light touch.
	const queue = [...providerIds];
	await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
		for (let id = queue.shift(); id !== undefined; id = queue.shift()) await one(id);
	}));
	return { datasetVersion, providers, downloaded: true };
}

export interface ProxyModels {
	/** Model id → the lab the proxy names as its owner. */
	owners: Record<string, string>;
	/** Model id → the credentials that serve it; empty when the proxy does not list them. */
	accounts: Record<string, ProxyAccount[]>;
}

/**
 * A proxy's model list (`/v1/models?include=accounts`): the lab that owns each model, and, on a CLIProxyAPI that
 * supports it, the credentials that serve it. A proxy that does not know the parameter answers the plain list.
 */
export async function fetchProxyModels(origin: string, headers: Record<string, string>, fetchImpl: Fetch, signal?: AbortSignal): Promise<ProxyModels> {
	const body = await getJson(fetchImpl, `${origin}/v1/models?include=accounts`, headers, signal);
	const owners: Record<string, string> = {};
	const accounts: Record<string, ProxyAccount[]> = {};
	if (!isPlainObject(body) || !Array.isArray(body.data)) throw new Error(`${origin}/v1/models answered without a list`);
	for (const model of body.data) {
		if (!isPlainObject(model) || typeof model.id !== "string") continue;
		if (typeof model.owned_by === "string") owners[model.id] = model.owned_by;
		if (!Array.isArray(model.accounts)) continue;
		const list: ProxyAccount[] = [];
		for (const account of model.accounts) {
			if (!isPlainObject(account) || typeof account.provider !== "string" || typeof account.kind !== "string") continue;
			list.push({ provider: account.provider, kind: account.kind, priority: typeof account.priority === "number" ? account.priority : 0 });
		}
		if (list.length > 0) accounts[model.id] = list;
	}
	return { owners, accounts };
}

const lifetimeLabel = (seconds: number): string => (seconds % 3600 === 0 ? `${seconds / 3600} h` : seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`);

/** One line for `/cache-keeper`: which entry describes the model and what it gave. */
export function describeFound(found: Found): string {
	if (found.refs.length === 0) return "no entry for this model";
	const { facts } = found;
	const parts = [
		facts.window === undefined ? undefined : `window ${facts.windowAtLeast ? "at least " : ""}${facts.window.toLocaleString("en-US")}`,
		...(["short", "long"] as const).map((tier) => (facts[tier] === undefined ? undefined : facts[tier] === 0 ? `no safe ${tier} cache lifetime` : `${tier} cache ${lifetimeLabel(facts[tier])}`)),
		facts.cost ? `price $${facts.cost.input}/$${facts.cost.output} per million` : undefined,
	].filter((part) => part !== undefined);
	const unsure = found.unsure.length > 0 ? `; not used: ${found.unsure.map((field) => FIELD_LABELS[field]).join(", ")} (it depends on whether a subscription login or an API key serves the model, which is not known)` : "";
	const assumed = found.assumed.length > 0 ? `; ${found.assumed.map((field) => FIELD_LABELS[field]).join(", ")}: the smaller of the login's and the API key's, because which one serves the model is not known` : "";
	return `${found.refs.join(" or ")}: ${parts.length > 0 ? parts.join(", ") : "nothing sure"}${assumed}${unsure}`;
}
