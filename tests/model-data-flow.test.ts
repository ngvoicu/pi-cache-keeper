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
	{ provider: "cliproxyapi", id: "gpt-6.1-sol", baseUrl: "http://127.0.0.1:8317/backend-api/", contextWindow: 500_000, maxTokens: 128_000, cost: priced },
	{ provider: "cliproxyapi", id: "claude-opus-5-5", baseUrl: "http://127.0.0.1:8317/backend-api/", contextWindow: 1_000_000, maxTokens: 128_000, cost: priced },
	{ provider: "cliproxyapi", id: "devin/claude-opus-5-5", baseUrl: "http://127.0.0.1:8317/backend-api/", contextWindow: 1_000_000, maxTokens: 128_000, cost: free },
	{ provider: "cliproxyapi", id: "devin/swe-2", baseUrl: "http://127.0.0.1:8317/backend-api/", contextWindow: 262_000, maxTokens: 128_000, cost: free },
];

// The credentials a CLIProxyAPI with `include=accounts` lists: the Claude and Codex logins first, then API keys.
const PROXY_ACCOUNTS: Record<string, unknown[]> = {
	"gpt-6.1-sol": [{ provider: "codex", kind: "oauth", priority: -17 }, { provider: "codex", kind: "apikey", priority: -25 }],
	"claude-opus-5-5": [{ provider: "claude", kind: "oauth", priority: -15 }, { provider: "claude", kind: "apikey", priority: -25 }],
	"devin/claude-opus-5-5": [{ provider: "devin", kind: "oauth", priority: -20 }],
	"devin/swe-2": [{ provider: "devin", kind: "oauth", priority: -20 }],
};

