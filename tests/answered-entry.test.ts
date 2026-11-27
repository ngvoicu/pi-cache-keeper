import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Settings, models.json and the saved data are read from the agent directory, so it is set before the extension loads.
const dir = mkdtempSync(join(tmpdir(), "pck-entry-"));
process.env.PI_CODING_AGENT_DIR = dir;
delete process.env.PI_OFFLINE;
const settingsPath = join(dir, "settings.json");
const modelsPath = join(dir, "models.json");
const storePath = join(dir, "cache-keeper-models.json");
writeFileSync(settingsPath, JSON.stringify({ cacheKeeper: { compactBeforeExpiry: false } }));
const { default: cacheKeeper } = await import("../index.ts");
// With PCK_RELEASED set to another copy's index.ts (pi-cache-keeper 0.10.8), the twin runs below are that copy's.
const { default: releasedKeeper } = process.env.PCK_RELEASED ? await import(process.env.PCK_RELEASED) : { default: cacheKeeper };
const { describeFound, findFacts, gatewayEntryOf, loadStore, lookupsFor, parseAnsweredEvent, parseEntryEvent, parseGatewayFigures, parseUpstreamsEvent } = await import("../model-data.ts");
const fireworks = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fireworks-entries.json"), "utf8")) as { entries: Array<{ ref: string; pricing: { billing: string; rules: Array<{ meter: string; amount: number }> } }> };

const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "providers-dev-entries.json"), "utf8")) as { data: Array<{ provider: string; model: string }> };

const OPENROUTER = "openrouter/anthropic/claude-fable-5.2";
const LOGIN_ENTRY = "claude-subscription/claude-fable-5-2";

/** One entry of a gateway's figures, contract 1 (Provimux's prices-and-cache/openapi.yaml, Entry). */
function entry(options: { input?: number; output?: number; short?: number | null; long?: number | null; billing?: string; basis?: string } = {}) {
	const lifetime = (seconds: number | null | undefined) => ({
		rely_on_s: seconds ?? null,
		basis: seconds === undefined || seconds === null ? "none" : (options.basis ?? "measured"),
		date: "2026-11-17",
		safe: { seconds: seconds ?? null, basis: "measured", source: "providers.dev", date: "2026-11-17", measured_with: [] },
		documented_s: null,
		documented_status: null,
		through_provimux: [],
	});
	return {
		provider: "openrouter",
		model: "anthropic/claude-fable-5.2",
		url: "https://providers.dev/entries/openrouter/anthropic/claude-fable-5.2/",
		access: "api",
		price: {
			billing: options.billing ?? "per_use",
			reference: null,
			input: options.input ?? 10,
			output: options.output ?? 50,
			cache_read: 0.5,
			cache_write: [
				{ lifetime_s: 300, price: 12.5 },
				{ lifetime_s: 3600, price: 20 },
			],
			tiers: [{ input_tokens_above: 200_000, input: 20, output: null, cache_read: null, cache_write: null }],
			other_rates: false,
			source: "models.dev",
			date: "2026-11-26",
			sources_differ: false,
		},
		cache: { documented: "yes", retention: "supported", short: lifetime(options.short === undefined ? 300 : options.short), long: lifetime(options.long === undefined ? 3600 : options.long) },
		input_window: { tokens: 1_000_000, at_least: false, source: "models.dev", date: "2026-11-26" },
		max_output: { tokens: 128_000, at_least: false, source: "models.dev", date: "2026-11-26" },
		a_field_from_a_later_contract: { ignored: true },
	};
}
const figures = (entries: Record<string, unknown>, state = "held") => ({ contract: 1, state, dataset_version: "standin00001", generated_at: "2026-11-27T09:00:00Z", fetched_at: "2026-11-27T10:00:00Z", entries });

