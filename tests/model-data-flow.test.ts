import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Settings, models.json and the saved data are read from the agent directory, so it is set before the extension loads.
const dir = mkdtempSync(join(tmpdir(), "pck-flow-"));
process.env.PI_CODING_AGENT_DIR = dir;
delete process.env.PI_OFFLINE;
const settingsPath = join(dir, "settings.json");
const modelsPath = join(dir, "models.json");
const storePath = join(dir, "cache-keeper-models.json");
writeFileSync(settingsPath, JSON.stringify({ cacheKeeper: { compactBeforeExpiry: false } }));
const { default: cacheKeeper } = await import("../index.ts");

const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "providers-dev-entries.json"), "utf8")) as { data: Array<{ provider: string; model: string }> };

interface FakeModel {
	provider: string;
	id: string;
	baseUrl: string;
	contextWindow: number;
	maxTokens: number;
	promptCache?: { short?: number; long?: number };
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}
const priced = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 };
const free = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
// pi's models before any override, as its catalog and the proxy extension give them.
const catalog: FakeModel[] = [
	{ provider: "openai-codex", id: "gpt-6.1-sol", baseUrl: "https://chatgpt.com/backend-api", contextWindow: 500_000, maxTokens: 128_000, cost: priced },
	{ provider: "anthropic", id: "claude-opus-5-5", baseUrl: "https://api.anthropic.com", contextWindow: 1_000_000, maxTokens: 128_000, promptCache: { short: 300, long: 3600 }, cost: priced },
	{ provider: "provimux", id: "gpt-6.1-sol", baseUrl: "http://127.0.0.1:8317/backend-api/", contextWindow: 500_000, maxTokens: 128_000, cost: priced },
	{ provider: "provimux", id: "claude-opus-5-5", baseUrl: "http://127.0.0.1:8317/backend-api/", contextWindow: 1_000_000, maxTokens: 128_000, cost: priced },
	{ provider: "provimux", id: "devin/claude-opus-5-5", baseUrl: "http://127.0.0.1:8317/backend-api/", contextWindow: 1_000_000, maxTokens: 128_000, cost: free },
	{ provider: "provimux", id: "devin/swe-2", baseUrl: "http://127.0.0.1:8317/backend-api/", contextWindow: 262_000, maxTokens: 128_000, cost: free },
];

// What a proxy extension says about its models when it can't tell a login from an API key: GPT-6.1 Sol through the
// Codex login or an OpenAI key, Opus through a Claude login or key, Devin's models through Devin.
const UNSURE_ROUTES = {
	provider: "provimux",
	models: {
		"gpt-6.1-sol": { upstreams: [{ provider: "openai-codex", subscription: true }, { provider: "openai", subscription: false }] },
		"claude-opus-5-5": { upstreams: [{ provider: "anthropic" }] },
		"devin/claude-opus-5-5": { upstreams: [{ provider: "devin", model: "claude-opus-5-5", subscription: true }] },
		"devin/swe-2": { upstreams: [{ provider: "devin", model: "swe-2", subscription: true }] },
	},
};
// And when it can: the logins first, API keys when they fail.
const login = (provider: string, model?: string) => ({ provider, subscription: true, ...(model ? { model } : {}) });
const key = (provider: string) => ({ provider, subscription: false });
const SURE_ROUTES = {
	provider: "provimux",
	models: {
		"gpt-6.1-sol": { upstreams: [login("openai-codex")], fallbacks: [key("openai")] },
		"claude-opus-5-5": { upstreams: [login("anthropic")], fallbacks: [key("anthropic")] },
		"devin/claude-opus-5-5": { upstreams: [login("devin", "claude-opus-5-5")] },
		"devin/swe-2": { upstreams: [login("devin", "swe-2")] },
	},
};

