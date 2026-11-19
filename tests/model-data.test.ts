import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	costOf,
	describeFound,
	desiredOverride,
	emptyStore,
	factsOf,
	fetchDataset,
	fieldStates,
	findFacts,
	accessVia,
	parseAnsweredEvent,
	parseUpstreamsEvent,
	loadStore,
	lookupsFor,
	mergeFacts,
	planOverrides,
	readModelsFile,
	saveStore,
	writeModelsFile,
	type DataStore,
	type Facts,
	type Access,
	type Fetch,
	type PiModel,
	type Written,
} from "../model-data.ts";

// Real entries of https://providers.dev/api/v1/entries, reduced to the fields this extension reads.
const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "providers-dev-entries.json"), "utf8")) as { data: Array<{ provider: string; model: string }> };
const entry = (provider: string, model: string) => {
	const found = fixture.data.find((one) => one.provider === provider && one.model === model);
	assert.ok(found, `fixture has no ${provider}/${model}`);
	return found;
};
const providers: DataStore["providers"] = {};
for (const one of fixture.data) (providers[one.provider] ??= {})[one.model] = factsOf(one);

const piModel = (patch: Partial<PiModel> = {}): PiModel => ({ provider: "p", id: "m", contextWindow: 500_000, maxTokens: 128_000, cost: { input: 2, output: 10 }, ...patch });

test("an entry gives the input window, the output limit and one safe lifetime per retention tier", () => {
	assert.deepEqual(
		{ ...factsOf(entry("openai-codex", "gpt-6.1-sol")), cost: undefined },
		{ window: 922_000, maxOutput: 128_000, short: 300, cost: undefined },
	);
	// The largest input an evaluation saw accepted is a lower bound, not the limit.
	assert.deepEqual({ ...factsOf(entry("openai-codex", "gpt-6-astra")), cost: undefined }, { window: 915_011, windowAtLeast: true, short: 7200, cost: undefined });
	// "Evaluations found no safe lifetime" (0) is kept apart from "nothing known" (absent).
	assert.equal(factsOf(entry("devin", "swe-2")).short, 0);
	assert.equal("long" in factsOf(entry("devin", "swe-2")), false);
	assert.deepEqual(factsOf(entry("meta", "muse-ember-1.0")).short, undefined);
	assert.deepEqual(factsOf(null), {});
	assert.deepEqual(factsOf({ input_window: { tokens: "many" }, max_output: -1, cache_lifetime: { short: { safe_s: null } } }), {});
});

test("prices become pi's cost: base prices, the shortest lifetime's write price, a tier per context size; region and service-tier prices are left out", () => {
	// The same values pi's own catalog has for these models.
	assert.deepEqual(factsOf(entry("anthropic", "claude-haiku-5-5")).cost, {
		input: 0.1,
		output: 0.5,
		cacheRead: 0.01,
		cacheWrite: 0.125,
		tiers: [{ inputTokensAbove: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }],
	});
	assert.deepEqual(factsOf(entry("openai", "gpt-6.1-sol")).cost, {
		input: 2,
		output: 10,
		cacheRead: 0.1,
		cacheWrite: 2.5,
		tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }],
	});
	// Fable 5.2 costs 2× in fast mode and 1.1× in a US region: neither changes the base price.
	assert.deepEqual(factsOf(entry("anthropic", "claude-fable-5-2")).cost, { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 });
	// A subscription entry carries the prices of the API entry it refers to.
	assert.deepEqual(factsOf(entry("openai-codex", "gpt-6.1-sol")).cost, factsOf(entry("openai", "gpt-6.1-sol")).cost);
	assert.equal(factsOf(entry("devin", "swe-2")).cost, undefined);
	const rule = (meter: string, amount: number, when: unknown = null, unit = { name: "token", quantity: 1_000_000 }) => ({ meter, amount, when, unit, operation: "set" });
	assert.equal(costOf({ rules: [rule("text.output", 3)] }), undefined, "no input price, no cost");
	assert.deepEqual(costOf({ rules: [rule("text.input", 0.002, null, { name: "token", quantity: 1000 }), rule("text.output", 6)] }), { input: 2, output: 6, cacheRead: 0, cacheWrite: 0 });
	const night = { kind: "predicate", field: "request.utc_hours", op: "gte", value: "15:00" };
	const big = { kind: "predicate", field: "request.context_tokens", op: "gte", value: 200_000 };
	assert.deepEqual(
		costOf({ rules: [rule("text.input", 1), rule("text.output", 4), rule("text.input", 0.5, night), rule("text.input", 2, big), { ...rule("text.output", 9), operation: "multiply" }] }),
		{ input: 1, output: 4, cacheRead: 0, cacheWrite: 0, tiers: [{ inputTokensAbove: 199_999, input: 2, output: 4, cacheRead: 0, cacheWrite: 0 }] },
	);
});