test("an entry of the gateway's figures as facts: window, output limit, the lifetime to rely on, the price as Pi's cost", () => {
	const read = gatewayEntryOf(entry());
	assert.deepEqual(read?.facts, {
		window: 1_000_000,
		maxOutput: 128_000,
		short: 300,
		long: 3600,
		cost: { input: 10, output: 50, cacheRead: 0.5, cacheWrite: 12.5, tiers: [{ inputTokensAbove: 200_000, input: 20, output: 50, cacheRead: 0.5, cacheWrite: 12.5 }] },
	});
	assert.deepEqual(read?.basis.short, { basis: "measured", date: "2026-11-17" });
	// Not priced per token or for comparison: no price; a lifetime with nothing to rest on: none; 0 is a value.
	const bare = gatewayEntryOf(entry({ billing: "unknown", short: null, long: 0 }));
	assert.deepEqual(bare?.facts, { window: 1_000_000, maxOutput: 128_000, long: 0 });
	assert.equal(gatewayEntryOf(entry({ basis: "a-basis-not-known" }))?.facts.short, undefined);
	// The review's case (2026-11-27): an entry of the published dataset that states no cache read price
	// (openrouter/moondream/moondream3-preview): no price, never a free cache read.
	const unstated = entry();
	(unstated.price as Record<string, unknown>).cache_read = null;
	assert.equal(gatewayEntryOf(unstated)?.facts.cost, undefined);
	assert.equal(gatewayEntryOf("junk"), undefined);
});

test("the figures: only held ones are used; their entries are keyed as reported ids are cleaned", () => {
	assert.deepEqual(Object.keys(parseGatewayFigures(figures({ [OPENROUTER]: entry(), "lab/x\u001b[2J": entry() }))!.entries), [OPENROUTER, "lab/x [2J"]);
	assert.deepEqual(parseGatewayFigures(figures({ [OPENROUTER]: entry() }, "off"))!.entries, {});
	assert.equal(parseGatewayFigures(figures({}, "none"))!.state, "none");
	assert.equal(parseGatewayFigures(undefined), undefined);
	assert.equal(parseUpstreamsEvent({ provider: "provimux", models: {} })!.figures, undefined);
	assert.equal(parseUpstreamsEvent({ provider: "provimux", models: {}, figures: figures({ [OPENROUTER]: entry() }) })!.figures!.datasetVersion, "standin00001");
});

test("what answered is read as before: an entry a report or a route carries decides nothing; the entry event names it", () => {
	const upstreams = (entryValue: unknown) => parseAnsweredEvent({ provider: "provimux", model: "m", upstreams: [{ provider: "openrouter", subscription: false, entry: entryValue, accounts: ["a.x"] }] })!.upstreams;
	for (const value of [OPENROUTER, null, undefined, "", 7]) assert.deepEqual(upstreams(value), [{ provider: "openrouter", subscription: false }]);
	assert.deepEqual(parseUpstreamsEvent({ provider: "provimux", models: { m: { upstreams: [{ provider: "anthropic", subscription: true, entry: OPENROUTER }] } } })!.models, { m: { upstreams: [{ provider: "anthropic", subscription: true }] } });
	assert.deepEqual(parseEntryEvent({ provider: "provimux", model: "m", entry: OPENROUTER, account: "a.x" }), { provider: "provimux", model: "m", entry: OPENROUTER, account: "a.x" });
	assert.deepEqual(parseEntryEvent({ provider: "provimux", model: "m", entry: null }), { provider: "provimux", model: "m", entry: null });
	assert.deepEqual(parseEntryEvent({ provider: "provimux", model: "m", entry: 7 }), { provider: "provimux", model: "m", entry: null });
});

test("a named entry is never looked up: its values are the gateway's, and none are guessed for one it lacks", () => {
	const model = { provider: "provimux", id: "claude-fable-5-2" };
	const held = parseGatewayFigures(figures({ [OPENROUTER]: entry() }))!;
	const providers = { openrouter: { "claude-fable-5-2": { short: 60, window: 1 } } };
	const named = lookupsFor(model, { upstreams: [{ provider: "openrouter", subscription: false, entry: OPENROUTER }] });
	assert.deepEqual(named, [{ provider: "openrouter", model: "anthropic/claude-fable-5.2", entry: OPENROUTER }]);
	const found = findFacts(named, providers, held);
	assert.equal(found.facts.short, 300);
	assert.deepEqual(found.refs, [OPENROUTER]);
	assert.match(describeFound(found), /^openrouter\/anthropic\/claude-fable-5\.2 \(Provimux's copy of providers\.dev's data, dataset standin0 of 2026-11-27\): window 1,000,000, short cache 5 min \(measured, 2026-11-17\), long cache 1 h \(measured, 2026-11-17\), price \$10\/\$50 per million$/);
	// Named, not held: no values, and providers.dev's data for the name is not used either.
	const missing = findFacts(lookupsFor(model, { upstreams: [{ provider: "openrouter", entry: "openrouter/unknown/model" }] }), providers, held);
	assert.deepEqual(missing.facts, {});
	assert.equal(describeFound(missing), "no data for openrouter/unknown/model (Provimux holds no providers.dev figures for it)");
	const none = findFacts(lookupsFor(model, { upstreams: [{ provider: "openrouter", entry: null }] }), providers, held);
	assert.match(describeFound(none), /^no data: Provimux has not named a providers\.dev entry for it/);
	// Without the key, as before.
	assert.equal(findFacts(lookupsFor(model, { upstreams: [{ provider: "openrouter", subscription: false }] }), providers, held).facts.short, 60);
});

