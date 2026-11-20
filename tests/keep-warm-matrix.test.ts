import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";

// The keep-warm matrix: every model in pi's bundled catalog, through pi's real adapter for its API, with each cache
// retention, with and without a cache lifetime as providers.dev would supply it, and with thinking off and (where the
// model has it) on. For each combination the extension's ownership decision is taken and, where it owns the period,
// one refresh is driven up to the transport. Four rules (Rule) are asserted for every combination: never uncapped,
// never late, owned or left alone (never in between), nothing throws. The same run writes docs/keep-warm-coverage.md.
//
// The whole sweep runs with `npm test` (about 15 s). `CACHE_KEEPER_MATRIX=update npm test` writes the coverage document
// again; without it a document that differs from the sweep fails. Offline and deterministic: fetch and WebSocket throw,
// the clock is mocked, the agent folder is a temporary one.

const dir = mkdtempSync(join(tmpdir(), "pck-matrix-"));
process.env.PI_CODING_AGENT_DIR = dir;
const SETTINGS = { keepWarmMinutes: 120, compactBeforeExpiry: false, modelData: false, minContextTokens: 100_000 };
writeFileSync(join(dir, "settings.json"), JSON.stringify({ cacheKeeper: SETTINGS }));
const tracePath = join(dir, "cache-keeper.jsonl");
const { default: cacheKeeper } = await import("../index.ts");

// No request ever leaves this process.
globalThis.fetch = (async () => {
	throw new Error("no network in tests");
}) as typeof fetch;
(globalThis as Record<string, unknown>).WebSocket = class {
	constructor() {
		throw new Error("no network in tests");
	}
};

const piAi = new URL("../node_modules/@earendil-works/pi-ai/", import.meta.url);
const catalogFile = new URL("dist/models.generated.js", piAi);
const noCatalog = existsSync(catalogFile) ? false : "the installed pi-ai has no model catalog";
const PI_VERSION: string = noCatalog ? "none" : JSON.parse(readFileSync(new URL("package.json", piAi), "utf8")).version;
type CatalogModel = Record<string, unknown> & { provider: string; id: string; api: string; baseUrl: string; reasoning?: boolean; promptCache?: { short?: number; long?: number } };
const MODELS: Record<string, Record<string, CatalogModel>> = noCatalog ? {} : (await import(catalogFile.href)).MODELS;
const ALL = Object.values(MODELS).flatMap((models) => Object.values(models));

type Adapter = { streamSimple: (model: unknown, context: unknown, options: unknown) => { result: () => Promise<unknown> } };
const adapters = new Map<string, Adapter>();
for (const api of new Set(ALL.map((m) => m.api))) adapters.set(api, (await import(`@earendil-works/pi-ai/api/${api}`)) as Adapter);