test("a pi model is looked up under the provider and access method it is reached by", () => {
	assert.deepEqual(lookupsFor({ provider: "anthropic", id: "claude-opus-5-5" }), [{ provider: "anthropic", model: "claude-opus-5-5" }]);
	assert.deepEqual(lookupsFor({ provider: "anthropic", id: "claude-opus-5-5" }, { subscription: true }), [{ provider: "claude-subscription", model: "claude-opus-5-5" }]);
	assert.deepEqual(lookupsFor({ provider: "meta", id: "muse-ember-1.0" }, { subscription: true }), [{ provider: "meta-subscription", model: "muse-ember-1.0" }]);
	assert.deepEqual(lookupsFor({ provider: "openai-codex", id: "gpt-6.1-sol" }, { subscription: true }), [{ provider: "openai-codex", model: "gpt-6.1-sol" }]);
	assert.deepEqual(lookupsFor({ provider: "openrouter", id: "openai/gpt-6.1-sol" }), [{ provider: "openrouter", model: "openai/gpt-6.1-sol" }]);
	// pi's ChatGPT login on the OpenAI API has no entry of its own.
	assert.deepEqual(lookupsFor({ provider: "openai", id: "gpt-6.1-sol" }, { subscription: true }).map((one) => one.provider), ["openai-codex", "openai"]);

	// A proxy model is looked up where its extension says it comes from.
	const via = (upstreams: Access["upstreams"]) => lookupsFor({ provider: "my-proxy", id: "team/claude-opus-5-5" }, { upstreams });
	assert.deepEqual(via([{ provider: "anthropic", model: "claude-opus-5-5", subscription: true }]), [{ provider: "claude-subscription", model: "claude-opus-5-5" }]);
	assert.deepEqual(via([{ provider: "anthropic", model: "claude-opus-5-5", subscription: false }]), [{ provider: "anthropic", model: "claude-opus-5-5" }]);
	// Login or key not known: both. Several possible: all of them, once each.
	assert.deepEqual(via([{ provider: "anthropic", model: "claude-opus-5-5" }]).map((one) => one.provider), ["claude-subscription", "anthropic"]);
	assert.deepEqual(
		via([
			{ provider: "anthropic", model: "claude-opus-5-5", subscription: true },
			{ provider: "anthropic", model: "claude-opus-5-5", subscription: true },
			{ provider: "anthropic", model: "claude-opus-5-5", subscription: false },
		]).map((one) => one.provider),
		["claude-subscription", "anthropic"],
	);
	// The proxy's own id when no other is given; a provider pi has none for is looked up as it is.
	assert.deepEqual(via([{ provider: "devin", subscription: true }]), [{ provider: "devin", model: "team/claude-opus-5-5" }]);
	// A proxy model whose source is not known: nothing.
	assert.deepEqual(via([]), []);
});