// ------------------------------------------------------------------------------------------------- through the extension

interface FakeModel {
	provider: string;
	id: string;
	api: string;
	baseUrl: string;
	contextWindow: number;
	maxTokens: number;
	promptCache?: { short?: number; long?: number };
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}
const proxy = (id: string, cost = { input: 8, output: 40, cacheRead: 0.8, cacheWrite: 10 }): FakeModel => ({ provider: "provimux", id, api: "anthropic-messages", baseUrl: "http://127.0.0.1:18517", contextWindow: 200_000, maxTokens: 64_000, cost });
const catalog: FakeModel[] = [proxy("claude-fable-5-2"), proxy("opus", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), proxy("house-model", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })];

/** `branch`: the session's entries, as one branch; `sessions`: Pi's own SessionManager in its place (a real tree). */
function harness(branch: unknown[] = [], sessions?: { getBranch(): unknown[]; getEntries(): unknown[]; appendCustomEntry(type: string, data: unknown): string }, keeper: (pi: never) => void = cacheKeeper) {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<unknown>>();
	const statuses = new Map<string, string | undefined>();
	const notices: string[] = [];
	const requests: string[] = [];
	const effective = (): FakeModel[] => {
		let file: { providers?: Record<string, { modelOverrides?: Record<string, Partial<FakeModel>> }> } = {};
		try {
			file = JSON.parse(readFileSync(modelsPath, "utf8"));
		} catch {
			// None yet.
		}
		return catalog.map((model) => {
			const override = file.providers?.[model.provider]?.modelOverrides?.[model.id] ?? {};
			return { ...model, ...override, promptCache: override.promptCache ? { ...model.promptCache, ...override.promptCache } : model.promptCache, cost: { ...model.cost, ...override.cost } };
		});
	};
	let registered = effective();
	let current: FakeModel | undefined = registered[0];
	globalThis.fetch = (async (input: string) => {
		const url = String(input);
		requests.push(url);
		assert.ok(url.startsWith("https://providers.dev/"), `asked ${url}`);
		const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
		if (url === "https://providers.dev/api/v1/meta") return json({ meta: { dataset_version: "d1" }, data: {} });
		const provider = new URL(url).searchParams.get("provider");
		return json({ meta: { dataset_version: "d1" }, next_offset: null, data: fixture.data.filter((one) => one.provider === provider) });
	}) as never;
	const listeners = new Map<string, Array<(data: unknown) => void>>();
	const pi = {
		events: {
			on: (channel: string, handler: (data: unknown) => void) => {
				listeners.set(channel, [...(listeners.get(channel) ?? []), handler]);
				return () => {};
			},
			emit: (channel: string, data: unknown) => {
				for (const handler of listeners.get(channel) ?? []) handler(data);
			},
		},
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
		registerEntryRenderer: () => {},
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<unknown> }) => commands.set(name, command.handler),
		appendEntry: (customType: string, data: unknown) => (sessions ? sessions.appendCustomEntry(customType, data) : branch.push({ type: "custom", customType, data, id: `c${branch.length}`, parentId: null, timestamp: new Date().toISOString() })),
		getThinkingLevel: () => "high",
		setThinkingLevel: () => {},
		setModel: async (model: FakeModel) => {
			current = model;
			return true;
		},
	};
	keeper(pi as never);
	const ctx = {
		hasUI: true,
		mode: "print",
		cwd: dir,
		get model() {
			return current;
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
		isProjectTrusted: () => false,
		getContextUsage: () => ({ tokens: 1000 }),
		sessionManager: { getBranch: () => (sessions ? sessions.getBranch() : branch), getEntries: () => (sessions ? sessions.getEntries() : branch), getSessionId: () => "s1", getSessionFile: () => undefined },
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
			notify: (message: string) => notices.push(message),
		},
		modelRegistry: {
			getAvailable: () => registered,
			find: (provider: string, id: string) => registered.find((model) => model.provider === provider && model.id === id),
			getProviderDisplayName: (provider: string) => provider,
			isUsingOAuth: () => true,
			getProvider: () => ({ auth: { oauth: { isSubscription: false } } }),
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "proxy-key" }),
			refresh: async () => {
				registered = effective();
			},
		},
	};
	const settle = async () => {
		for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
	};
	const select = (id: string) => {
		current = registered.find((model) => model.id === id);
		handlers.get("model_select")!({}, ctx);
	};
	const note = async () => {
		notices.length = 0;
		await commands.get("cache-keeper")!("", ctx);
		return /model data from providers\.dev: (.*)/.exec(notices.at(-1)!)![1];
	};
	return { handlers, statuses, requests, ctx, settle, select, note, branch, emit: pi.events.emit, overrides: () => (existsSync(modelsPath) ? JSON.parse(readFileSync(modelsPath, "utf8")).providers : undefined) };
}

