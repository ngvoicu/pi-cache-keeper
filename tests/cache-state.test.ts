import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { cacheState, cacheTier } from "../cache-state.ts";

const claude = { provider: "anthropic", id: "claude", api: "anthropic-messages" } as Model<Api>;
const reply = (id: string, timestamp: number, usage: { cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number }, stopReason = "stop") =>
	({
		type: "message",
		id,
		parentId: null,
		timestamp: "",
		message: { role: "assistant", content: [], timestamp, stopReason, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, ...usage } },
	}) as unknown as SessionEntry;
const compaction = { type: "compaction", id: "c", parentId: null, timestamp: "" } as SessionEntry;

test("the cache expires a lifetime after the latest cached request or cache-warming refresh, and resets at compaction", () => {
	const declared = { ...claude, promptCache: { short: 300, long: 300 } } as Model<Api>;
	const warm = { type: "usage", id: "w", parentId: null, timestamp: new Date(200_000).toISOString(), kind: "cache_warm" } as SessionEntry;
	const cached = reply("a", 1_000, { cacheRead: 500 });

	assert.deepEqual(cacheState(declared, [cached]), { lifetime: { ms: 300_000, source: "declared by the model" }, cached: true, expiresAt: 301_000, replied: true, answeredAt: 1_000, answerPrompt: 501 });
	assert.equal(cacheState(declared, [cached, warm]).expiresAt, 500_000);
	assert.equal(cacheState(declared, [cached, warm], 400_000).answeredAt, 1_000, "refreshes (Pi's or the extension's) are no new answer");
	assert.equal(cacheState(declared, [cached, reply("b", 9_000, {}, "error")]).answeredAt, 1_000, "nor is an answer that used no cache");
	assert.equal(cacheState(declared, [cached, reply("b", 9_000, { cacheRead: 500 })]).answeredAt, 9_000);
	const aborted = cacheState(declared, [cached, reply("b", 9_000, { cacheRead: 700, cacheWrite: 50 }, "aborted")]);
	assert.deepEqual([aborted.answeredAt, aborted.answerPrompt, aborted.expiresAt], [9_000, 751, 301_000], "an aborted answer that used the cache is a real answer; the expiry is counted as before");
	const failed = [cached, reply("b", 9_000, { cacheRead: 700 }, "aborted"), reply("c", 12_000, {}, "error")];
	assert.equal(cacheState(declared, failed, undefined, true).expiresAt, 309_000, "with keep-warm on it is counted from that answer; a failed one that used no cache moves nothing");
	assert.deepEqual(cacheState(declared, [reply("a", 1_000, {})]), { lifetime: { ms: 300_000, source: "declared by the model" }, cached: false, expiresAt: undefined, replied: true, answeredAt: 1_000, answerPrompt: 1 });
	const uncached = cacheState(declared, [cached, reply("b", 9_000, {})]);
	assert.deepEqual([uncached.answeredAt, uncached.cached, uncached.expiresAt], [9_000, false, undefined], "a later successful answer that used no cache is the latest answer, with no expiry");
	assert.equal(cacheState(declared, [cached, reply("b", 9_000, {}, "error")]).expiresAt, 301_000);
	assert.deepEqual(cacheState(declared, [cached, compaction]), { lifetime: { ms: 300_000, source: "declared by the model" }, cached: false, expiresAt: undefined, replied: false });
});

test("the lifetime is the tier the latest write reported, the model's figure for that tier, or OpenAI's minimum", () => {
	const lifetime = (model: Model<Api>, entries: SessionEntry[]) => cacheState(model, entries).lifetime;
	const long = reply("a", 1, { cacheWrite: 500, cacheWrite1h: 500 });

	assert.deepEqual(lifetime(claude, [long]), { ms: 3_600_000, source: "reported by the provider" });
	assert.deepEqual(lifetime(claude, [long, reply("b", 2, { cacheWrite: 40, cacheWrite1h: 0 })]), { ms: 300_000, source: "reported by the provider" });
	assert.deepEqual(lifetime(claude, [long, reply("b", 2, { cacheRead: 500 })]), { ms: 3_600_000, source: "reported by the provider" }, "a turn that only read keeps the tier");
	assert.deepEqual(cacheState(claude, [reply("a", 1, { cacheWrite: 500 })]), { lifetime: undefined, cached: true, expiresAt: undefined, replied: true, answeredAt: 1, answerPrompt: 501 });
	assert.deepEqual(lifetime(claude, [reply("a", 1, { cacheWrite: 500, cacheWrite1h: 500 }, "error")]), { ms: 3_600_000, source: "reported by the provider" }, "a failed turn still reports the tier it wrote");
	assert.equal(lifetime(claude, [long, compaction]), undefined);
	const declared = { ...claude, promptCache: { short: 60, long: 7200 } } as Model<Api>;
	assert.deepEqual(lifetime(declared, [long]), { ms: 7_200_000, source: "declared by the model" });
	const gpt = { provider: "openai", id: "gpt-6-luna", api: "openai-responses", compat: { supportsExplicitPromptCacheMode: true } } as Model<Api>;
	assert.deepEqual(lifetime(gpt, [reply("a", 1, { cacheRead: 500 })]), { ms: 1_800_000, source: "OpenAI's minimum" });
});