test("when two entries can describe a model, only what both say is kept, and the window is the smaller one", () => {
	const unknown = (provider: string) => ({ upstreams: [{ provider }] });
	const claude = findFacts(lookupsFor({ provider: "cliproxyapi", id: "claude-opus-5-5" }, unknown("anthropic")), providers);
	assert.deepEqual(claude.refs, ["claude-subscription/claude-opus-5-5", "anthropic/claude-opus-5-5"]);
	// The login keeps a cache for 1 h, the API key for 5 min by default. Without knowing which serves the model, the
	// shorter is taken: a wrong guess then costs an early refresh, not a cache that expires unnoticed.
	assert.equal(claude.facts.short, 300);
	assert.equal(claude.facts.long, 3600);
	assert.equal(claude.facts.window, 1_000_000);
	assert.deepEqual(claude.assumed, ["short"]);
	assert.deepEqual(claude.unsure, []);
	assert.deepEqual(fieldStates(claude), { window: "found", short: "assumed", long: "found", price: "found" });

	const gpt = findFacts(lookupsFor({ provider: "cliproxyapi", id: "gpt-6-astra" }, { upstreams: [{ provider: "openai-codex", subscription: true }, { provider: "openai", subscription: false }] }), providers);
	assert.equal(gpt.facts.window, 915_011);
	assert.equal(gpt.facts.windowAtLeast, true);
	// Codex login 2 h, API key 30 min: the shorter. Only the API key has a long lifetime: not used.
	assert.equal(gpt.facts.short, 1800);
	assert.deepEqual(gpt.assumed, ["window", "short"]);
	assert.deepEqual(gpt.unsure, ["long"]);

	// One entry lacks what the other has: still not known.
	assert.deepEqual(mergeFacts([{ window: 100 }, { short: 300 }]), { facts: {}, unsure: ["window", "short"], assumed: [] });
	assert.deepEqual(mergeFacts([{ window: 200, short: 300, maxOutput: 9 }, { window: 100, short: 300, maxOutput: 5 }]), {
		facts: { window: 100, short: 300, maxOutput: 5 },
		unsure: [],
		assumed: ["window"],
	});
	// "No safe lifetime" (0) on one side is the smaller value.
	assert.deepEqual(mergeFacts([{ short: 0 }, { short: 300 }]), { facts: { short: 0 }, unsure: [], assumed: ["short"] });
	assert.deepEqual(mergeFacts([]), { facts: {}, unsure: [], assumed: [] });

	// One entry found of two looked up: the model may still be served the other way, which the data does not
	// describe, so nothing of the one entry is taken as sure.
	const onlyCodex = findFacts([{ provider: "openai-codex", model: "gpt-6.1-terra" }, { provider: "openai", model: "gpt-6.1-terra" }], providers);
	assert.deepEqual(onlyCodex.refs, ["openai-codex/gpt-6.1-terra"]);
	assert.deepEqual(onlyCodex.facts, {});
	assert.deepEqual(onlyCodex.unsure, ["window", "short", "price"]);
	assert.deepEqual(desiredOverride(piModel(), onlyCodex.facts), {});
	// A single possible entry is taken as it is.
	assert.deepEqual(findFacts([{ provider: "openai-codex", model: "gpt-6.1-terra" }], providers).unsure, []);
	assert.deepEqual(findFacts([{ provider: "nowhere", model: "x" }], providers), { facts: {}, unsure: [], assumed: [], refs: [] });
});

test("what providers.dev has for each field: a lifetime evaluations found unsafe counts as not found", () => {
	const exact = (provider: string, model: string) => findFacts([{ provider, model }], providers);
	assert.deepEqual(fieldStates(exact("openai-codex", "gpt-6.1-sol")), { window: "found", short: "found", long: "missing", price: "found" });
	assert.deepEqual(fieldStates(exact("devin", "swe-2")), { window: "found", short: "missing", long: "missing", price: "missing" });
	assert.deepEqual(fieldStates(exact("openai-codex", "gpt-6.1-terra")), { window: "found", short: "missing", long: "missing", price: "found" });
	const gemini = fieldStates(exact("antigravity", "gemini-3.8-flash-high"));
	assert.deepEqual([gemini.window, gemini.short], ["missing", "found"]);
	const unsure = findFacts(lookupsFor({ provider: "cliproxyapi", id: "claude-opus-5-5" }, { upstreams: [{ provider: "anthropic" }] }), providers);
	assert.deepEqual(fieldStates(unsure), { window: "found", short: "assumed", long: "found", price: "found" });
	assert.deepEqual(fieldStates(exact("openai", "nope")), { window: "missing", short: "missing", long: "missing", price: "missing" });
	assert.equal(describeFound(exact("openai-codex", "gpt-6.1-sol")), "openai-codex/gpt-6.1-sol: window 922,000, short cache 5 min, price $2/$10 per million");
	assert.equal(describeFound(exact("devin", "swe-2")), "devin/swe-2: window at least 300,499, no safe short cache lifetime");
	assert.equal(
		describeFound(unsure),
		"claude-subscription/claude-opus-5-5 or anthropic/claude-opus-5-5: window 1,000,000, short cache 5 min, long cache 1 h, price $4/$20 per million; cache short: the smaller of the login's and the API key's, because which one serves the model is not known",
	);
	assert.equal(describeFound(exact("openai", "nope")), "no entry for this model");
});