test.after(() => rmSync(dir, { recursive: true }));

// The review's case (2026-11-27): four entries of providers.dev's published dataset that share their first 64
// characters, each with its own price. The whole entry is the key; it is shortened only where it is shown.
test("the whole entry is the key: four Fireworks entries alike in their first 64 characters keep their own prices", () => {
	const entries: Record<string, unknown> = {};
	for (const row of fireworks.entries) {
		const rate = (meter: string) => row.pricing.rules.find((rule) => rule.meter === meter)!.amount;
		entries[row.ref] = { price: { billing: row.pricing.billing, input: rate("text.input"), output: rate("text.output"), cache_read: rate("text.cache_read") } };
	}
	const held = parseGatewayFigures({ state: "held", entries })!;
	assert.deepEqual(Object.keys(held.entries), fireworks.entries.map((row) => row.ref));
	for (const row of fireworks.entries) {
		const said = parseEntryEvent({ provider: "provimux", model: "flash", entry: row.ref })!;
		const found = findFacts(lookupsFor({ provider: "provimux", id: "flash" }, { upstreams: [{ provider: "fireworks", entry: said.entry }] }), {}, held);
		assert.equal(found.facts.cost?.input, row.pricing.rules.find((rule) => rule.meter === "text.input")!.amount, row.ref);
		assert.equal(found.facts.cost?.output, row.pricing.rules.find((rule) => rule.meter === "text.output")!.amount, row.ref);
		assert.deepEqual(found.refs, [row.ref]);
	}
});