function harness(options: { online?: boolean; extension?: typeof cacheKeeper } = {}) {
	const state = { online: options.online ?? true, idle: true };
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<unknown>>();
	const statuses = new Map<string, string | undefined>();
	const notices: string[] = [];
	const requests: Array<{ url: string; headers: Record<string, string> }> = [];
	const selected: string[] = [];
	const refreshed: string[][] = [];

	// What pi does with models.json: an override replaces a field, and the parts of promptCache and cost merge.
	const effective = (): FakeModel[] => {
		let file: { providers?: Record<string, { modelOverrides?: Record<string, Partial<FakeModel>> }> } = {};
		try {
			file = JSON.parse(readFileSync(modelsPath, "utf8"));
		} catch {
			// No models.json, or one pi reads and JSON.parse does not.
		}
		return catalog.map((model) => {
			const override = file.providers?.[model.provider]?.modelOverrides?.[model.id] ?? {};
			return { ...model, ...override, promptCache: override.promptCache ? { ...model.promptCache, ...override.promptCache } : model.promptCache, cost: { ...model.cost, ...override.cost } };
		});
	};
	let registered = effective();
	const branch: unknown[] = [];
	let current: FakeModel | undefined = registered.find((model) => model.provider === "provimux" && model.id === "gpt-6.1-sol");

	globalThis.fetch = (async (input: string, init: { headers: Record<string, string> }) => {
		const url = String(input);
		requests.push({ url, headers: init.headers });
		if (!state.online) throw new Error("offline");
		const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
		// This extension asks nobody but providers.dev.
		assert.ok(url.startsWith("https://providers.dev/"), `asked ${url}`);
		if (url === "https://providers.dev/api/v1/meta") return json({ meta: { dataset_version: "d1" }, data: {} });
		const provider = new URL(url).searchParams.get("provider");
		return json({ meta: { dataset_version: "d1" }, next_offset: null, data: fixture.data.filter((entry) => entry.provider === provider) });
	}) as never;

	// pi's bus between extensions: a proxy extension's events reach this one.
	const listeners = new Map<string, Array<(data: unknown) => void>>();
	const emitted: string[] = [];
	const pi = {
		events: {
			on: (channel: string, handler: (data: unknown) => void) => {
				listeners.set(channel, [...(listeners.get(channel) ?? []), handler]);
				return () => {};
			},
			emit: (channel: string, data: unknown) => {
				emitted.push(channel);
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
			selected.push(`${model.provider}/${model.id}`);
			current = model;
			return true;
		},
	};
	(options.extension ?? cacheKeeper)(pi as never);

	const ctx = {
		hasUI: true,
		mode: "print",
		cwd: dir,
		get model() {
			return current;
		},
		isIdle: () => state.idle,
		hasPendingMessages: () => false,
		isProjectTrusted: () => false,
		getContextUsage: () => ({ tokens: 1000 }),
		sessionManager: { getBranch: () => branch, getSessionId: () => "s1", getSessionFile: () => undefined },
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
			notify: (message: string) => notices.push(message),
		},
		modelRegistry: {
			getAvailable: () => registered,
			find: (provider: string, id: string) => registered.find((model) => model.provider === provider && model.id === id),
			getProviderDisplayName: (provider: string) => (provider === "provimux" ? "Provimux" : provider),
			// Every provider here is signed in to; pi marks the Claude and ChatGPT logins as subscriptions.
			isUsingOAuth: () => true,
			getProvider: (provider: string) => ({ auth: { oauth: { isSubscription: provider === "anthropic" || provider === "openai-codex" } } }),
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "proxy-key" }),
			refresh: async (options: { providers: string[]; allowNetwork: boolean }) => {
				assert.equal(options.allowNetwork, false);
				refreshed.push([...options.providers].sort());
				registered = effective();
			},
		},
	};
	const settle = async () => {
		for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
	};
	const overrides = () => (existsSync(modelsPath) ? JSON.parse(readFileSync(modelsPath, "utf8")).providers : undefined);
	// What pi does when it reads models.json again (at a restart, or when /model opens).
	const reload = () => {
		registered = effective();
	};
	// What pi does when the user picks a model.
	const select = (provider: string, id: string) => {
		current = registered.find((model) => model.provider === provider && model.id === id) ?? ({ provider, id, cost: priced, contextWindow: 1, maxTokens: 1 } as FakeModel);
		handlers.get("model_select")!({}, ctx);
	};
	return { handlers, commands, statuses, notices, requests, selected, refreshed, state, ctx, settle, overrides, reload, branch, select, emit: pi.events.emit, emitted, model: () => current };
}