function harness(options: { online?: boolean; extension?: typeof cacheKeeper; proxyAccounts?: boolean } = {}) {
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
	let current: FakeModel | undefined = registered.find((model) => model.provider === "cliproxyapi" && model.id === "gpt-6.1-sol");

	globalThis.fetch = (async (input: string, init: { headers: Record<string, string> }) => {
		const url = String(input);
		requests.push({ url, headers: init.headers });
		if (!state.online) throw new Error("offline");
		const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
		if (url.startsWith("http://127.0.0.1:8317/v1/models")) {
			const owners: Record<string, string> = { "gpt-6.1-sol": "openai", "claude-opus-5-5": "anthropic", "devin/claude-opus-5-5": "anthropic", "devin/swe-2": "cognition" };
			// A CLIProxyAPI without the parameter ignores it and answers the plain list.
			const withAccounts = options.proxyAccounts && new URL(url).searchParams.get("include") === "accounts";
			return json({ data: Object.entries(owners).map(([id, owned_by]) => ({ id, owned_by, ...(withAccounts ? { accounts: PROXY_ACCOUNTS[id] } : {}) })) });
		}
		if (url === "https://providers.dev/api/v1/meta") return json({ meta: { dataset_version: "d1" }, data: {} });
		const provider = new URL(url).searchParams.get("provider");
		return json({ meta: { dataset_version: "d1" }, next_offset: null, data: fixture.data.filter((entry) => entry.provider === provider) });
	}) as never;

	const pi = {
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
		sessionManager: { getBranch: () => [], getSessionId: () => "s1", getSessionFile: () => undefined },
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
			notify: (message: string) => notices.push(message),
		},
		modelRegistry: {
			getAvailable: () => registered,
			find: (provider: string, id: string) => registered.find((model) => model.provider === provider && model.id === id),
			getProviderDisplayName: (provider: string) => (provider === "cliproxyapi" ? "CLIProxyAPI" : provider),
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
	return { handlers, commands, statuses, notices, requests, selected, refreshed, state, ctx, settle, overrides, reload, model: () => current };
}

test.after(() => rmSync(dir, { recursive: true }));

test("a session start fetches the data, fills models.json, reloads the models and shows what was found in the footer", async () => {
	const h = harness();
	h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
	assert.equal(h.statuses.get("cache-keeper-data"), undefined, "nothing is shown before any data was fetched");
	await h.settle();

	// The proxy is asked with its own key; providers.dev gets no credentials, only provider names.
	const proxy = h.requests.find((request) => request.url.startsWith("http://127.0.0.1:8317"));
	assert.equal(proxy?.headers.authorization, "Bearer proxy-key");
	const public_ = h.requests.filter((request) => request.url.startsWith("https://providers.dev/"));
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
		cliproxyapi: {
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
	assert.deepEqual(h.refreshed, [["cliproxyapi", "openai-codex"]]);
	// The session's model is selected again, so it carries the new window.
	assert.deepEqual(h.selected, ["cliproxyapi/gpt-6.1-sol"]);
	assert.equal(h.model()?.contextWindow, 922_000);
	assert.equal(h.statuses.get("cache-keeper-data"), "· window ✓ · cache short ⚠ · long ? · price ✓ · ⚠ login or API key unknown: shorter values");
	assert.match(h.notices.join("\n"), /Model data from https:\/\/providers\.dev: 5 models updated/);
	const saved = JSON.parse(readFileSync(storePath, "utf8"));
	assert.equal(saved.datasetVersion, "d1");
	assert.deepEqual(saved.owners.cliproxyapi["claude-opus-5-5"], "anthropic");
	assert.deepEqual(Object.keys(saved.written).sort(), ["cliproxyapi", "openai-codex"]);
});

test("the next session start asks nothing while the data is fresh; changing the model updates the footer", async () => {
	const h = harness();
	h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
	await h.settle();
	assert.deepEqual(h.requests, []);
	assert.equal(h.statuses.get("cache-keeper-data"), "· window ✓ · cache short ⚠ · long ? · price ✓ · ⚠ login or API key unknown: shorter values", "the saved data is shown at once");
	h.handlers.get("model_select")!({}, { ...h.ctx, model: h.ctx.modelRegistry.find("openai-codex", "gpt-6.1-sol") });
	assert.equal(h.statuses.get("cache-keeper-data"), "· window ✓ · cache short ✓ · long ✗ · price ✓");
	h.handlers.get("model_select")!({}, { ...h.ctx, model: { provider: "openai-codex", id: "unknown-model", cost: priced, contextWindow: 1, maxTokens: 1 } });
	assert.equal(h.statuses.get("cache-keeper-data"), "· providers.dev: no data for this model");
});

test("/cache-keeper-refresh fetches again, keeps a value the user set, and a failed refresh keeps models.json", async () => {
	const h = harness();
	// The user sets a window by hand, and removes a lifetime this extension wrote.
	const file = JSON.parse(readFileSync(modelsPath, "utf8"));
	file.providers["openai-codex"].modelOverrides["gpt-6.1-sol"].contextWindow = 400_000;
	delete file.providers.cliproxyapi.modelOverrides["claude-opus-5-5"];
	writeFileSync(modelsPath, JSON.stringify(file));
	h.reload();
	await h.commands.get("cache-keeper-refresh")!("", h.ctx);
	assert.ok(h.requests.some((request) => request.url.includes("/entries?provider=openai-codex")), "a forced refresh downloads again");
	assert.equal(h.overrides()["openai-codex"].modelOverrides["gpt-6.1-sol"].contextWindow, 400_000, "the user's window stays");
	assert.deepEqual(h.overrides().cliproxyapi.modelOverrides["claude-opus-5-5"], { promptCache: { short: 300, long: 3600 } }, "a removed value is filled again");
	assert.match(h.notices.at(-1)!, /1 model updated in .*models\.json\nThis model: openai-codex\/gpt-6\.1-sol or openai\/gpt-6\.1-sol: window 922,000, short cache 5 min, price \$2\/\$10 per million; cache short: the smaller of the login's and the API key's/);

	const before = readFileSync(modelsPath, "utf8");
	h.state.online = false;
	await h.commands.get("cache-keeper-refresh")!("", h.ctx);
	assert.match(h.notices.at(-1)!, /could not refresh the model data: offline\. The saved data stays in use\./);
	assert.equal(readFileSync(modelsPath, "utf8"), before);
	assert.equal(h.statuses.get("cache-keeper-data"), "· window ✓ · cache short ⚠ · long ? · price ✓ · ⚠ login or API key unknown: shorter values");
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
	assert.equal(h.statuses.get("cache-keeper-data"), undefined);
	writeFileSync(settingsPath, JSON.stringify({ cacheKeeper: { compactBeforeExpiry: false } }));
});

test("a CLIProxyAPI that lists its credentials: the values of the one it tries first, and a warning when another kind answered", async () => {
	rmSync(storePath);
	writeFileSync(modelsPath, "{}");
	const h = harness({ proxyAccounts: true });
	await h.commands.get("cache-keeper-refresh")!("", h.ctx);
	const proxy = h.overrides().cliproxyapi.modelOverrides;
	// The Claude login keeps the cache for an hour, both tiers; the Codex login has a 5-minute short lifetime.
	assert.deepEqual(proxy["claude-opus-5-5"], { promptCache: { short: 3600, long: 3600 } });
	assert.deepEqual(proxy["gpt-6.1-sol"], { contextWindow: 922_000, promptCache: { short: 300 } });
	assert.equal(h.statuses.get("cache-keeper-data"), "· window ✓ · cache short ✓ · long ✗ · price ✓", "no guess, so no warning");
	assert.ok(
		h.requests.some((request) => request.url.includes("/entries?provider=anthropic")),
		"the API key's values are fetched too, for when a key answers",
	);

	// Opus on the proxy: the login's hour.
	const opus = h.ctx.modelRegistry.find("cliproxyapi", "claude-opus-5-5")!;
	h.handlers.get("model_select")!({}, { ...h.ctx, model: opus });
	const onOpus = { ...h.ctx, model: opus };
	assert.equal(h.statuses.get("cache-keeper-data"), "· window ✓ · cache short ✓ · long ✓ · price ✓");
	// An answer from the login changes nothing; one from an API key (the login failed or is cooling down) is warned
	// about, and the countdown follows the key's 5 minutes.
	h.handlers.get("after_provider_response")!({ status: 200, headers: { "x-cpa-auth-kind": "oauth" } }, onOpus);
	assert.equal(h.statuses.get("cache-keeper-data"), "· window ✓ · cache short ✓ · long ✓ · price ✓");
	h.handlers.get("after_provider_response")!({ status: 200, headers: { "x-cpa-auth-kind": "apikey" } }, onOpus);
	assert.equal(h.statuses.get("cache-keeper-data"), "· window ✓ · cache short ✓ · long ✓ · price ✓ · ⚠ answered by an API key");
	// With Pi's short retention the key's cache lasts 5 minutes, the login's an hour.
	const retention = process.env.PI_CACHE_RETENTION;
	process.env.PI_CACHE_RETENTION = "short";
	try {
		h.notices.length = 0;
		await h.commands.get("cache-keeper")!("", onOpus);
		assert.match(h.notices.at(-1)!, /cache: .*\(lifetime 5 min, declared by the model\)/);
		assert.match(h.notices.at(-1)!, /model data: claude-subscription\/claude-opus-5-5: .*; the last answer came from an API key: anthropic\/claude-opus-5-5: .*short cache 5 min/);
	} finally {
		process.env.PI_CACHE_RETENTION = retention;
	}
	h.handlers.get("after_provider_response")!({ status: 200, headers: { "X-CPA-Auth-Kind": "oauth" } }, onOpus);
	assert.equal(h.statuses.get("cache-keeper-data"), "· window ✓ · cache short ✓ · long ✓ · price ✓");
	// A model of another provider is not affected.
	h.handlers.get("after_provider_response")!({ status: 200, headers: { "x-cpa-auth-kind": "apikey" } }, { ...h.ctx, model: h.ctx.modelRegistry.find("anthropic", "claude-opus-5-5") });
	assert.equal(h.statuses.get("cache-keeper-data"), "· window ✓ · cache short ✓ · long ✓ · price ✓");
});

test("nothing is fetched on its own in PI_OFFLINE mode or without a UI, and models.json with comments is left alone", async () => {
	rmSync(storePath);
	process.env.PI_OFFLINE = "1";
	const offline = harness();
	offline.handlers.get("session_start")!({ reason: "startup" }, offline.ctx);
	await offline.settle();
	assert.deepEqual(offline.requests, []);
	delete process.env.PI_OFFLINE;
	const print = harness();
	print.handlers.get("session_start")!({ reason: "startup" }, { ...print.ctx, hasUI: false });
	await print.settle();
	assert.deepEqual(print.requests, []);

	const commented = '{ // mine\n "providers": {} }';
	writeFileSync(modelsPath, commented);
	const h = harness();
	await h.commands.get("cache-keeper-refresh")!("", h.ctx);
	assert.match(h.notices.at(-1)!, /models\.json is not plain JSON .* so it is left as it is/);
	assert.equal(readFileSync(modelsPath, "utf8"), commented);
});