// The owner's case: a name with a Claude login first and an OpenRouter key last; the login is overloaded and OpenRouter
// answers. pi-provimux tells the routes as before, with the gateway's figures, and each answer's entry just before it.
const LOGIN_ACCOUNT = "a.cccccccccccccccccccc";
const OPENROUTER_ACCOUNT = "a.dddddddddddddddddddd";
const OPUS = "claude-subscription/claude-opus-5-5";
const FABLE = "claude-fable-5-2";
const LOGIN = { provider: "anthropic", subscription: true };
const OPENROUTER_KEY = { provider: "openrouter", subscription: false };
const ROUTES_ONLY = { provider: "provimux", models: { [FABLE]: { upstreams: [LOGIN], fallbacks: [OPENROUTER_KEY] }, opus: { upstreams: [{ ...LOGIN, model: "opus" }] }, "house-model": { upstreams: [] } } };
const ROUTES = { ...ROUTES_ONLY, figures: figures({ [OPENROUTER]: entry(), [LOGIN_ENTRY]: entry({ input: 8, output: 40, short: 3600, long: 3600 }), [OPUS]: entry({ input: 4, output: 20, short: 3600, billing: "reference" }) }) };
type Bus = (channel: string, data: unknown) => void;
/** What pi-provimux tells of one answer: its entry and account (model-upstreams:answered-entry), then the answer. */
const tell = (emit: Bus, model: string, upstream: Record<string, unknown>, entryValue: string | null, account?: string) => {
	emit("model-upstreams:answered-entry", { provider: "provimux", model, entry: entryValue, ...(account ? { account } : {}) });
	emit("model-upstreams:answered", { provider: "provimux", model, upstreams: [upstream] });
};
const message = (model: string, age: number, usage: Record<string, unknown>) => ({
	type: "message",
	id: `m${Math.random()}`,
	parentId: null,
	message: { role: "assistant", provider: "provimux", model, api: "anthropic-messages", content: [{ type: "text", text: "ok" }], timestamp: Date.now() - age, stopReason: "stop", usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, ...usage } },
});
type Harness = ReturnType<typeof harness>;
/** One run of a model: what pi-provimux tells while it is out, its answer, Pi idle again. */
const run = async (h: Harness, model: string, upstream: Record<string, unknown>, ref: string | null, account: string, answer: ReturnType<typeof message>) => {
	h.handlers.get("agent_start")!({}, h.ctx);
	tell(h.emit, model, upstream, ref, account);
	h.branch.push(answer);
	h.handlers.get("message_end")!({ message: answer.message }, h.ctx);
	h.handlers.get("agent_settled")!({}, h.ctx);
	await h.settle();
	return h.statuses.get("cache-keeper")!;
};
/** The same run as pi-provimux 105.0.8 tells it: the answer alone. */
const runUnnamed = async (h: Harness, model: string, upstream: Record<string, unknown>, answer: ReturnType<typeof message>) => {
	h.handlers.get("agent_start")!({}, h.ctx);
	h.emit("model-upstreams:answered", { provider: "provimux", model, upstreams: [upstream] });
	h.branch.push(answer);
	h.handlers.get("message_end")!({ message: answer.message }, h.ctx);
	h.handlers.get("agent_settled")!({}, h.ctx);
	await h.settle();
	return h.statuses.get("cache-keeper")!;
};
const started = async (h: Harness, routes: unknown = ROUTES, reason = "startup") => {
	h.handlers.get("session_start")!({ reason }, h.ctx);
	await h.settle();
	h.emit("model-upstreams", routes);
	await h.settle();
};
const SHORT = { cacheKeeper: { cacheRetention: "short", compactBeforeExpiry: false } };
// 0.10.8 says here: "⚠ answered by openrouter (API key) · cache lifetime unknown · api $8/$40 per M · providers.dev: no data
// for this model", with no countdown (it knows no lifetime). Only the lifetimes and the price are the entry's.
const FALLBACK = /^⚠ answered by openrouter \(API key\) · short 5m · long 1h · api \$10\/\$50 per M$/;