test.after(() => rmSync(dir, { recursive: true }));

test("a session start fetches the data, fills models.json, reloads the models and shows what was found in the footer", async () => {
	const h = harness();
	// The proxy extension may speak before this one's session starts.
	h.emit("model-upstreams", UNSURE_ROUTES);
	h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
	assert.equal(h.statuses.get("cache-keeper"), "cache lifetime unknown · sub or api $2/$10 per M", "before any data was fetched: Pi's own values, and nothing about providers.dev");
	assert.equal(h.emitted.at(-1), "model-upstreams:request", "proxy extensions are asked where their models come from");
	await h.settle();

	// providers.dev gets no credentials, only provider names.
	const public_ = h.requests;
	assert.ok(public_.length > 1);
	for (const request of public_) assert.equal(Object.keys(request.headers).some((name) => name.toLowerCase() === "authorization"), false);
	assert.deepEqual(
		public_.map((request) => new URL(request.url).searchParams.get("provider")).filter(Boolean).sort(),
		["anthropic", "claude-subscription", "devin", "openai", "openai-codex"],
		"only the providers pi can use are asked for",
	);

	assert.deepEqual(h.overrides(), {
		// The login's window and safe lifetime.
		"openai-codex": { modelOverrides: { "gpt-6.1-sol": { contextWindow: 922_000, promptCache: { short: 300 } } } },
		provimux: {
			modelOverrides: {
				// Login or key, this proxy does not say: the window both accept, and the shorter lifetime (5 min on the
				// login, 30 min on the key); only the key has a long one, so none.
				"gpt-6.1-sol": { contextWindow: 922_000, promptCache: { short: 300 } },
				// Both keep the long tier for an hour; the short one is the key's 5 min, not the login's 1 h.
				"claude-opus-5-5": { promptCache: { short: 300, long: 3600 } },
				// Devin: one entry, so its lifetime and price are known; "999,072 accepted" does not lower a 1M window.
				"devin/claude-opus-5-5": { promptCache: { short: 300 }, cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } },
				// SWE-2 has no safe lifetime and no price; 300,499 tokens were accepted, more than the 262,000 listed.
				"devin/swe-2": { contextWindow: 300_499 },
			},
		},
		// anthropic/claude-opus-5-5: pi's own catalog already has the window and both lifetimes, so nothing is written.
	});
	assert.deepEqual(h.refreshed, [["openai-codex", "provimux"]]);
	// The session's model is selected again, so it carries the new window.
	assert.deepEqual(h.selected, ["provimux/gpt-6.1-sol"]);
	assert.equal(h.model()?.contextWindow, 922_000);
	// Login or key, not known: the shorter of the two short lifetimes (a guess), the long one only the key has (not used).
	// The model has made no request in this session, so no tier is in use: short, then long.
	assert.equal(h.statuses.get("cache-keeper"), "short 5m ⚠ · long ? · sub or api $2/$10 per M · ⚠ login or API key unknown: shorter values");
	assert.match(h.notices.join("\n"), /Model data from https:\/\/providers\.dev: 5 models updated/);
	const saved = JSON.parse(readFileSync(storePath, "utf8"));
	assert.equal(saved.datasetVersion, "d1");
	assert.deepEqual(saved.upstreams.provimux["claude-opus-5-5"], { upstreams: [{ provider: "anthropic" }] });
	assert.deepEqual(Object.keys(saved.written).sort(), ["openai-codex", "provimux"]);
});

test("the next session start asks nothing while the data is fresh; changing the model updates the footer", async () => {
	const h = harness();
	h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
	await h.settle();
	assert.deepEqual(h.requests, []);
	assert.equal(h.statuses.get("cache-keeper"), "short 5m ⚠ · long ? · sub or api $2/$10 per M · ⚠ login or API key unknown: shorter values", "the saved data is shown at once");
	h.select("openai-codex", "gpt-6.1-sol");
	assert.equal(h.statuses.get("cache-keeper"), "short 5m · long unknown · sub, counted at $2/$10 per M");
	h.select("openai-codex", "unknown-model");
	assert.equal(h.statuses.get("cache-keeper"), "cache lifetime unknown · sub, counted at $2/$10 per M · providers.dev: no data for this model");
});