test("what goes into models.json: the window replaces pi's, lifetimes and prices only fill what pi lacks", () => {
	const codexSol = factsOf(entry("openai-codex", "gpt-6.1-sol"));
	assert.deepEqual(desiredOverride(piModel(), codexSol), { contextWindow: 922_000, promptCache: { short: 300 } });
	// pi already has that window: nothing to write for it.
	assert.deepEqual(desiredOverride(piModel({ contextWindow: 922_000 }), codexSol), { promptCache: { short: 300 } });
	// pi's own catalog declares lifetimes for the request it sends (5 min by default on a Claude login); they stay.
	const claudeLogin = factsOf(entry("claude-subscription", "claude-opus-5-5"));
	assert.equal(claudeLogin.short, 3600);
	assert.deepEqual(desiredOverride(piModel({ contextWindow: 1_000_000, promptCache: { short: 300, long: 3600 } }), claudeLogin), {});
	assert.deepEqual(desiredOverride(piModel({ contextWindow: 1_000_000, promptCache: { long: 3600 } }), claudeLogin), { promptCache: { short: 3600 } });
	// A lifetime this extension wrote itself is its own to update.
	assert.deepEqual(desiredOverride(piModel({ contextWindow: 922_000, promptCache: { short: 120 } }), codexSol, { promptCache: { short: 120 } }), { promptCache: { short: 300 } });
	// No safe lifetime (0) is never declared: pi would treat the cache as expired at once.
	assert.deepEqual(desiredOverride(piModel({ contextWindow: 922_000 }), factsOf(entry("openai-codex", "gpt-6.1-terra"))), {});

	// "At least this much was accepted" raises a smaller window and never lowers a larger one.
	const devinClaude = factsOf(entry("devin", "claude-opus-5-5"));
	assert.equal(devinClaude.window, 999_072);
	assert.equal(desiredOverride(piModel({ contextWindow: 1_000_000 }), devinClaude).contextWindow, undefined);
	assert.equal(desiredOverride(piModel({ contextWindow: 272_000 }), factsOf(entry("openai-codex", "gpt-6-astra"))).contextWindow, 915_011);
	assert.equal(desiredOverride(piModel({ contextWindow: 920_000 }), { window: 915_011, windowAtLeast: true }, { contextWindow: 920_000 }).contextWindow, 920_000);
	// A limit lowers a window that is too large.
	assert.equal(desiredOverride(piModel({ contextWindow: 1_050_000 }), factsOf(entry("openrouter", "openai/gpt-6.1-sol"))).contextWindow, 922_000);

	// Prices and the output limit: only where pi has none.
	const priced = factsOf(entry("openai", "gpt-6.1-sol"));
	assert.equal(desiredOverride(piModel({ contextWindow: 922_000, promptCache: { short: 1, long: 1 } }), priced).cost, undefined);
	assert.deepEqual(desiredOverride(piModel({ contextWindow: 922_000, promptCache: { short: 1, long: 1 }, cost: { input: 0, output: 0 } }), priced).cost, priced.cost);
	assert.equal(desiredOverride(piModel({ maxTokens: 0 }), { maxOutput: 64_000 }).maxTokens, 64_000);
	assert.equal(desiredOverride(piModel({ maxTokens: 32_000 }), { maxOutput: 64_000 }).maxTokens, undefined);
	assert.deepEqual(desiredOverride(piModel(), {}), {});
});