// What Pi's model registry adds to a request: a credential, and the settings an API cannot do without. Fixtures, not
// credentials: Codex reads an account id out of a JWT, Azure needs a base URL (read from the environment, as in Pi).
const FAKE_JWT = ["e30", Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-fixture" } })).toString("base64url"), "sig"].join(".");
const credentials = (model: CatalogModel) => ({ apiKey: model.api === "openai-codex-responses" ? FAKE_JWT : "sk-fixture" });
process.env.AZURE_OPENAI_BASE_URL = "https://fixture.openai.azure.com/openai/v1";
const NO_TRANSPORT = "stopped at the transport: nothing is sent in tests";

/** The output limit a refresh may carry per API, as this test states it (independent of the extension's own table). */
const API_CAPS: Record<string, { keys: string[]; max: number }> = {
	"anthropic-messages": { keys: ["max_tokens"], max: 1 },
	"openai-completions": { keys: ["max_tokens", "max_completion_tokens"], max: 1 },
	"openai-responses": { keys: ["max_output_tokens"], max: 16 },
};
const LIMIT_KEYS = ["max_tokens", "max_output_tokens", "max_completion_tokens", "maxTokens", "maxOutputTokens"];

/**
 * Every cache lifetime a request states, wherever it sits, read here independently of the extension (milliseconds).
 * Anthropic's marker without a ttl states none: it counts as its documented 5 minutes, or as the hour where the answer
 * reported writing the 1-hour tier (`answeredLong`), the only proof of a longer lifetime for it.
 */
function statedLifetimes(payload: unknown, answeredLong: boolean): number[] {
	const out: number[] = [];
	const duration = (value: unknown) => {
		const match = typeof value === "string" ? /^(\d+)(s|m|h)$/.exec(value) : null;
		return match ? Number(match[1]) * { s: 1_000, m: 60_000, h: 3_600_000 }[match[2] as "s" | "m" | "h"] : undefined;
	};
	const visit = (value: unknown) => {
		if (Array.isArray(value)) value.forEach(visit);
		else if (value && typeof value === "object") {
			for (const [key, field] of Object.entries(value)) {
				if (key === "cache_control" && field && typeof field === "object" && (field as Record<string, unknown>).ttl === undefined) out.push(answeredLong ? 3_600_000 : 300_000);
				if (key === "ttl" || key === "prompt_cache_retention") {
					const ms = duration(field);
					if (ms !== undefined) out.push(ms);
				}
				visit(field);
			}
		}
	};
	visit(payload);
	return out;
}

/** The tiers a request's cache markers ask for, as a provider that reports its writes per tier would write them. */
function markerTiers(payload: unknown): Set<"short" | "long"> {
	const tiers = new Set<"short" | "long">();
	const visit = (value: unknown) => {
		if (Array.isArray(value)) value.forEach(visit);
		else if (value && typeof value === "object") {
			for (const [key, field] of Object.entries(value)) {
				if ((key === "cache_control" || key === "cachePoint") && field && typeof field === "object") tiers.add((field as Record<string, unknown>).ttl === "1h" ? "long" : "short");
				visit(field);
			}
		}
	};
	visit(payload);
	return tiers;
}
// The APIs whose adapter in pi reports the 1-hour share of a cache write (cacheWrite1h).
const REPORTS_TIER = new Set(["anthropic-messages", "bedrock-converse-stream"]);

const PROMPT = 600_000;
const ANSWER_AT = 1_000;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const user = { role: "user", content: [{ type: "text", text: "Explain the changes in detail." }], timestamp: 500 };
const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
// As Pi 1.5.2 sends it: the system prompt and the tools in a leading system message, then the conversation.
const { normalizeContext } = (await import("@earendil-works/pi-ai/utils/transcript")) as { normalizeContext: (context: unknown) => { messages: unknown[] } };
const transcript = normalizeContext({ systemPrompt: "You are pi.", messages: [user], tools }).messages;
const context = { messages: transcript };

// providers.dev's lifetimes as the extension would write them into models.json: only for a tier Pi has none for.
const DATA = { short: 300, long: 3600 };
// Two routes whose tiers do not last what the tier names suggest, written the same way (only for a tier the catalog has
// none for): one whose short tier lasts an hour, as a subscription login serves it, whose answers report the 1-hour
// write for any marker; one whose long tier lasts 30 minutes, whose answers report the bucket the markers name.
const ROUTES = {
	"short tier 1 h": { short: 3600, long: 3600, bucket: "1h" as const },
	"long tier 30 min": { short: 300, long: 1800, bucket: undefined },
};

type Retention = "short" | "long";
// The APIs whose requests the extension re-sends: on every other one a period is Pi's whatever the data, so the two
// routes above are swept on these only.
const RESENT = new Set(["anthropic-messages", "openai-completions", "openai-responses"]);
const dataOf = (data: Exclude<Data, "catalog">) => (data === "providers.dev" ? DATA : ROUTES[data]);
type Data = "catalog" | "providers.dev" | keyof typeof ROUTES;
type Thinking = "off" | "high";
interface Combo {
	model: CatalogModel;
	retention: Retention;
	data: Data;
	thinking: Thinking;
}
interface Outcome {
	key: string;
	provider: string;
	api: string;
	id: string;
	retention: Retention;
	data: Data;
	thinking: Thinking;
	owned: boolean;
	/** The lifetime of an owned period, in seconds, and where it comes from. */
	lifetime?: number;
	source?: string;
	/** Why a period is left to Pi, as /cache-keeper says it. */
	reason?: string;
	refreshed: boolean;
	/** How an owned period that sent no refresh ended. */
	ended?: string;
	violations: { rule: Rule; what: string }[];
}
type Rule = "never uncapped" | "never late" | "owned or left alone" | "nothing throws";

const comboKey = (c: { model: { provider: string; id: string; api: string }; retention: string; data: string; thinking: string }) =>
	`${c.model.provider}/${c.model.id} (${c.model.api}), ${c.retention} retention, ${c.data === "catalog" ? "Pi's catalog only" : c.data === "providers.dev" ? "with providers.dev lifetimes" : `on a route whose ${c.data}`}, thinking ${c.thinking}`;

function setRetention(retention: Retention) {
	if (retention === "long") process.env.PI_CACHE_RETENTION = "long";
	else delete process.env.PI_CACHE_RETENTION;
}

async function runCombo(combo: Combo): Promise<Outcome> {
	const violations: Outcome["violations"] = [];
	const fail = (rule: Rule, what: string) => violations.push({ rule, what });
	const outcome: Outcome = {
		key: comboKey(combo),
		provider: combo.model.provider,
		api: combo.model.api,
		id: combo.model.id,
		retention: combo.retention,
		data: combo.data,
		thinking: combo.thinking,
		owned: false,
		refreshed: false,
		violations,
	};
	mock.timers.reset();
	mock.timers.enable({ apis: ["setInterval", "Date"], now: ANSWER_AT - 500 });
	writeFileSync(tracePath, "");
	setRetention(combo.retention);
	const model: CatalogModel =
		combo.data === "catalog" ? combo.model : { ...combo.model, promptCache: { short: combo.model.promptCache?.short ?? dataOf(combo.data).short, long: combo.model.promptCache?.long ?? dataOf(combo.data).long } };
	const adapter = adapters.get(model.api) as Adapter;

	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
	const notes: string[] = [];
	cacheKeeper({
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
		registerEntryRenderer: () => {},
		events: { on: () => () => {}, emit: () => {} },
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => unknown }) => commands.set(name, command.handler),
		appendEntry: () => {},
		getThinkingLevel: () => combo.thinking,
	} as never);
	const branch: unknown[] = [];
	const state = { attempts: 0 };
	const refreshes: { at: number; payload: unknown }[] = [];
	let inflight: Promise<unknown> | undefined;
	const ctx = {
		hasUI: false,
		mode: "print",
		ui: { setStatus: () => {}, notify: (text: string) => notes.push(text), theme: { fg: (_color: string, text: string) => text } },
		cwd: dir,
		model,
		isIdle: () => true,
		hasPendingMessages: () => false,
		isProjectTrusted: () => false,
		getContextUsage: () => ({ tokens: PROMPT }),
		sessionManager: {
			getBranch: () => branch,
			getSessionId: () => "s1",
			getSessionFile: () => undefined,
			appendUsage: () => undefined,
		},
		// The extension's refresh goes through pi's real adapter for the model's API; its payload hook is the last thing
		// before the transport, which is stopped there.
		modelRegistry: {
			isUsingOAuth: () => false,
			getProvider: () => undefined,
			streamSimple: (m: CatalogModel, llmContext: unknown, options: Record<string, unknown> & { onPayload: (p: unknown) => unknown }) => {
				state.attempts++;
				const stream = adapters.get(m.api)!.streamSimple(m, llmContext, {
					...options,
					...credentials(m),
					onPayload: async (params: unknown) => {
						const out = await options.onPayload(params);
						refreshes.push({ at: Date.now(), payload: out });
						throw new Error(NO_TRANSPORT);
					},
				});
				inflight = stream.result();
				return { result: () => inflight };
			},
		},
		compact: () => {},
	};
	const emit = (event: string, payload: unknown = {}) => handlers.get(event)?.(payload, ctx);
	const decide = (action: string) => emit("cache_warming_decision", { type: "cache_warming_decision", warmCost: 0.18, missCost: 2.07, continuationProbability: 0.15, action });
	const keepWarmLine = async () => {
		notes.length = 0;
		await commands.get("cache-keeper")?.("", ctx);
		return notes.join("\n").split("\n").find((line) => line.startsWith("keep warm:")) ?? "";
	};
	const traces = () =>
		readFileSync(tracePath, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);

	try {
		// The request, as Pi sends it: the context reaches the extension, the adapter builds the payload, the extension's
		// before_provider_request may replace it, and what it returns is what goes out.
		emit("context_with_system", { type: "context_with_system", messages: transcript });
		let sent: Record<string, unknown> | undefined;
		await adapter
			.streamSimple(model, context, {
				...credentials(model),
				sessionId: "s1",
				maxRetries: 0,
				...(combo.thinking === "off" ? {} : { reasoning: combo.thinking }),
				onPayload: async (payload: Record<string, unknown>) => {
					const replaced = await emit("before_provider_request", { type: "before_provider_request", payload });
					sent = (replaced as Record<string, unknown> | undefined) ?? payload;
					throw new Error(NO_TRANSPORT);
				},
			})
			.result();
		if (!sent) throw new Error("pi's adapter built no payload");
		const captured = structuredClone(sent);

		// The answer reports a read of the cached prompt and a small write; where pi's adapter reports the 1-hour share of
		// a write, it is the share the request's markers ask for.
		mock.timers.setTime(ANSWER_AT);
		const tiers = markerTiers(sent);
		const write = 2_000;
		const routeBucket = combo.data in ROUTES ? ROUTES[combo.data as keyof typeof ROUTES].bucket : undefined;
		const write1h = REPORTS_TIER.has(model.api) ? { cacheWrite1h: routeBucket === "1h" || tiers.has("long") ? (tiers.has("short") && routeBucket !== "1h" ? write / 2 : write) : 0 } : {};
		const usage = { input: 2, output: 5, cacheRead: PROMPT - write - 2, cacheWrite: write, ...write1h, totalTokens: PROMPT + 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		const answer = { role: "assistant", content: [{ type: "text", text: "ok" }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp: ANSWER_AT };
		emit("message_end", { type: "message_end", message: answer });
		branch.push(
			{ type: "message", id: "u", parentId: null, timestamp: new Date(500).toISOString(), message: user },
			{ type: "message", id: "a", parentId: "u", timestamp: new Date(ANSWER_AT).toISOString(), message: answer },
		);
		emit("agent_settled", { type: "agent_settled" });

		// The decision: Pi's idle warming asks, to refresh and to stop.
		const onWarm = decide("warm");
		const onStop = decide("stop");
		const line = await keepWarmLine();
		const stopped = traces().find((r) => r.action === "pi-stopped");
		const owned = JSON.stringify(onWarm) === JSON.stringify({ action: "stop" });
		outcome.owned = owned;
		const stated = statedLifetimes(captured, ((usage as { cacheWrite1h?: number }).cacheWrite1h ?? 0) > 0);
		const earliest = stated.length ? Math.min(...stated) : Infinity;

		if (owned) {
			if (JSON.stringify(onStop) !== JSON.stringify({ action: "stop" })) fail("owned or left alone", `owned, but Pi's "stop" decision was answered ${JSON.stringify(onStop)}`);
			if (/left to Pi's own warming/.test(line)) fail("owned or left alone", `owned, but /cache-keeper says: ${line}`);
			const lifetime = Number(stopped?.lifetimeSeconds);
			outcome.lifetime = lifetime;
			outcome.source = String(stopped?.lifetimeSource);
			if (!(lifetime > 0)) fail("never late", "owned without a lifetime the countdown can count");
			if (lifetime * 1000 > earliest) fail("never late", `owned at ${lifetime} s, but the request states a cache lifetime of ${earliest / 1000} s`);
			// The idle hours pass: nothing happens before the warm lead (the time limit is past one lifetime), so the
			// clock jumps to 30 s before it (the countdown's skipped ticks run at that time) and then runs second by second
			// to the expiry.
			const expiresAt = ANSWER_AT + lifetime * 1000;
			const lead = Math.max(25_000, Math.floor(lifetime * 1000 * 0.05));
			mock.timers.setTime(Math.max(Date.now(), expiresAt - lead - 30_000));
			while (Date.now() < expiresAt + 2_000 && refreshes.length === 0) {
				const before = state.attempts;
				mock.timers.tick(1000);
				if (state.attempts > before) {
					await inflight?.catch(() => undefined);
					await flush();
				}
			}
			await flush();
			const refresh = refreshes[0];
			if (refresh) {
				outcome.refreshed = true;
				const out = refresh.payload as Record<string, unknown>;
				const cap = API_CAPS[model.api];
				const keys = LIMIT_KEYS.filter((key) => out && key in out);
				if (!cap) fail("never uncapped", `a refresh reached the transport on ${model.api}, an API with no proven cap`);
				else if (keys.length !== 1 || !cap.keys.includes(keys[0])) fail("never uncapped", `the refresh carries its output limit in ${JSON.stringify(keys)}, not one of ${JSON.stringify(cap.keys)}`);
				else {
					const value = out[keys[0]];
					if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > cap.max) fail("never uncapped", `the refresh asks for up to ${String(value)} output tokens (${keys[0]}), above ${cap.max}`);
					const rest = { ...out };
					const was = { ...captured };
					delete rest[keys[0]];
					delete was[keys[0]];
					try {
						assert.deepStrictEqual(rest, was);
					} catch {
						const differ = [...new Set([...Object.keys(rest), ...Object.keys(was)])].filter((k) => JSON.stringify(rest[k]) !== JSON.stringify(was[k]));
						fail("never uncapped", `the refresh differs from the captured request in ${differ.join(", ")}`);
					}
					if (!(keys[0] in captured)) fail("never uncapped", `the captured request carried no ${keys[0]}`);
				}
				if (refresh.at >= expiresAt) fail("never late", `the refresh left at ${refresh.at - ANSWER_AT} ms, at or after the period's lifetime of ${lifetime} s`);
				if (refresh.at >= ANSWER_AT + earliest) fail("never late", `the refresh left at ${refresh.at - ANSWER_AT} ms, after the request's own lifetime of ${earliest / 1000} s`);
				if (refreshes.length > 1) fail("never uncapped", `${refreshes.length} refreshes reached the transport for one expiry`);
			} else {
				// Owned or left alone, never in between: an owned period sends its refresh before the cache expires.
				const end = traces().find((r) => r.stop);
				if (end) outcome.ended = `${String(end.stop)}: ${String(end.reason)}`;
				fail("owned or left alone", `owned, but no refresh left before the cache expired${end ? ` (warming ended: ${outcome.ended})` : ""}`);
			}
		} else {
			if (onWarm !== undefined) fail("owned or left alone", `left to Pi, but Pi's "warm" decision was answered ${JSON.stringify(onWarm)}`);
			if (onStop !== undefined) fail("owned or left alone", `left to Pi, but Pi's "stop" decision was answered ${JSON.stringify(onStop)}`);
			const reason = /this session is left to Pi's own warming: (.+)$/.exec(line)?.[1]?.trim();
			outcome.reason = reason;
			if (!reason) fail("owned or left alone", `left to Pi, but /cache-keeper names no reason: ${JSON.stringify(line)}`);
			// Pi's idle hours: the countdown (where there is one) runs to its expiry; the extension sends nothing.
			const lifetime = (() => {
				const m = /lifetime (\d+(?:\.\d+)?) (s|min|h)\b/.exec(notes.join("\n"));
				return m ? Number(m[1]) * { s: 1_000, min: 60_000, h: 3_600_000 }[m[2] as "s" | "min" | "h"] : undefined;
			})();
			const until = ANSWER_AT + (lifetime ?? 300_000);
			const lead = Math.max(25_000, Math.floor((lifetime ?? 0) * 0.05));
			mock.timers.setTime(Math.max(Date.now(), until - lead - 30_000));
			while (Date.now() < until + 2_000) mock.timers.tick(1000);
			await flush();
			if (state.attempts > 0) fail("owned or left alone", `left to Pi, but the extension sent ${state.attempts} request(s)`);
		}
	} catch (error) {
		fail("nothing throws", error instanceof Error ? `${error.message}` : String(error));
	} finally {
		emit("session_shutdown", { type: "session_shutdown" });
		mock.timers.reset();
	}
	return outcome;
}

// ------------------------------------------------------------------------------------------------- the combinations

function combos(models: CatalogModel[]): Combo[] {
	return models.flatMap((model) =>
		(["short", "long"] as const).flatMap((retention) =>
			(["catalog", "providers.dev", ...(RESENT.has(model.api) ? (Object.keys(ROUTES) as (keyof typeof ROUTES)[]) : [])] as const).flatMap((data) => (model.reasoning ? (["off", "high"] as const) : (["off"] as const)).map((thinking) => ({ model, retention, data, thinking }))),
		),
	);
}

const models = [...ALL].sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
const all = combos(models);
const savedRetention = process.env.PI_CACHE_RETENTION;
const started = performance.now();
const outcomes: Outcome[] = [];
for (const combo of all) outcomes.push(await runCombo(combo));
const seconds = (performance.now() - started) / 1000;
if (savedRetention === undefined) delete process.env.PI_CACHE_RETENTION;
else process.env.PI_CACHE_RETENTION = savedRetention;
console.log(`keep-warm matrix: ${models.length} models, ${all.length} combinations, ${seconds.toFixed(1)} s`);

// ---------------------------------------------------------------------------------------------- known failures

/**
 * Combinations that break a rule today, kept here (with why) so the sweep stays green while the fix is decided
 * separately. Each entry names the combination as comboKey writes it, the rule, and what broke. Each is also a todo test
 * named "KNOWN FAILURE …", and an entry that no longer fails fails "known failures still fail", so the list stays honest.
 * Empty: with pi 1.5.2's catalog no combination breaks a rule.
 */
const KNOWN_FAILURES: { key: string; rule: Rule; what: RegExp; note: string }[] = [];

const isKnown = (o: Outcome, v: Outcome["violations"][number]) => KNOWN_FAILURES.some((k) => k.key === o.key && k.rule === v.rule && k.what.test(v.what));

for (const rule of ["never uncapped", "never late", "owned or left alone", "nothing throws"] as Rule[]) {
	test(`keep-warm matrix, ${rule}: every combination (${models.length} models of pi ${PI_VERSION}, ${all.length} combinations)`, { skip: noCatalog }, () => {
		assert.ok(all.length > 0);
		const broken = outcomes.flatMap((o) => o.violations.filter((v) => v.rule === rule && !isKnown(o, v)).map((v) => `${o.key}: ${v.what}`));
		assert.deepEqual(broken.slice(0, 40), [], `${broken.length} combinations break "${rule}"`);
	});
}
for (const known of KNOWN_FAILURES) {
	test(`KNOWN FAILURE (${known.rule}): ${known.key}`, { skip: noCatalog || !outcomes.some((o) => o.key === known.key), todo: known.note }, () => {
		const o = outcomes.find((x) => x.key === known.key)!;
		assert.ok(!o.violations.some((v) => v.rule === known.rule && known.what.test(v.what)), o.violations.map((v) => v.what).join("; "));
	});
}
test("keep-warm matrix: known failures still fail (an entry that passes is taken out of KNOWN_FAILURES)", { skip: noCatalog }, () => {
	for (const known of KNOWN_FAILURES) {
		const o = outcomes.find((x) => x.key === known.key);
		assert.ok(o, `${known.key} is a combination of the sweep`);
		assert.ok(o.violations.some((v) => v.rule === known.rule && known.what.test(v.what)), `${known.key} no longer breaks "${known.rule}"`);
	}
});

// ------------------------------------------------------------------------------------------- the coverage document

const COVERAGE = new URL("../docs/keep-warm-coverage.md", import.meta.url);
const REGENERATE = "CACHE_KEEPER_MATRIX=update npm test";

/** A reason as /cache-keeper gives it, without what differs from one model to the next. */
const reasonOf = (reason: string) =>
	reason
		.replace(/ \((?:anthropic|openai|google|mistral|bedrock|azure|pi)-[a-z-]+\)$/, "")
		.replace(/, not at \S+; declare one with modelOverrides\.promptCache$/, ", not at this base URL")
		.replace(/ \(\d+ s\) is under a minute$/, " is under a minute")
		.replace(/ with a budget of \d+ tokens\)/, ")");
