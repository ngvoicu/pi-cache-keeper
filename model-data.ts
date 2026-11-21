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
	/** pi provider id → model id → where the model really comes from, as the extension serving it last said. */
	upstreams: Record<string, Record<string, Route>>;
	/** pi provider id → model id → what this extension wrote into models.json. */
	written: Record<string, Record<string, Written>>;
}

export const emptyStore = (): DataStore => ({ version: 1, providers: {}, upstreams: {}, written: {} });

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

 /**
 * Where a model reached through a proxy really comes from. An extension that serves models through a proxy says it with
 * the UPSTREAMS_EVENT event (see the README); this extension knows no proxy itself.
 */
export interface Upstream {
	/**
	 * The pi provider the model would come from if used directly (anthropic, openai-codex, openai, meta, openrouter …),
	 * or a providers.dev provider pi has none for (devin, antigravity).
	 */
	provider: string;
	/** The model's id there, when it differs from the proxy's. */
	model?: string;
	/** Reached with a subscription login (true) or an API key (false); absent when not known. */
	subscription?: boolean;
}

/** What may serve a proxy model: one of `upstreams` (several: not known which), else, when they fail, one of `fallbacks`. */
export interface Route {
	upstreams: Upstream[];
	fallbacks?: Upstream[];
}

/** The events: this extension asks proxy extensions where their models come from; they answer with the routes, and say what answered a request. */
export const REQUEST_EVENT = "model-upstreams:request";
export const UPSTREAMS_EVENT = "model-upstreams";
export const ANSWERED_EVENT = "model-upstreams:answered";

export interface Access {
	/** The login in use is a subscription (pi marks its own OAuth logins as one or not). */
	subscription?: boolean;
	/** For a proxy model: what may serve it, as the proxy's extension said. Empty: not known. */
	upstreams?: Upstream[];
}

/** The providers.dev provider that holds a pi provider's subscription login. */
const SUBSCRIPTION_PROVIDERS: Record<string, string[]> = {
	anthropic: ["claude-subscription"],
	meta: ["meta-subscription"],
	// pi's ChatGPT login on the OpenAI API: providers.dev has no entry of its own for it, so both stay possible.
	openai: ["openai-codex", "openai"],
};

/** The providers.dev entries for a model used directly: by subscription login, by API key, or (not known) both. */
function directLookups(provider: string, model: string, subscription: boolean | undefined): Lookup[] {
	const login = SUBSCRIPTION_PROVIDERS[provider] ?? [provider];
	const providers = subscription === true ? login : subscription === false ? [provider] : [...new Set([...login, provider])];
	return providers.map((one) => ({ provider: one, model }));
}

/**
 * The providers.dev entries that can describe a pi model. One entry means the access method is known; several mean
 * it is one of them (see mergeFacts). A proxy model is looked up where its extension says it comes from; a proxy model
 * whose source is not known has none.
 */
export function lookupsFor(model: { provider: string; id: string }, access: Access = {}): Lookup[] {
	if (!access.upstreams) return directLookups(model.provider, model.id, access.subscription === true);
	const seen = new Set<string>();
	return access.upstreams
		.flatMap((upstream) => directLookups(upstream.provider, upstream.model ?? model.id, upstream.subscription))
		.filter((lookup) => !seen.has(`${lookup.provider}\n${lookup.model}`) && seen.add(`${lookup.provider}\n${lookup.model}`));
}

/** How a model is reached: a subscription login ("sub"), an API key ("api"), or either (a proxy that does not say). */
export type Via = "sub" | "api" | "sub or api";

/** Subscription login, API key, or either (a proxy model whose sources mix them or are not known). */
export function accessVia(access: Access = {}): Via {
	if (!access.upstreams) return access.subscription ? "sub" : "api";
	const kinds = new Set(access.upstreams.map((upstream) => upstream.subscription));
	if (kinds.size !== 1 || kinds.has(undefined)) return "sub or api";
	return kinds.has(true) ? "sub" : "api";
}

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
			upstreams: part("upstreams") as DataStore["upstreams"],
			written: part("written") as DataStore["written"],
		};
	} catch {
		// Missing, cut short or from another version: start again; the next refresh fills it.
		return emptyStore();
	}
}

/** Writes a file whole: a temporary file beside it, then a rename, so a reader sees the old file or the new one. */
export function writeAtomic(path: string, text: string, mode?: number): void {
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


const parseUpstream = (value: unknown): Upstream | undefined => {
	if (!isPlainObject(value) || typeof value.provider !== "string" || !value.provider) return undefined;
	return {
		provider: value.provider,
		...(typeof value.model === "string" && value.model ? { model: value.model } : {}),
		...(typeof value.subscription === "boolean" ? { subscription: value.subscription } : {}),
	};
};

const parseUpstreams = (value: unknown): Upstream[] | undefined => {
	if (!Array.isArray(value)) return undefined;
	const list = value.map(parseUpstream);
	// One that cannot be read may still serve the model: the whole list is not known.
	return list.every((one) => one !== undefined) ? (list as Upstream[]) : [];
};

/** A proxy model's route as an event gives it; undefined when it is not one. */
export function parseRoute(value: unknown): Route | undefined {
	if (!isPlainObject(value)) return undefined;
	const upstreams = parseUpstreams(value.upstreams);
	if (!upstreams) return undefined;
	const fallbacks = parseUpstreams(value.fallbacks);
	return { upstreams, ...(fallbacks && fallbacks.length > 0 ? { fallbacks } : {}) };
}

/** The UPSTREAMS_EVENT payload: `{ provider, models: { [modelId]: Route } }`, every model of that provider. */
export function parseUpstreamsEvent(value: unknown): { provider: string; models: Record<string, Route> } | undefined {
	if (!isPlainObject(value) || typeof value.provider !== "string" || !value.provider || !isPlainObject(value.models)) return undefined;
	const models: Record<string, Route> = {};
	for (const [id, route] of Object.entries(value.models)) {
		const parsed = parseRoute(route);
		if (parsed) models[id] = parsed;
	}
	return { provider: value.provider, models };
}

/**
 * The ANSWERED_EVENT payload: `{ provider, model, upstreams }`, what served the last request to a proxy model. An empty
 * list (`upstreams: []`, or one with an upstream that can't be read) is kept: it says this answer's route is unknown.
 */
export function parseAnsweredEvent(value: unknown): { provider: string; model: string; upstreams: Upstream[] } | undefined {
	if (!isPlainObject(value) || typeof value.provider !== "string" || typeof value.model !== "string") return undefined;
	const upstreams = parseUpstreams(value.upstreams);
	return upstreams ? { provider: value.provider, model: value.model, upstreams } : undefined;
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