test("models.json: the user's values are never touched, this extension's own are updated and removed again", () => {
	const user = {
		providers: {
			ollama: { baseUrl: "http://localhost:11434/v1", models: [{ id: "llama" }] },
			p: { modelOverrides: { m: { name: "Mine", contextWindow: 111 }, other: { promptCache: { long: 9 } } } },
		},
	};
	const want = (values: Record<string, Written>) => (provider: string, id: string) => values[`${provider}/${id}`] ?? {};
	const models = [{ provider: "p", id: "m" }, { provider: "p", id: "other" }, { provider: "q", id: "n" }];
	const first = planOverrides(user, {}, models, want({
		"p/m": { contextWindow: 922_000, promptCache: { short: 300 } },
		"p/other": { promptCache: { short: 300, long: 3600 } },
		"q/n": { contextWindow: 5, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
	}));
	// The user's window and long lifetime stay; only the free fields are filled.
	assert.deepEqual(first.file, {
		providers: {
			ollama: user.providers.ollama,
			p: { modelOverrides: { m: { name: "Mine", contextWindow: 111, promptCache: { short: 300 } }, other: { promptCache: { long: 9, short: 300 } } } },
			q: { modelOverrides: { n: { contextWindow: 5, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } } } },
		},
	});
	assert.deepEqual(first.written, {
		p: { m: { promptCache: { short: 300 } }, other: { promptCache: { short: 300 } } },
		q: { n: { contextWindow: 5, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } } },
	});
	const keys = (changed: Array<{ provider: string; id: string }>) => changed.map((one) => `${one.provider}/${one.id}`).sort();
	assert.deepEqual(keys(first.changed), ["p/m", "p/other", "q/n"]);
	assert.equal((user.providers.p.modelOverrides.m as Record<string, unknown>).promptCache, undefined, "the object passed in is not changed");

	// Nothing new: nothing changes.
	const again = planOverrides(first.file, first.written, models, (provider, id, owned) => owned);
	assert.deepEqual(again.changed, []);
	assert.deepEqual(again.file, first.file);
	assert.deepEqual(again.written, first.written);

	// The user takes over a value this extension wrote: it is theirs from then on.
	const edited = structuredClone(first.file) as typeof first.file & { providers: { q: { modelOverrides: { n: { contextWindow: number } } } } };
	edited.providers.q.modelOverrides.n.contextWindow = 7;
	let seenOwned: Written | undefined;
	const afterEdit = planOverrides(edited, first.written, models, (provider, id, owned) => {
		if (provider === "q") seenOwned = owned;
		return provider === "q" ? { contextWindow: 9 } : owned;
	});
	assert.equal(seenOwned?.contextWindow, undefined);
	assert.deepEqual((afterEdit.file.providers as typeof edited.providers).q, { modelOverrides: { n: { contextWindow: 7 } } }, "the edited window stays, the price is no longer wanted and goes");
	assert.equal(afterEdit.written.q, undefined);

	// The data is gone, or the model is: this extension's values go, the user's and everything else stay.
	const cleared = planOverrides(first.file, first.written, [{ provider: "p", id: "m" }], () => ({}));
	assert.deepEqual(cleared.file, user);
	assert.deepEqual(cleared.written, {});
	assert.deepEqual(keys(cleared.changed), ["p/m", "p/other", "q/n"]);

	// A file without a providers key does not gain an empty one.
	assert.deepEqual(planOverrides({}, {}, models, () => ({})).file, {});
	assert.deepEqual(planOverrides({}, {}, [{ provider: "p", id: "m" }], () => ({ maxTokens: 1 })).file, { providers: { p: { modelOverrides: { m: { maxTokens: 1 } } } } });
});

