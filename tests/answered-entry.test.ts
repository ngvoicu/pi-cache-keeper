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
const { describeFound, findFacts, gatewayEntryOf, loadStore, lookupsFor, parseAnsweredEvent, parseGatewayFigures, parseUpstreamsEvent } = await import("../model-data.ts");

const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "providers-dev-entries.json"), "utf8")) as { data: Array<{ provider: string; model: string }> };

const OPENROUTER = "openrouter/anthropic/claude-fable-5.2";

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

test("an upstream's entry: named, none (null), or not given; one that can't be read is none", () => {
	const upstreams = (entryValue: unknown) => parseAnsweredEvent({ provider: "provimux", model: "m", upstreams: [{ provider: "openrouter", subscription: false, entry: entryValue }] })!.upstreams;
	assert.deepEqual(upstreams(OPENROUTER), [{ provider: "openrouter", subscription: false, entry: OPENROUTER }]);
	assert.deepEqual(upstreams(null), [{ provider: "openrouter", subscription: false, entry: null }]);
	assert.deepEqual(upstreams(undefined), [{ provider: "openrouter", subscription: false }]);
	assert.deepEqual(upstreams(""), [{ provider: "openrouter", subscription: false, entry: null }]);
	assert.deepEqual(upstreams(7), [{ provider: "openrouter", subscription: false }]);
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

function harness() {
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
		appendEntry: () => {},
		getThinkingLevel: () => "high",
		setThinkingLevel: () => {},
		setModel: async (model: FakeModel) => {
			current = model;
			return true;
		},
	};
	cacheKeeper(pi as never);
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
		sessionManager: { getBranch: () => [], getSessionId: () => "s1", getSessionFile: () => undefined },
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
	return { handlers, statuses, requests, ctx, settle, select, note, emit: pi.events.emit, overrides: () => (existsSync(modelsPath) ? JSON.parse(readFileSync(modelsPath, "utf8")).providers : undefined) };
}

test.after(() => rmSync(dir, { recursive: true }));

// The owner's case: a name with a Claude login first and an OpenRouter key last; the login is overloaded and OpenRouter
// answers. The login has answered nothing yet, so its upstream names no entry: it is looked up as before.
const ROUTES = {
	provider: "provimux",
	models: {
		"claude-fable-5-2": { upstreams: [{ provider: "anthropic", subscription: true }], fallbacks: [{ provider: "openrouter", subscription: false, entry: OPENROUTER }] },
		opus: { upstreams: [{ provider: "anthropic", model: "opus", subscription: true }] } as Record<string, unknown>,
		"house-model": { upstreams: [] },
	},
	figures: figures({ [OPENROUTER]: entry() }),
};
const answered = (model: string, upstream: Record<string, unknown>) => ({ provider: "provimux", model, upstreams: [{ account: "a.ddddddddddddddddddd1", ...upstream }] });

test("after a fallback to another account: the footer and /cache-keeper show the lifetime and price of the entry that answered", async () => {
	const h = harness();
	h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
	await h.settle();
	h.emit("model-upstreams", ROUTES);
	await h.settle();
	// The named entry is not fetched from providers.dev: its values came with the routes.
	assert.ok(h.requests.every((url) => !url.includes("provider=openrouter")), h.requests.join(" "));
	assert.ok(h.requests.some((url) => url.includes("provider=claude-subscription")), h.requests.join(" "));
	h.select("claude-fable-5-2");
	assert.doesNotMatch(h.statuses.get("cache-keeper")!, /answered by/);

	h.emit("model-upstreams:answered", answered("claude-fable-5-2", { provider: "openrouter", subscription: false, entry: OPENROUTER }));
	await h.settle();
	assert.equal(h.statuses.get("cache-keeper"), "⚠ answered by openrouter (API key) · short 5m · long 1h · api $10/$50 per M");
	assert.match(await h.note(), /; the last answer came from openrouter \(API key\): openrouter\/anthropic\/claude-fable-5\.2 \(Provimux's copy of providers\.dev's data, dataset standin0 of 2026-11-27\): window 1,000,000, short cache 5 min \(measured, 2026-11-17\), long cache 1 h \(measured, 2026-11-17\), price \$10\/\$50 per million \(the values in use: checked [^;]+; \/cache-keeper-refresh fetches it again; the last answer's: from Provimux; \/provimux-refresh reads them again\)$/);

	// An entry the gateway holds no figures for: said, with no price and no lifetime guessed.
	h.emit("model-upstreams:answered", answered("claude-fable-5-2", { provider: "openrouter", subscription: false, entry: "openrouter/anthropic/claude-fable-9" }));
	await h.settle();
	assert.equal(h.statuses.get("cache-keeper"), "⚠ answered by openrouter (API key) · cache lifetime unknown · api, price unknown · providers.dev: no data for openrouter/anthropic/claude-fable-9");
	assert.match(await h.note(), /the last answer came from openrouter \(API key\): no data for openrouter\/anthropic\/claude-fable-9 \(Provimux holds no providers\.dev figures for it\)/);

	// An answer that named its account and no entry: no figures, nothing guessed from the name or the kind.
	h.emit("model-upstreams:answered", answered("claude-fable-5-2", { provider: "openrouter", subscription: false, entry: null }));
	await h.settle();
	assert.equal(h.statuses.get("cache-keeper"), "⚠ answered by openrouter (API key) · cache lifetime unknown · api, price unknown · no data: no providers.dev entry named");
});

test("a name the owner set (opus): the entry its answer names gives the values, also where its route names the same entry", async () => {
	const h = harness();
	h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
	await h.settle();
	const OPUS = "claude-subscription/claude-opus-5-5";
	h.emit("model-upstreams", {
		...ROUTES,
		models: { ...ROUTES.models, opus: { upstreams: [{ provider: "anthropic", model: "opus", subscription: true, entry: OPUS }] } },
		figures: figures({ [OPENROUTER]: entry(), [OPUS]: entry({ input: 4, output: 20, short: 3600, billing: "reference" }) }),
	});
	await h.settle();
	h.select("opus");
	h.emit("model-upstreams:answered", answered("opus", { provider: "anthropic", model: "opus", subscription: true, entry: OPUS }));
	await h.settle();
	assert.equal(h.statuses.get("cache-keeper"), "short 1h · long 1h · sub, counted at $4/$20 per M");
	assert.match(await h.note(), /^claude-subscription\/claude-opus-5-5 \(Provimux's copy [^)]*\): window 1,000,000, short cache 1 h \(measured, 2026-11-17\), long cache 1 h \(measured, 2026-11-17\), price \$4\/\$20 per million \(the API list price; this account is not billed per token\); answered by: anthropic \(login\) \(from Provimux; \/provimux-refresh reads them again\)$/);
	// models.json follows the route's entry: the gateway's window, lifetimes and price (Pi has none for "opus").
	const written = h.overrides()?.provimux?.modelOverrides?.opus;
	assert.equal(written?.contextWindow, 1_000_000);
	assert.deepEqual(written?.promptCache, { short: 3600, long: 3600 });
	assert.equal(written?.cost?.input, 4);
	// The figures are saved with the routes, for the next start.
	assert.equal(loadStore().gateway?.provimux?.entries[OPUS]?.facts.short, 3600);
});

test("with model data off, the gateway's figures are not used either", async () => {
	writeFileSync(settingsPath, JSON.stringify({ cacheKeeper: { compactBeforeExpiry: false, modelData: false } }));
	try {
		const h = harness();
		h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
		await h.settle();
		h.emit("model-upstreams", ROUTES);
		await h.settle();
		h.select("claude-fable-5-2");
		h.emit("model-upstreams:answered", answered("claude-fable-5-2", { provider: "openrouter", subscription: false, entry: OPENROUTER }));
		await h.settle();
		assert.doesNotMatch(h.statuses.get("cache-keeper") ?? "", /short 5m|\$10\/\$50/);
		assert.match(await h.note(), /^off$/);
	} finally {
		writeFileSync(settingsPath, JSON.stringify({ cacheKeeper: { compactBeforeExpiry: false } }));
	}
});

test("routes and answers without entries (pi-provimux 105.0.8, or a gateway without figures) read exactly as before", async () => {
	rmSync(storePath, { force: true });
	const h = harness();
	h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
	await h.settle();
	h.emit("model-upstreams", { provider: "provimux", models: { "claude-fable-5-2": { upstreams: [{ provider: "anthropic", subscription: true }], fallbacks: [{ provider: "openrouter", subscription: false }] } } });
	await h.settle();
	h.select("claude-fable-5-2");
	h.emit("model-upstreams:answered", { provider: "provimux", model: "claude-fable-5-2", upstreams: [{ provider: "openrouter", subscription: false }] });
	await h.settle();
	assert.match(h.statuses.get("cache-keeper")!, /^⚠ answered by openrouter \(API key\) · cache lifetime unknown · api \$8\/\$40 per M · providers\.dev: no data for this model$/);
	assert.match(await h.note(), /the last answer came from openrouter \(API key\), looked up as openrouter\/claude-fable-5-2: none for this model \(checked /);
	assert.equal(loadStore().gateway, undefined);
});