test("the cache tier in use is the one the latest write reported, else the one Pi asks for", () => {
	const before = process.env.PI_CACHE_RETENTION;
	try {
		delete process.env.PI_CACHE_RETENTION;
		assert.equal(cacheTier([]), "short");
		process.env.PI_CACHE_RETENTION = "long";
		assert.equal(cacheTier([]), "long");
		// Anthropic says which tier it wrote: that is the one in use, whatever was asked.
		assert.equal(cacheTier([reply("a", 1, { cacheWrite: 500, cacheWrite1h: 0 })]), "short");
		delete process.env.PI_CACHE_RETENTION;
		assert.equal(cacheTier([reply("a", 1, { cacheWrite: 500, cacheWrite1h: 500 })]), "long");
		// A read writes nothing and says nothing; a compaction starts over.
		assert.equal(cacheTier([reply("a", 1, { cacheWrite: 500, cacheWrite1h: 500 }), reply("b", 2, { cacheRead: 500, cacheWrite1h: 0 })]), "long");
		assert.equal(cacheTier([reply("a", 1, { cacheWrite: 500, cacheWrite1h: 500 }), compaction]), "short");
		// Only the model's own answers: another model's 1-hour write says nothing about this one's cache.
		const from = (provider: string, model: string, cacheWrite1h: number) => {
			const entry = reply("a", 1, { cacheWrite: 500, cacheWrite1h }) as SessionEntry & { message: Record<string, unknown> };
			return { ...entry, message: { ...entry.message, provider, model } } as SessionEntry;
		};
		const opus = { provider: "cliproxyapi", id: "claude-opus-5-5" };
		assert.equal(cacheTier([from("cliproxyapi", "claude-opus-5-5", 500)], opus), "long");
		assert.equal(cacheTier([from("cliproxyapi", "claude-opus-5-5", 500)], { provider: "cliproxyapi", id: "gpt-6.1-sol" }), "short");
		assert.equal(cacheTier([from("anthropic", "claude-opus-5-5", 500)], opus), "short");
	} finally {
		if (before === undefined) delete process.env.PI_CACHE_RETENTION;
		else process.env.PI_CACHE_RETENTION = before;
	}
});

test("Kimi K3 on Moonshot's API caches for 5 minutes, or 1 hour when Pi asks for the longer cache", () => {
	const lifetime = (model: object) => cacheState(model as Model<Api>, [reply("a", 1, { cacheRead: 500 })]).lifetime;
	const kimi = { provider: "moonshotai", id: "kimi-k3", api: "openai-completions", baseUrl: "https://api.moonshot.ai/v1" };
	const before = process.env.PI_CACHE_RETENTION;
	try {
		delete process.env.PI_CACHE_RETENTION;
		assert.deepEqual(lifetime(kimi), { ms: 300_000, source: "Kimi's default" });
		process.env.PI_CACHE_RETENTION = "long";
		assert.deepEqual(lifetime(kimi), { ms: 3_600_000, source: "Kimi's 1-hour option" });
		assert.deepEqual(lifetime({ ...kimi, compat: { supportsLongCacheRetention: false } }), { ms: 300_000, source: "Kimi's default" });
		assert.equal(lifetime({ ...kimi, id: "kimi-k2.6" }), undefined);
		assert.equal(lifetime({ ...kimi, provider: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1" }), undefined);
	} finally {
		if (before === undefined) delete process.env.PI_CACHE_RETENTION;
		else process.env.PI_CACHE_RETENTION = before;
	}
});

test("a refresh this extension sent moves the expiry like Pi's own, but not past a newer request or across a compaction", () => {
	const declared = { ...claude, promptCache: { short: 3600, long: 3600 } } as Model<Api>;
	const cached = reply("a", 1_000, { cacheRead: 500 });

	assert.equal(cacheState(declared, [cached], 3_000_000).expiresAt, 6_600_000);
	assert.equal(cacheState(declared, [cached], 500).expiresAt, 3_601_000, "a refresh older than the latest request changes nothing");
	assert.equal(cacheState(declared, [cached, compaction], 3_000_000).expiresAt, undefined);
	assert.equal(cacheState(declared, [reply("a", 1_000, {})], 3_000_000).expiresAt, undefined, "an uncached request has nothing to keep warm");
});