/** The short label a reason has in the per-provider table. */
const SHORT: [RegExp, string][] = [
	[/^the cache lifetime is unknown$/, "no lifetime"],
	[/^this API's requests are not re-sent/, "API not re-sent"],
	[/^the request turns thinking on/, "thinking enabled"],
	[/^at this model's prices a refresh costs as much as a miss$/, "refresh costs a miss"],
	[/^the request carries a cache marker the extension does not read/, "unread marker"],
	[/^the request's cache lifetime does not match the model data$/, "stated lifetime ≠ data"],
	[/^the request states no cache lifetime .* the answer did not report a cache write, all of it in that cache, that confirms it$/, "route's lifetime unconfirmed"],
	[/^an answer of this model reports a .* cache write; the request's cache lasts /, "write ≠ request's lifetime"],
	[/^the answer reports cache writes in both tiers/, "both buckets written"],
	[/^the request carries more than one cache lifetime$/, "two lifetimes"],
	[/^the request carries no output limit/, "no output limit"],
	[/is only assumed on the provider's own API/, "assumed lifetime elsewhere"],
	[/is under a minute$/, "under a minute"],
];
const shortOf = (reason: string) => SHORT.find(([re]) => re.test(reason))?.[1] ?? reason;
const duration = (s: number) => (s % 3600 === 0 ? `${s / 3600} h` : s % 60 === 0 ? `${s / 60} min` : `${s} s`);
const main = outcomes.filter((o) => o.data === "catalog" || o.data === "providers.dev");
const SETUPS: [Retention, Data][] = [
	["short", "catalog"],
	["short", "providers.dev"],
	["long", "catalog"],
	["long", "providers.dev"],
];
const setupLabel = ([retention, data]: [Retention, Data]) => `${retention}, ${data === "catalog" ? "Pi's catalog" : "with lifetimes"}`;
const n = (x: number) => x.toLocaleString("en-US");
const sum = (list: Outcome[]) => {
	const warm = list.filter((o) => o.owned);
	const lifetimes = [...new Set(warm.map((o) => o.lifetime!))].sort((a, b) => a - b).map(duration);
	const pi = new Map<string, number>();
	for (const o of list.filter((x) => !x.owned)) pi.set(shortOf(reasonOf(o.reason ?? "")), (pi.get(shortOf(reasonOf(o.reason ?? ""))) ?? 0) + 1);
	return { warm: warm.length, lifetimes, pi: [...pi].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])) };
};

function coverageDocument(): string {
	const outcomes = main;
	const lines: string[] = [];
	const push = (...l: string[]) => lines.push(...l);
	const providers = new Set(outcomes.map((o) => o.provider));
	push(
		"# Keep-warm coverage",
		"",
		`<!-- Generated by tests/keep-warm-matrix.test.ts; do not edit. \`${REGENERATE}\` writes it again; \`npm test\` fails while it is out of date. -->`,
		"",
		`Who keeps an idle cache warm, for every model in the catalog of pi-ai ${PI_VERSION} (${n(models.length)} models of ${providers.size} providers), as the sweep in \`tests/keep-warm-matrix.test.ts\` finds it: ${n(outcomes.length)} combinations of`,
		"",
		"- cache retention `short` and `long` (`PI_CACHE_RETENTION`, as the extension sets it);",
		`- model data: Pi's catalog only, or a cache lifetime for both tiers as providers.dev would supply it (the extension writes one only for a tier the catalog has none for; the sweep uses ${DATA.short} s and ${n(DATA.long)} s, so this shows the extension's behaviour with data, not the data);`,
		"- thinking off, and `high` where the model has it.",
		"",
		"Each request is built by pi's own adapter for the model's API, with a system prompt, one tool and one user message, and passes through the extension as Pi sends it. Its answer reads the cached prompt and writes a little, reporting the 1-hour share of the write where pi's adapter reports one (Anthropic Messages, Bedrock). Keep-warm is on for 2 hours. \"Kept warm\" means the extension owns the idle period (Pi's own idle warming is told to stop) and sends one capped refresh before the cache expires; \"Pi\" means it is left to Pi's own warming and the extension sends nothing.",
		"",
		"## Totals",
		"",
		"| Retention, model data | Combinations | Kept warm (lifetimes) | Left to Pi |",
		"| --- | --- | --- | --- |",
	);
	for (const setup of SETUPS) {
		const list = outcomes.filter((o) => o.retention === setup[0] && o.data === setup[1]);
		const t = sum(list);
		push(`| ${setupLabel(setup)} | ${n(list.length)} | ${n(t.warm)} (${t.lifetimes.join(", ") || "none"}) | ${n(list.length - t.warm)} |`);
	}
	const total = sum(outcomes);
	push(`| all | ${n(outcomes.length)} | ${n(total.warm)} | ${n(outcomes.length - total.warm)} |`, "");
	push(
		"A period the extension keeps warm always sends its refresh: where the model's prices make one refresh cost at least as much as the cache miss it would avoid (a cached read priced like an uncached one, or no discount at all), the period is left to Pi (*refresh costs a miss*).",
		"",
		"## Left to Pi, by reason",
		"",
		`| Reason (as \`/cache-keeper\` says it) | ${SETUPS.map(setupLabel).join(" | ")} | All |`,
		`| --- | ${SETUPS.map(() => "---").join(" | ")} | --- |`,
	);
	const reasons = new Map<string, Outcome[]>();
	for (const o of outcomes.filter((x) => !x.owned)) reasons.set(reasonOf(o.reason ?? ""), [...(reasons.get(reasonOf(o.reason ?? "")) ?? []), o]);
	for (const [reason, list] of [...reasons].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
		const per = SETUPS.map(([r, d]) => n(list.filter((o) => o.retention === r && o.data === d).length));
		push(`| ${reason} (*${shortOf(reason)}*) | ${per.join(" | ")} | ${n(list.length)} |`);
	}
	push(
		"",
		"## Per provider and API",
		"",
		"Counted in model setups: each model once with thinking off, and once more with thinking on where it has thinking. *Warm* is kept warm by the extension, at the lifetimes given; *Pi* is left to Pi, with the reasons in the short form of the table above.",
		"",
		`| Provider | API | Models | ${SETUPS.map(setupLabel).join(" | ")} |`,
		`| --- | --- | --- | ${SETUPS.map(() => "---").join(" | ")} |`,
	);
	const groups = new Map<string, Outcome[]>();
	for (const o of outcomes) groups.set(`${o.provider}\u0000${o.api}`, [...(groups.get(`${o.provider}\u0000${o.api}`) ?? []), o]);
	for (const [group, list] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
		const [provider, api] = group.split("\u0000");
		const cells = SETUPS.map(([r, d]) => {
			const t = sum(list.filter((o) => o.retention === r && o.data === d));
			const warm = t.warm ? `warm ${t.warm} (${t.lifetimes.join(", ")})` : "";
			const pi = t.pi.length ? `Pi ${t.pi.reduce((a, [, c]) => a + c, 0)} (${t.pi.map(([label, c]) => (t.pi.length > 1 ? `${label} ${c}` : label)).join(", ")})` : "";
			return [warm, pi].filter(Boolean).join(" · ");
		});
		push(`| ${provider} | ${api} | ${new Set(list.map((o) => o.id)).size} | ${cells.join(" | ")} |`);
	}
	push("");
	routesSection(push);
	return lines.join("\n");
}

// The two routes whose tiers last otherwise than their names suggest, in a section of their own.
function routesSection(push: (...l: string[]) => number) {
	const setups: [Retention, Data][] = Object.keys(ROUTES).flatMap((route) => (["short", "long"] as const).map((r): [Retention, Data] => [r, route as Data]));
	const label = ([r, d]: [Retention, Data]) => `${r}, ${d}`;
	const extra = outcomes.filter((o) => o.data in ROUTES);
	push(
		"## Routes whose tiers last otherwise",
		"",
		`The ${n(extra.length / 2)} combinations of the three APIs the extension re-sends (\`anthropic-messages\`, \`openai-completions\`, \`openai-responses\`; on every other API a period is Pi's whatever the data) on two more routes, with the lifetimes written as providers.dev would write them (only for a tier the catalog has none for, so Pi's catalog wins where it has one): *short tier 1 h* (${ROUTES["short tier 1 h"].short} s and ${n(ROUTES["short tier 1 h"].long)} s, as a subscription login serves Claude; its answers report the 1-hour write for any marker) and *long tier 30 min* (${ROUTES["long tier 30 min"].short} s and ${n(ROUTES["long tier 30 min"].long)} s; its answers report the bucket the markers name). A request's lifetime is the one a marker states, else the route's for the tier asked; a write bucket an answer reports is evidence of a lifetime, and a period is kept warm only where it agrees.`,
		"",
		"| Retention, route | Combinations | Kept warm (lifetimes) | Left to Pi |",
		"| --- | --- | --- | --- |",
	);
	for (const setup of setups) {
		const list = extra.filter((o) => o.retention === setup[0] && o.data === setup[1]);
		const t = sum(list);
		push(`| ${label(setup)} | ${n(list.length)} | ${n(t.warm)} (${t.lifetimes.join(", ") || "none"}) | ${n(list.length - t.warm)} |`);
	}
	push("", `| API | ${setups.map(label).join(" | ")} |`, `| --- | ${setups.map(() => "---").join(" | ")} |`);
	for (const api of [...new Set(extra.map((o) => o.api))].sort()) {
		const cells = setups.map(([r, d]) => {
			const t = sum(extra.filter((o) => o.api === api && o.retention === r && o.data === d));
			const warm = t.warm ? `warm ${t.warm} (${t.lifetimes.join(", ")})` : "";
			const pi = t.pi.length ? `Pi ${t.pi.reduce((a, [, c]) => a + c, 0)} (${t.pi.map(([l, c]) => (t.pi.length > 1 ? `${l} ${c}` : l)).join(", ")})` : "";
			return [warm, pi].filter(Boolean).join(" · ");
		});
		push(`| ${api} | ${cells.join(" | ")} |`);
	}
	push("");
}

test(`the coverage document (docs/keep-warm-coverage.md) is the one this sweep writes (\`${REGENERATE}\` writes it again)`, { skip: noCatalog }, () => {
	const written = coverageDocument();
	if (process.env.CACHE_KEEPER_MATRIX === "update") writeFileSync(COVERAGE, written);
	assert.ok(existsSync(COVERAGE), `docs/keep-warm-coverage.md is missing: ${REGENERATE}`);
	assert.equal(readFileSync(COVERAGE, "utf8"), written, `docs/keep-warm-coverage.md is out of date (another pi version, or the extension changed): ${REGENERATE}`);
});

// The README's table "Which sessions it keeps warm", row by row, against the sweep.
test("the README's table of who keeps a session warm holds for the models it names, and points to the coverage document", { skip: noCatalog }, () => {
	const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
	assert.match(readme, /\[docs\/keep-warm-coverage\.md\]\(docs\/keep-warm-coverage\.md\)/);
	const where = (f: (o: Outcome) => boolean) => {
		const list = main.filter(f);
		assert.ok(list.length > 0);
		return list;
	};
	const tierLifetime = (o: Outcome) => (o.retention === "long" ? 3600 : 300);
	// Claude on the Anthropic API: 1 hour (5 minutes with short); Pi with budget-based thinking.
	for (const o of where((x) => x.provider === "anthropic")) {
		if (o.owned) assert.equal(o.lifetime, tierLifetime(o), o.key);
		else assert.match(o.reason ?? "", /^the request turns thinking on \(thinking: \{ type: "enabled" \} with a budget of \d+ tokens\)/, o.key);
	}
	// Kimi K3 on Moonshot's API: 1 hour (5 minutes with short).
	for (const o of where((x) => (x.provider === "moonshotai" || x.provider === "moonshotai-cn") && x.id.startsWith("kimi-k3"))) {
		assert.ok(o.owned, o.key);
		assert.equal(o.lifetime, tierLifetime(o), o.key);
	}
	// GPT-5.6 and later on OpenAI's own API: 30 minutes; Pi with two lifetimes (the models that get the shared prefix),
	// or a declared lifetime other than the 30 minutes the request states.
	const twoLifetimes = /^(gpt-5\.6-cyber|gpt-daybreak-)/;
	for (const o of where((x) => x.provider === "openai" && x.api === "openai-responses" && /^gpt-(5\.([6-9])|[6-9]|daybreak)/.test(x.id))) {
		if (o.retention === "long" && twoLifetimes.test(o.id)) assert.match(o.reason ?? "", /more than one cache lifetime/, o.key);
		else if (o.data === "catalog") assert.equal(o.lifetime, 1800, o.key);
		else if (o.retention === "long") assert.match(o.reason ?? "", /does not match the model data/, o.key);
		else assert.ok(o.owned, o.key);
	}
	// Codex, Google, Amazon Bedrock, Mistral and every other API: Pi.
	for (const o of where((x) => !["anthropic-messages", "openai-completions", "openai-responses"].includes(x.api))) assert.ok(!o.owned, o.key);
	// Other providers: Pi without a lifetime, unless the answer reports the tier on the Anthropic Messages API.
	for (const o of where((x) => x.data === "catalog" && !x.owned && x.api !== "anthropic-messages" && !["anthropic", "openai", "moonshotai", "moonshotai-cn"].includes(x.provider))) {
		assert.ok(o.reason, o.key);
	}
	for (const o of where((x) => x.data === "catalog" && x.owned && !["anthropic", "openai", "moonshotai", "moonshotai-cn", "radius"].includes(x.provider))) {
		assert.ok(o.api === "anthropic-messages" && o.source === "reported by the provider", `${o.key}: ${o.source}`);
	}
});