test("the saved data and models.json are read and written in pi's folder, and models.json keeps its permissions", () => {
	const dir = mkdtempSync(join(tmpdir(), "pck-data-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		assert.deepEqual(loadStore(), emptyStore());
		const store: DataStore = { ...emptyStore(), checkedAt: 5, datasetVersion: "v1", providers: { openai: { m: { window: 1 } } }, written: { p: { m: { maxTokens: 2 } } } };
		saveStore(store);
		assert.deepEqual(loadStore(), store);
		writeFileSync(join(dir, "cache-keeper-models.json"), "{ cut short");
		assert.deepEqual(loadStore(), emptyStore());
		writeFileSync(join(dir, "cache-keeper-models.json"), JSON.stringify({ version: 2, providers: { a: {} } }));
		assert.deepEqual(loadStore(), emptyStore(), "another version's file is not read");

		assert.deepEqual(readModelsFile(), {});
		writeFileSync(join(dir, "models.json"), '{ "providers": {} }');
		chmodSync(join(dir, "models.json"), 0o600);
		writeModelsFile({ providers: { p: { apiKey: "secret" } } });
		assert.equal(statSync(join(dir, "models.json")).mode & 0o777, 0o600);
		assert.deepEqual(readModelsFile(), { providers: { p: { apiKey: "secret" } } });
		writeFileSync(join(dir, "models.json"), '{ // a comment\n "providers": {} }');
		assert.throws(readModelsFile);
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(dir, { recursive: true });
	}
});

test("providers.dev is asked once whether the dataset changed, then per provider, page by page; a failure keeps the saved data", async () => {
	const calls: string[] = [];
	const pages: Record<string, unknown> = {
		"/meta": { meta: { dataset_version: "v2" }, data: {} },
		"/entries?provider=openai-codex&limit=200&offset=0": { meta: { dataset_version: "v2" }, next_offset: 200, data: [entry("openai-codex", "gpt-6.1-sol")] },
		"/entries?provider=openai-codex&limit=200&offset=200": { meta: { dataset_version: "v2" }, next_offset: null, data: [entry("openai-codex", "gpt-6-astra"), { no: "model" }] },
		"/entries?provider=nope&limit=200&offset=0": { meta: { dataset_version: "v2" }, next_offset: null, data: [] },
	};
	const fetchImpl: Fetch = async (url, init) => {
		calls.push(url.replace("https://providers.dev/api/v1", ""));
		assert.equal(init.headers.accept, "application/json");
		assert.equal(Object.keys(init.headers).some((name) => name.toLowerCase() === "authorization"), false, "no credentials go to providers.dev");
		const body = pages[url.replace("https://providers.dev/api/v1", "")];
		return { ok: body !== undefined, status: body === undefined ? 503 : 200, json: async () => body };
	};
	const fresh = await fetchDataset(["openai-codex", "nope"], emptyStore(), fetchImpl);
	assert.equal(fresh.downloaded, true);
	assert.equal(fresh.datasetVersion, "v2");
	assert.deepEqual(Object.keys(fresh.providers["openai-codex"]).sort(), ["gpt-6-astra", "gpt-6.1-sol"]);
	assert.equal(fresh.providers["openai-codex"]["gpt-6.1-sol"].window, 922_000);
	assert.deepEqual(fresh.providers.nope, {}, "a provider providers.dev does not know is remembered as empty");
	assert.equal(calls[0], "/meta");
	assert.equal(calls.length, 4);

	// The same dataset and every provider saved: one small request.
	const saved: DataStore = { ...emptyStore(), datasetVersion: "v2", providers: fresh.providers };
	calls.length = 0;
	const unchanged = await fetchDataset(["openai-codex", "nope"], saved, fetchImpl);
	assert.equal(unchanged.downloaded, false);
	assert.deepEqual(calls, ["/meta"]);
	assert.deepEqual(unchanged.providers, fresh.providers);
	// A provider that is not saved yet, an older dataset, or a forced refresh: download.
	assert.equal((await fetchDataset(["openai-codex"], { ...saved, datasetVersion: "v1" }, fetchImpl)).downloaded, true);
	assert.equal((await fetchDataset(["openai-codex"], saved, fetchImpl, { force: true })).downloaded, true);
	await assert.rejects(fetchDataset(["openai-codex", "meta"], saved, fetchImpl), /answered 503/);
	await assert.rejects(fetchDataset(["openai-codex"], saved, async () => { throw new Error("offline"); }), /offline/);
});

test("a proxy extension's events: every model's route, and what answered a request; what cannot be read is not known", () => {
	const login = { provider: "anthropic", model: "claude-opus-5-5", subscription: true };
	const key = { provider: "anthropic", model: "claude-opus-5-5", subscription: false };
	assert.deepEqual(
		parseUpstreamsEvent({
			provider: "cliproxyapi",
			models: {
				"claude-opus-5-5": { upstreams: [login], fallbacks: [key] },
				"gpt-6.1-sol": { upstreams: [{ provider: "openai-codex", subscription: true, extra: 1 }], fallbacks: [] },
				// One upstream that cannot be read: the model's source is not known.
				odd: { upstreams: [login, { subscription: true }] },
				junk: "x",
			},
		}),
		{
			provider: "cliproxyapi",
			models: {
				"claude-opus-5-5": { upstreams: [login], fallbacks: [key] },
				"gpt-6.1-sol": { upstreams: [{ provider: "openai-codex", subscription: true }] },
				odd: { upstreams: [] },
			},
		},
	);
	assert.equal(parseUpstreamsEvent({ provider: "cliproxyapi" }), undefined);
	assert.equal(parseUpstreamsEvent("x"), undefined);
	assert.deepEqual(parseAnsweredEvent({ provider: "cliproxyapi", model: "claude-opus-5-5", upstreams: [key] }), { provider: "cliproxyapi", model: "claude-opus-5-5", upstreams: [key] });
	assert.equal(parseAnsweredEvent({ provider: "cliproxyapi", model: "claude-opus-5-5", upstreams: [] }), undefined);
});

test("which values are sure: one entry, the smaller of values that differ, or a value only some entries have", () => {
	const login = { provider: "anthropic", model: "claude-opus-5-5", subscription: true };
	const exact = findFacts(lookupsFor({ provider: "cliproxyapi", id: "claude-opus-5-5" }, { upstreams: [login] }), providers);
	assert.deepEqual({ short: exact.facts.short, long: exact.facts.long, assumed: exact.assumed, unsure: exact.unsure }, { short: 3600, long: 3600, assumed: [], unsure: [] });
	assert.deepEqual(fieldStates(exact), { window: "found", short: "found", long: "found", price: "found" });
	// A login or an API key, not known: the key's 5 minutes, the smaller short lifetime, is a guess.
	const either = findFacts(lookupsFor({ provider: "cliproxyapi", id: "claude-opus-5-5" }, { upstreams: [{ provider: "anthropic" }] }), providers);
	assert.deepEqual([either.facts.short, fieldStates(either).short], [300, "assumed"]);
	// Pi knows it is the ChatGPT login, but providers.dev has no entry for that login on the OpenAI API: the short
	// lifetime is the smaller of the two, the long one only the API key has.
	const chatgpt = findFacts(lookupsFor({ provider: "openai", id: "gpt-6.1-sol" }, { subscription: true }), providers);
	assert.deepEqual(fieldStates(chatgpt), { window: "found", short: "assumed", long: "unsure", price: "found" });
});

test("a model is served by a subscription login or an API key: pi's own sign-in, or what the proxy's extension says", () => {
	assert.equal(accessVia({ subscription: true }), "sub");
	assert.equal(accessVia({}), "api");
	const login = { provider: "anthropic", subscription: true };
	const key = { provider: "anthropic", subscription: false };
	assert.equal(accessVia({ upstreams: [login, login] }), "sub");
	assert.equal(accessVia({ upstreams: [key] }), "api");
	assert.equal(accessVia({ upstreams: [login, key] }), "sub or api", "either may answer");
	assert.equal(accessVia({ upstreams: [{ provider: "anthropic" }] }), "sub or api", "not known");
	assert.equal(accessVia({ upstreams: [] }), "sub or api", "a proxy model whose source is not known");
});

test("the facts of the fixture cover every field the extension reads", () => {
	const all: Facts[] = Object.values(providers).flatMap((models) => Object.values(models));
	assert.equal(all.length, fixture.data.length);
	assert.ok(all.some((facts) => facts.long !== undefined) && all.some((facts) => facts.cost?.tiers) && all.some((facts) => facts.windowAtLeast));
});