test("after a fallback: the footer and /cache-keeper's last answer show the entry that answered; nothing else changes", async () => {
	writeFileSync(settingsPath, JSON.stringify(SHORT));
	try {
		const h = harness();
		await started(h);
		h.select(FABLE);
		const before = JSON.stringify(h.overrides() ?? null);
		assert.match(await run(h, FABLE, OPENROUTER_KEY, OPENROUTER, OPENROUTER_ACCOUNT, message(FABLE, 1000, { cacheRead: 4000 })), FALLBACK);
		assert.match(
			await h.note(),
			/^configured route: none for this model \(checked [^;]+; \/cache-keeper-refresh fetches it again\); last answer, from openrouter \(API key\): openrouter\/anthropic\/claude-fable-5\.2 \(Provimux's copy of providers\.dev's data, dataset standin0 of 2026-11-27\): window 1,000,000, short cache 5 min \(measured, 2026-11-17\), long cache 1 h \(measured, 2026-11-17\), price \$10\/\$50 per million \(from Provimux; \/provimux-refresh reads it again\)\. The footer's lifetimes and price are the last answer's\. The countdown, keep-warm and the values in \S+ are what they would be without Provimux's figures$/,
		);
		// What is registered in Pi is what it was: the figures are shown, never written.
		assert.equal(JSON.stringify(h.overrides() ?? null), before);

		// An entry the gateway holds no figures for: said, with no price and no lifetime guessed.
		assert.equal(await run(h, FABLE, OPENROUTER_KEY, "openrouter/anthropic/claude-fable-9", OPENROUTER_ACCOUNT, message(FABLE, 0, { cacheRead: 4000 })), "⚠ answered by openrouter (API key) · cache lifetime unknown · api, price unknown · providers.dev: no data for openrouter/anthropic/claude-fable-9");
		// An answer that names its account and no entry: no figure, and nothing to fetch offered after saying so.
		assert.equal(await run(h, FABLE, OPENROUTER_KEY, null, OPENROUTER_ACCOUNT, message(FABLE, 0, { cacheRead: 4000 })), "⚠ answered by openrouter (API key) · cache lifetime unknown · api, price unknown · no data: no providers.dev entry named");
		assert.match(await h.note(), /; last answer, from openrouter \(API key\): no data: Provimux has not named a providers\.dev entry for it\. The footer's/);
		h.handlers.get("session_shutdown")!({}, h.ctx);
	} finally {
		writeFileSync(settingsPath, JSON.stringify({ cacheKeeper: { compactBeforeExpiry: false } }));
	}
});

// Finding 15's other half: pi-provimux tells the figures an answer's list read brought with the routes last told. Here
// that changes what is shown, and nothing else: no saved data, no models.json, the routes as they were.
test("figures told again with the same routes: the footer is drawn again; nothing is saved or written", async () => {
	writeFileSync(settingsPath, JSON.stringify(SHORT));
	try {
		const h = harness();
		const missing = { ...ROUTES, figures: figures({ [LOGIN_ENTRY]: entry({ input: 8, output: 40, short: 3600, long: 3600 }) }) };
		await started(h, missing);
		h.select(FABLE);
		assert.equal(await run(h, FABLE, OPENROUTER_KEY, OPENROUTER, OPENROUTER_ACCOUNT, message(FABLE, 1000, { cacheRead: 4000 })), "⚠ answered by openrouter (API key) · cache lifetime unknown · api, price unknown · providers.dev: no data for openrouter/anthropic/claude-fable-5.2");
		const saved = readFileSync(storePath, "utf8");
		const written = JSON.stringify(h.overrides() ?? null);
		h.emit("model-upstreams", ROUTES);
		await h.settle();
		assert.match(h.statuses.get("cache-keeper")!, FALLBACK);
		assert.equal(readFileSync(storePath, "utf8"), saved);
		assert.equal(JSON.stringify(h.overrides() ?? null), written);
		h.handlers.get("session_shutdown")!({}, h.ctx);
	} finally {
		writeFileSync(settingsPath, JSON.stringify({ cacheKeeper: { compactBeforeExpiry: false } }));
	}
});

test("a name the owner set (opus): shown with the entry its answer names; registered in Pi as before", async () => {
	writeFileSync(settingsPath, JSON.stringify(SHORT));
	try {
		const h = harness();
		await started(h);
		h.select("opus");
		assert.match(await run(h, "opus", { ...LOGIN, model: "opus" }, OPUS, LOGIN_ACCOUNT, message("opus", 1000, { cacheRead: 4000 })), /^short 1h · long 1h · sub, counted at \$4\/\$20 per M$/);
		assert.match(await h.note(), /; last answer, from anthropic \(login\): claude-subscription\/claude-opus-5-5 \(Provimux's copy [^)]*\): window 1,000,000, short cache 1 h \(measured, 2026-11-17\), long cache 1 h \(measured, 2026-11-17\), price \$4\/\$20 per million \(the API list price; this account is not billed per token\) \(from Provimux; \/provimux-refresh reads it again\)\./);
		// Looked up as 0.10.8 looks it up (by the name: nothing), so nothing is written for it.
		assert.equal(h.overrides()?.provimux?.modelOverrides?.opus, undefined);
		h.handlers.get("session_shutdown")!({}, h.ctx);
	} finally {
		writeFileSync(settingsPath, JSON.stringify({ cacheKeeper: { compactBeforeExpiry: false } }));
	}
});

test("with model data off, the gateway's figures are not shown either", async () => {
	writeFileSync(settingsPath, JSON.stringify({ cacheKeeper: { compactBeforeExpiry: false, modelData: false } }));
	try {
		const h = harness();
		await started(h);
		h.select(FABLE);
		const status = await run(h, FABLE, OPENROUTER_KEY, OPENROUTER, OPENROUTER_ACCOUNT, message(FABLE, 1000, { cacheRead: 4000 }));
		assert.doesNotMatch(status, /short 5m|\$10\/\$50/);
		assert.match(await h.note(), /^off$/);
		h.handlers.get("session_shutdown")!({}, h.ctx);
	} finally {
		writeFileSync(settingsPath, JSON.stringify({ cacheKeeper: { compactBeforeExpiry: false } }));
	}
});

test("answers without entries (pi-provimux 105.0.8, or a gateway without figures) read exactly as before", async () => {
	rmSync(storePath, { force: true });
	const h = harness();
	await started(h, ROUTES_ONLY);
	h.select(FABLE);
	h.emit("model-upstreams:answered", { provider: "provimux", model: FABLE, upstreams: [OPENROUTER_KEY] });
	await h.settle();
	assert.match(h.statuses.get("cache-keeper")!, /^⚠ answered by openrouter \(API key\) · cache lifetime unknown · api \$8\/\$40 per M · providers\.dev: no data for this model$/);
	assert.match(await h.note(), /the last answer came from openrouter \(API key\), looked up as openrouter\/claude-fable-5-2: none for this model \(checked /);
	assert.ok(!("gateway" in loadStore()));
	assert.ok(h.branch.length === 0, "nothing is written into the session");
	h.handlers.get("session_shutdown")!({}, h.ctx);
});

// The parts of a footer that speak of time or keep-warm: all but the lifetimes, the price and the data notes.
const timeParts = (footer: string | undefined) =>
	(footer ?? "").split(" · ").filter((part) => !/^(short|long) |^cache lifetime unknown$|^(sub|api|sub or api)\b|^price unknown$|^providers\.dev: no data|^no data/.test(part));

// The reviews' history cases (2026-11-27): what is shown follows the model's own last answer on the branch you are on.
// Each step runs twice: as pi-provimux 105.0.8 tells it (no entry, no figures; with PCK_RELEASED, by 0.10.8 itself), and
// as it tells it now. What speaks of time is word for word the same; only the lifetimes and the price are the entry's.
test("the entry belongs to its answer, and time is told as before: another model and back, an answer on another model, a new answer, /tree, a 1-hour write, a resume", async () => {
	writeFileSync(settingsPath, JSON.stringify(SHORT));
	const steps = async (named: boolean) => {
		const shown: Record<string, string | undefined> = {};
		const keeper = named ? cacheKeeper : releasedKeeper;
		const routes = named ? ROUTES : ROUTES_ONLY;
		const runOn = (h: Harness, model: string, upstream: Record<string, unknown>, ref: string, account: string, answer: ReturnType<typeof message>) =>
			named ? run(h, model, upstream, ref, account, answer) : runUnnamed(h, model, upstream, answer);
		const h = harness([], undefined, keeper);
		await started(h, routes);
		h.select(FABLE);
		shown.fallback = await runOn(h, FABLE, OPENROUTER_KEY, OPENROUTER, OPENROUTER_ACCOUNT, message(FABLE, 1000, { cacheRead: 4000 }));
		shown.kept = String(h.branch.filter((entry) => (entry as { customType?: string }).customType === "cache-keeper-answered").length);
		h.select("opus");
		h.select(FABLE);
		h.handlers.get("agent_settled")!({}, h.ctx);
		shown.back = h.statuses.get("cache-keeper");
		h.select("opus");
		await runOn(h, "opus", { ...LOGIN, model: "opus" }, OPUS, LOGIN_ACCOUNT, message("opus", 0, { cacheWrite: 4000, cacheWrite1h: 4000 }));
		h.select(FABLE);
		h.handlers.get("agent_settled")!({}, h.ctx);
		shown.otherModel = h.statuses.get("cache-keeper");
		const loginAnswer = message(FABLE, 0, { cacheRead: 4000 });
		shown.login = await runOn(h, FABLE, LOGIN, LOGIN_ENTRY, LOGIN_ACCOUNT, loginAnswer);
		h.branch.splice(h.branch.indexOf(loginAnswer));
		h.handlers.get("session_tree")!({}, h.ctx);
		h.handlers.get("agent_settled")!({}, h.ctx);
		shown.tree = h.statuses.get("cache-keeper");
		h.branch.unshift(message(FABLE, 60_000, { cacheWrite: 4000, cacheWrite1h: 4000 }));
		h.handlers.get("agent_settled")!({}, h.ctx);
		shown.oneHour = h.statuses.get("cache-keeper");
		h.handlers.get("session_shutdown")!({}, h.ctx);
		// Resumed six minutes after the fallback.
		const kept = h.branch.find((one) => (one as { customType?: string }).customType === "cache-keeper-answered") as { data: { at: number } } | undefined;
		const resumedAnswer = message(FABLE, 6 * 60_000, { cacheRead: 4000 });
		const resumed = harness([resumedAnswer, ...(kept ? [{ ...kept, data: { ...kept.data, at: resumedAnswer.message.timestamp } }] : [])], undefined, keeper);
		await started(resumed, routes, "resume");
		resumed.select(FABLE);
		resumed.handlers.get("agent_settled")!({}, resumed.ctx);
		shown.resumed = resumed.statuses.get("cache-keeper");
		resumed.handlers.get("session_shutdown")!({}, resumed.ctx);
		// The provider's extension no longer gives figures (back to pi-provimux 105.0.8): a recorded entry is ignored.
		const downgraded = harness([resumedAnswer, ...(kept ? [{ ...kept, data: { ...kept.data, at: resumedAnswer.message.timestamp } }] : [])], undefined, keeper);
		await started(downgraded, ROUTES_ONLY, "resume");
		downgraded.select(FABLE);
		downgraded.handlers.get("agent_settled")!({}, downgraded.ctx);
		shown.downgraded = downgraded.statuses.get("cache-keeper");
		downgraded.handlers.get("session_shutdown")!({}, downgraded.ctx);
		return shown;
	};
	try {
		const before = await steps(false);
		const now = await steps(true);
		console.log(JSON.stringify({ before, now }, null, 1));
		for (const step of Object.keys(before)) if (step !== "kept") assert.deepEqual(timeParts(now[step]), timeParts(before[step]), step);
		assert.equal(now.kept, "1", "kept once");
		const QUIET = /^short 5m · long 1h · api \$10\/\$50 per M$/;
		assert.match(now.fallback!, FALLBACK);
		assert.match(now.back!, QUIET);
		assert.match(now.otherModel!, /^cache warm · 60m left · ⚠ countdown on another model's long tier · short 5m · long 1h · api \$10\/\$50 per M$/);
		assert.match(now.login!, /^cache warm · 60m left · ⚠ countdown on another model's long tier · short 1h · long 1h · sub, counted at \$8\/\$40 per M$/);
		assert.match(now.tree!, /^cache warm · 60m left · ⚠ countdown on another model's long tier · short 5m · long 1h · api \$10\/\$50 per M$/);
		assert.match(now.oneHour!, /^cache warm · 60m left · ⚠ countdown on another model's long tier · long 1h \(in use\) · short 5m · api \$10\/\$50 per M$/);
		assert.match(now.resumed!, QUIET);
		assert.equal(now.downgraded, before.downgraded);
	} finally {
		writeFileSync(settingsPath, JSON.stringify({ cacheKeeper: { compactBeforeExpiry: false } }));
	}
});

// The review's /tree case (2026-11-27), with Pi's own SessionManager: the answer's record is the answer's child, so with
// the answer itself selected it is not on the branch. It is found by the answer it belongs to.
test("/tree onto the answer itself: its record is found by the answer, off the branch", async () => {
	writeFileSync(settingsPath, JSON.stringify(SHORT));
	try {
		const { SessionManager } = await import("@earendil-works/pi-coding-agent");
		const sessions = SessionManager.inMemory(dir);
		const answer = message(FABLE, 1000, { cacheRead: 4000 });
		const id = sessions.appendMessage(answer.message as never);
		sessions.appendCustomEntry("cache-keeper-answered", { model: `provimux/${FABLE}`, at: answer.message.timestamp, entry: OPENROUTER, upstreams: [OPENROUTER_KEY] });
		sessions.branch(id);
		assert.deepEqual(sessions.getBranch().map((one) => one.type), ["message"]);
		const h = harness([], sessions as never);
		await started(h, ROUTES, "resume");
		h.select(FABLE);
		h.handlers.get("session_tree")!({}, h.ctx);
		h.handlers.get("agent_settled")!({}, h.ctx);
		// No report in this process (0.10.8 says no "answered by" here either): the entry's lifetimes and price.
		assert.match(h.statuses.get("cache-keeper")!, /^short 5m · long 1h · api \$10\/\$50 per M$/);
		h.handlers.get("session_shutdown")!({}, h.ctx);
	} finally {
		writeFileSync(settingsPath, JSON.stringify({ cacheKeeper: { compactBeforeExpiry: false } }));
	}
});