test("data saved by 0.8.0 (no `reading`) is fetched again once at the next start, though fresh and of the same dataset; models.json keeps this extension's values as its own", async () => {
	const saved = JSON.parse(readFileSync(storePath, "utf8"));
	assert.equal(saved.reading, 2);
	delete saved.reading;
	writeFileSync(storePath, JSON.stringify(saved));
	const before = readFileSync(modelsPath, "utf8");

	const h = harness();
	h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
	await h.settle();
	assert.equal(h.requests[0]?.url, "https://providers.dev/api/v1/meta");
	assert.ok(h.requests.some((request) => request.url.includes("/entries?provider=openai-codex")), "the same dataset is downloaded again");
	const after = JSON.parse(readFileSync(storePath, "utf8"));
	assert.equal(after.reading, 2);
	assert.deepEqual(after.written, saved.written, "which overrides are this extension's own is kept");
	assert.equal(readFileSync(modelsPath, "utf8"), before, "the same data: models.json unchanged, no value left behind as the user's");

	// Once: the next start asks nothing.
	const next = harness();
	next.handlers.get("session_start")!({ reason: "startup" }, next.ctx);
	await next.settle();
	assert.deepEqual(next.requests, []);
});

test("/cache-keeper-refresh fetches again, keeps a value the user set, and a failed refresh keeps models.json", async () => {
	const h = harness();
	// The user sets a window by hand, and removes a lifetime this extension wrote.
	const file = JSON.parse(readFileSync(modelsPath, "utf8"));
	file.providers["openai-codex"].modelOverrides["gpt-6.1-sol"].contextWindow = 400_000;
	delete file.providers.provimux.modelOverrides["claude-opus-5-5"];
	writeFileSync(modelsPath, JSON.stringify(file));
	h.reload();
	await h.commands.get("cache-keeper-refresh")!("", h.ctx);
	assert.ok(h.requests.some((request) => request.url.includes("/entries?provider=openai-codex")), "a forced refresh downloads again");
	assert.equal(h.overrides()["openai-codex"].modelOverrides["gpt-6.1-sol"].contextWindow, 400_000, "the user's window stays");
	assert.deepEqual(h.overrides().provimux.modelOverrides["claude-opus-5-5"], { promptCache: { short: 300, long: 3600 } }, "a removed value is filled again");
	assert.match(h.notices.at(-1)!, /1 model updated in .*models\.json\nThis model: openai-codex\/gpt-6\.1-sol or openai\/gpt-6\.1-sol: window 922,000, short cache 5 min, price \$2\/\$10 per million; cache short: the smaller of the login's and the API key's/);

	const before = readFileSync(modelsPath, "utf8");
	h.state.online = false;
	await h.commands.get("cache-keeper-refresh")!("", h.ctx);
	assert.match(h.notices.at(-1)!, /could not fetch the model data from providers\.dev: offline\. The data fetched before stays in use; \/cache-keeper-refresh tries again\./);
	assert.equal(readFileSync(modelsPath, "utf8"), before);
	// The saved data stays in use, and the footer says so right away, with its age.
	assert.equal(h.statuses.get("cache-keeper"), "⚠ providers.dev refresh failed: data 1m old · short 5m ⚠ · long ? · sub or api $2/$10 per M · ⚠ login or API key unknown: shorter values");
	// A refresh that works again takes the warning away.
	h.state.online = true;
	await h.commands.get("cache-keeper-refresh")!("", h.ctx);
	assert.equal(h.statuses.get("cache-keeper"), "short 5m ⚠ · long ? · sub or api $2/$10 per M · ⚠ login or API key unknown: shorter values");

	// An argument is not taken: it is said to be ignored, and the command runs as without it.
	h.notices.length = 0;
	await h.commands.get("cache-keeper-refresh")!("now", h.ctx);
	assert.equal(h.notices[0], '/cache-keeper-refresh takes no arguments, so "now" was ignored.');
	assert.match(h.notices.at(-1)!, /^Model data from https:\/\/providers\.dev: no model's values changed in .*models\.json\nThis model: /);
	// A model providers.dev has no entry for is said in plain words.
	h.select("provimux", "no-such-model");
	await h.commands.get("cache-keeper-refresh")!("", h.ctx);
	assert.match(h.notices.at(-1)!, /\nThis model: no providers\.dev entry found for it, so Pi's own values stay in use$/);
	// /cache-keeper: the line's label names providers.dev, once.
	await h.commands.get("cache-keeper")!("", h.ctx);
	assert.match(h.notices.at(-1)!, /\nmodel data from providers\.dev: none for this model, so Pi's own values are used \(checked \d+ s ago; \/cache-keeper-refresh fetches it again\)\n/);
});

test("with modelData set to false, the values this extension wrote are taken out and the user's stay", async () => {
	const before = JSON.parse(readFileSync(modelsPath, "utf8"));
	assert.equal(before.providers["openai-codex"].modelOverrides["gpt-6.1-sol"].contextWindow, 400_000, "set by the user in the test above");
	assert.deepEqual(before.providers["openai-codex"].modelOverrides["gpt-6.1-sol"].promptCache, { short: 300 });
	writeFileSync(settingsPath, JSON.stringify({ cacheKeeper: { modelData: false } }));
	// The settings are read when the extension loads, so this is what a /reload after the edit does.
	const { default: reloaded } = await import(`../index.ts?off=${Date.now()}`);
	const h = harness({ extension: reloaded });
	h.handlers.get("session_start")!({ reason: "reload" }, h.ctx);
	await h.settle();
	assert.deepEqual(h.requests, []);
	assert.deepEqual(h.overrides(), { "openai-codex": { modelOverrides: { "gpt-6.1-sol": { contextWindow: 400_000 } } } });
	assert.deepEqual(JSON.parse(readFileSync(storePath, "utf8")).written, {});
	// Pi's own values only: no lifetime for the proxy model any more, and nothing from providers.dev.
	assert.equal(h.statuses.get("cache-keeper"), "cache lifetime unknown · sub or api $2/$10 per M");
	writeFileSync(settingsPath, JSON.stringify({ cacheKeeper: { compactBeforeExpiry: false } }));
});

test("a proxy extension that knows what serves its models: their values, fetched as soon as it says, and a warning when something else answered", async () => {
	rmSync(storePath);
	writeFileSync(modelsPath, "{}");
	const h = harness();
	h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
	await h.settle();
	// Nobody said where the proxy's models come from: nothing for them.
	assert.equal(h.overrides().provimux, undefined);
	assert.equal(h.statuses.get("cache-keeper"), "cache lifetime unknown · api $2/$10 per M · providers.dev: no data for this model");

	// Said during the session: what is new to look up is fetched, models.json follows.
	h.requests.length = 0;
	h.emit("model-upstreams", SURE_ROUTES);
	await h.settle();
	const proxy = h.overrides().provimux.modelOverrides;
	// The Claude login keeps the cache for an hour, both tiers; the Codex login has a 5-minute short lifetime.
	assert.deepEqual(proxy["claude-opus-5-5"], { promptCache: { short: 3600, long: 3600 } });
	assert.deepEqual(proxy["gpt-6.1-sol"], { contextWindow: 922_000, promptCache: { short: 300 } });
	assert.equal(h.statuses.get("cache-keeper"), "short 5m · long unknown · sub, counted at $2/$10 per M", "no guess, so no warning");
	assert.ok(h.requests.some((request) => request.url.includes("/entries?provider=openai")), "what the proxy falls back to is fetched too");
	// The same again changes nothing and asks nothing.
	h.requests.length = 0;
	h.emit("model-upstreams", JSON.parse(JSON.stringify(SURE_ROUTES)));
	await h.settle();
	assert.deepEqual(h.requests, []);

	// Opus on the proxy: the login's hour.
	h.select("provimux", "claude-opus-5-5");
	const LOGIN = "short 1h · long 1h · sub, counted at $2/$10 per M";
	assert.equal(h.statuses.get("cache-keeper"), LOGIN);
	// An answer from the login changes nothing; one from an API key (the login failed or is cooling down) is warned
	// about, and the countdown follows the key's 5 minutes.
	const answered = (upstreams: unknown[], model = "claude-opus-5-5", provider = "provimux") => h.emit("model-upstreams:answered", { provider, model, upstreams });
	answered([login("anthropic")]);
	assert.equal(h.statuses.get("cache-keeper"), LOGIN);
	answered([key("anthropic")]);
	// The values follow what answered (the key's 5-minute short cache, its price), with a warning right at the front.
	assert.equal(h.statuses.get("cache-keeper"), "⚠ answered by anthropic (API key) · short 5m · long 1h · api $2/$10 per M");
	// With Pi's short retention the key's cache lasts 5 minutes, the login's an hour.
	const retention = process.env.PI_CACHE_RETENTION;
	process.env.PI_CACHE_RETENTION = "short";
	try {
		h.notices.length = 0;
		await h.commands.get("cache-keeper")!("", h.ctx);
		assert.match(h.notices.at(-1)!, /cache: .*\(lifetime 5 min, declared by the model\)/);
		assert.match(h.notices.at(-1)!, /model data from providers\.dev: claude-subscription\/claude-opus-5-5: .*; the last answer came from anthropic \(API key\): anthropic\/claude-opus-5-5: .*short cache 5 min/);
	} finally {
		if (retention === undefined) delete process.env.PI_CACHE_RETENTION;
		else process.env.PI_CACHE_RETENTION = retention;
	}
	answered([login("anthropic")]);
	assert.equal(h.statuses.get("cache-keeper"), LOGIN);
	// Pi asks for the long tier (the default setting); the answer reports a 5-minute write.
	h.branch.push({
		type: "message",
		id: "r1",
		parentId: null,
		timestamp: "",
		message: {
			role: "assistant",
			provider: "provimux",
			model: "claude-opus-5-5",
			content: [],
			timestamp: 1,
			stopReason: "stop",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 500, cacheWrite1h: 0 },
		},
	});
	h.handlers.get("agent_settled")!({}, h.ctx);
	// No request was seen, and on this route both tiers last an hour, so the write bucket cannot tell which tier was asked
	// for: the retention in force (long) is marked. The answer is long expired in this test, so the countdown says cold.
	assert.equal(h.statuses.get("cache-keeper"), "cache cold · next message full price · long 1h (in use) · short 1h · sub, counted at $2/$10 per M");
	h.branch.length = 0;
	h.handlers.get("agent_settled")!({}, h.ctx);
	// What answered for another model does not touch this one; a new model starts without one.
	answered([key("anthropic")], "claude-opus-5-5", "anthropic");
	assert.equal(h.statuses.get("cache-keeper"), LOGIN);
	answered([key("anthropic")]);
	h.select("provimux", "claude-opus-5-5");
	assert.equal(h.statuses.get("cache-keeper"), LOGIN);
});

test("what answered, named: in the footer where it is not what the values are for, in /cache-keeper always, with the entries looked up", async () => {
	rmSync(storePath);
	writeFileSync(modelsPath, "{}");
	const h = harness();
	h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
	await h.settle();
	h.emit("model-upstreams", SURE_ROUTES);
	await h.settle();
	h.select("provimux", "claude-opus-5-5");
	const LOGIN = "short 1h · long 1h · sub, counted at $2/$10 per M";
	const answered = (upstreams: unknown[]) => h.emit("model-upstreams:answered", { provider: "provimux", model: "claude-opus-5-5", upstreams });
	const note = async () => {
		h.notices.length = 0;
		await h.commands.get("cache-keeper")!("", h.ctx);
		return /model data from providers\.dev: (.*)/.exec(h.notices.at(-1)!)![1];
	};
	// No report yet: nothing said of what answered.
	assert.doesNotMatch(await note(), /answered by|last answer/);
	// The expected route answered: named in /cache-keeper only, not in the footer.
	answered([login("anthropic")]);
	assert.equal(h.statuses.get("cache-keeper"), LOGIN);
	assert.match(await note(), /^claude-subscription\/claude-opus-5-5: [^;]*; answered by: anthropic \(login\) \(checked /);
	// A login of another service whose model has no entry: which, and which entry was looked for.
	answered([login("devin", "claude-fable-5-2")]);
	assert.match(h.statuses.get("cache-keeper")!, /^⚠ answered by devin \(login\) · /);
	assert.match(await note(), /; the last answer came from devin \(login\), looked up as devin\/claude-fable-5-2: none for this model \(/);
	// An API key, named; its entry found: its values, as before.
	answered([key("anthropic")]);
	assert.match(h.statuses.get("cache-keeper")!, /^⚠ answered by anthropic \(API key\) · /);
	assert.match(await note(), /; the last answer came from anthropic \(API key\): anthropic\/claude-opus-5-5: .*short cache 5 min/);
	// An API key of a provider not fetched: no entry, the lookup said.
	answered([key("openrouter")]);
	assert.match(h.statuses.get("cache-keeper")!, /^⚠ answered by openrouter \(API key\) · /);
	assert.match(await note(), /; the last answer came from openrouter \(API key\), looked up as openrouter\/claude-opus-5-5: none for this model \(/);
	// An id providers.dev's data does not know, its kind not given: shown as reported.
	answered([{ provider: "brand-new-gateway" }]);
	assert.match(h.statuses.get("cache-keeper")!, /^⚠ answered by brand-new-gateway · /);
	assert.match(await note(), /; the last answer came from brand-new-gateway, looked up as brand-new-gateway\/claude-opus-5-5: none for this model \(/);
	// Several upstreams: the kind alone; every entry looked up named.
	answered([login("devin", "claude-fable-5-2"), key("openrouter")]);
	assert.match(h.statuses.get("cache-keeper")!, /^⚠ answered by another account · /);
	assert.match(await note(), /; the last answer came from another account, looked up as devin\/claude-fable-5-2 or openrouter\/claude-opus-5-5: none for this model \(/);
	// An empty report names nothing: no warning, no "answered by".
	answered([]);
	assert.equal(h.statuses.get("cache-keeper"), LOGIN);
	assert.doesNotMatch(await note(), /answered by|last answer/);
	// Markup in a reported id reaches neither as markup.
	answered([{ provider: "evil\u001b[2J\nid", subscription: true }]);
	assert.match(h.statuses.get("cache-keeper")!, /^⚠ answered by evil \[2J id \(login\) · /);
	assert.doesNotMatch(await note(), /\u001b|\n/);
	// The whole of /cache-keeper, for ids that match an entry once cleaned and ids that match none: as many lines as
	// without a report, none with an unsafe character, and the model data line bounded.
	answered([]);
	const whole = async () => {
		h.notices.length = 0;
		await h.commands.get("cache-keeper")!("", h.ctx);
		return h.notices.at(-1)!;
	};
	const lines = (await whole()).split("\n").length;
	const combining = "\u0301".repeat(10_000);
	for (const [provider, entry] of [
		["\u202eanthropic\n", /the last answer came from anthropic \(API key\): anthropic\/claude-opus-5-5: /],
		["\u001banthropic", /the last answer came from anthropic \(API key\): anthropic\/claude-opus-5-5: /],
		[`anthropic${combining}`, /looked up as anthropic.{1,40}\/claude-opus-5-5: none for this model \(/],
		["anth\u202eropic\u001b[2J", /the last answer came from anth ropic \[2J \(API key\), looked up as anth ropic \[2J\/claude-opus-5-5: none for this model \(/],
	] as const) {
		answered([{ provider, subscription: false }]);
		const text = await whole();
		const shown = text.split("\n");
		assert.equal(shown.length, lines, JSON.stringify(provider).slice(0, 40));
		for (const line of shown) assert.doesNotMatch(line, /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/u, JSON.stringify(provider).slice(0, 40));
		const data = shown.find((line) => line.startsWith("model data from providers.dev: "))!;
		assert.match(data, entry);
		assert.ok(data.length < 1_000, `${data.length} code units`);
		assert.doesNotMatch(h.statuses.get("cache-keeper")!, /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/u);
	}
	// An id that is not a string: the upstream is unreadable, so the answer's route is unknown and nothing is named.
	answered([{ provider: { name: "anthropic" }, subscription: false }]);
	assert.doesNotMatch(await whole(), /answered by|last answer/);
});

test("routes said while a refresh runs: what they add is fetched when it ends, once", async () => {
	rmSync(storePath);
	writeFileSync(modelsPath, "{}");
	const h = harness();
	h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
	// The proxy extension answers the request while the first refresh is still asking providers.dev.
	h.emit("model-upstreams", SURE_ROUTES);
	await h.settle();
	await h.settle();
	const asked = h.requests.map((request) => new URL(request.url).searchParams.get("provider")).filter(Boolean);
	assert.ok(asked.includes("devin") && asked.includes("openai"), `fetched: ${asked.join(", ")}`);
	assert.deepEqual(h.overrides().provimux.modelOverrides["devin/swe-2"], { contextWindow: 300_499 });
	assert.equal(h.notices.filter((notice) => notice.startsWith("Model data from")).length, 2, "one notice per refresh");
	// Offline, a refresh that fails is not tried again and again.
	h.requests.length = 0;
	h.state.online = false;
	h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
	h.emit("model-upstreams", { provider: "provimux", models: { x: { upstreams: [{ provider: "nowhere", subscription: false }] } } });
	await h.settle();
	await h.settle();
	assert.ok(h.requests.length <= 3, `asked ${h.requests.length} times`);
});

test("nothing is fetched on its own in PI_OFFLINE mode or without a UI, and models.json with comments is left alone", async () => {
	rmSync(storePath);
	process.env.PI_OFFLINE = "1";
	const offline = harness();
	offline.handlers.get("session_start")!({ reason: "startup" }, offline.ctx);
	await offline.settle();
	assert.deepEqual(offline.requests, []);
	assert.equal(offline.statuses.get("cache-keeper"), "cache lifetime unknown · api $2/$10 per M · providers.dev: no data (PI_OFFLINE)");
	delete process.env.PI_OFFLINE;
	const print = harness();
	print.handlers.get("session_start")!({ reason: "startup" }, { ...print.ctx, hasUI: false });
	await print.settle();
	assert.deepEqual(print.requests, []);

	const commented = '{ // mine\n "providers": {} }';
	writeFileSync(modelsPath, commented);
	const h = harness();
	await h.commands.get("cache-keeper-refresh")!("", h.ctx);
	assert.match(h.notices.at(-1)!, /^pi-cache-keeper fetched and saved the model data from providers\.dev but could not put it into .*models\.json: .*models\.json is not plain JSON .* so it is left as it is\. .*models\.json keeps the values it had; the footer and \/cache-keeper use the new data\. \/cache-keeper-refresh tries again\.$/);
	assert.equal(readFileSync(modelsPath, "utf8"), commented);
});

test("providers.dev blocked from the start: the footer says so, and still shows how the model is reached", async () => {
	rmSync(storePath, { force: true });
	writeFileSync(modelsPath, "{}");
	const h = harness({ online: false });
	h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
	assert.equal(h.statuses.get("cache-keeper"), "cache lifetime unknown · api $2/$10 per M", "nothing about providers.dev while the first fetch runs");
	await h.settle();
	// Right at the front, before the values that may be missing because of it.
	assert.equal(h.statuses.get("cache-keeper"), "⚠ providers.dev: no data, fetch failed · cache lifetime unknown · api $2/$10 per M");
	assert.equal(h.notices.length, 0, "a refresh at the start fails without a notice");
	// Reachable again: the data replaces the message.
	h.state.online = true;
	await h.commands.get("cache-keeper-refresh")!("", h.ctx);
	assert.doesNotMatch(h.statuses.get("cache-keeper")!, /fetch failed|refresh failed/);
});
