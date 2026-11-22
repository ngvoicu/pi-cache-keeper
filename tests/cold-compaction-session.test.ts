// The cold compaction model in Pi's own session runtime (design/cold-compaction-model.md, section 7, tests 24 and 25):
// /compact on a session whose cache has gone cold, every other setting of the extension off. The second model is an
// in-memory one too, reached through the real Anthropic adapter; nothing leaves the process.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { anthropic, flush, inWindow, settingsFile, skip, textAnswer, type Any } from "./session-runtime.ts";

const COLD_MODEL = { provider: "fixture-cold", id: "summarizer", name: "Summarizer", api: "anthropic-messages", baseUrl: "https://cold.invalid", reasoning: false, input: ["text"], contextWindow: 400_000, maxTokens: 32_000, cost: { input: 0.25, output: 1.25, cacheRead: 0.025, cacheWrite: 0.3 } };

// Every other setting off, the cold model set, and Pi's compaction keeping little so there is something to summarize.
const settings = () =>
	writeFileSync(
		settingsFile,
		JSON.stringify({
			cacheKeeper: { compactAtPercent: 0, compactAtTokens: 0, compactBeforeExpiry: false, keepWarmMinutes: 0, modelData: false, cacheRetention: "short", coldCompactionModel: "fixture-cold/summarizer" },
			compaction: { keepRecentTokens: 1 },
			cacheWarming: "idle",
			packages: [],
		}),
	);

// The cold model, listed with credentials; its requests go through the Anthropic adapter to `answer`, counted.
const withColdModel = (w: Any, answer: () => Response) => {
	const registry = w.runtime.session.extensionRunner.createContext().modelRegistry;
	const find = registry.find.bind(registry);
	const auth = registry.hasConfiguredAuth.bind(registry);
	const stream = registry.streamSimple;
	const sent: Any[] = [];
	registry.find = (provider: string, id: string) => (provider === COLD_MODEL.provider && id === COLD_MODEL.id ? COLD_MODEL : find(provider, id));
	registry.hasConfiguredAuth = (model: Any) => model === COLD_MODEL || auth(model);
	registry.streamSimple = (model: Any, context: Any, options: Any) => {
		if (model !== COLD_MODEL) return stream(model, context, options);
		sent.push({ context, options });
		return anthropic.streamSimple(model, context, { ...options, apiKey: "sk-fixture", maxRetries: 0, fetch: async () => answer() });
	};
	return sent;
};

// Pi's own compaction, on the session's model: its stream function stood in for, counted.
const withPiSummarizer = (w: Any) => {
	const sent: Any[] = [];
	w.runtime.session.agent.streamFunction = (model: Any, context: Any) => {
		sent.push({ model, context });
		return { result: async () => ({ role: "assistant", content: [{ type: "text", text: "Pi's own summary." }], api: model.api, provider: model.provider, model: model.id, usage: { input: 900, output: 90, cacheRead: 0, cacheWrite: 0, totalTokens: 990, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() }) };
	};
	return sent;
};

const run = async (answer: () => Response) => {
	settings();
	const seen: Any = {};
	const result = await inWindow(
		async (w) => {
			const cold = withColdModel(w, answer);
			const pi = withPiSummarizer(w);
			await w.answer();
			await w.answer();
			await w.answer();
			// The 5-minute cache goes cold.
			await w.ticks(400);
			const session = w.runtime.session;
			const model = session.model;
			const thinking = session.thinkingLevel;
			await session.compact();
			await w.ticks(1);
			await flush();
			const branch = w.manager().getBranch();
			seen.entry = branch.findLast((e: Any) => e.type === "compaction");
			seen.card = branch.findLast((e: Any) => e.type === "custom" && e.customType === "cache-keeper");
			seen.cold = cold;
			seen.pi = pi;
			seen.sameModel = session.model === model;
			seen.thinking = [thinking, session.thinkingLevel];
		},
		{ realCompact: true },
	);
	assert.deepEqual(result.thrown, []);
	return seen;
};

// 24
test("/compact on a cold session, every other setting off: the entry is written through the cold model, as the extension's, and the session's model and thinking level are unchanged", { skip }, async () => {
	const seen = await run(() => textAnswer("## Goal\nThe summary by the cold model."));
	assert.equal(seen.cold.length, 1, "one request to the cold model");
	assert.equal(seen.pi.length, 0, "Pi's own summarizer not asked");
	assert.match(seen.cold[0].options.cacheRetention, /^none$/);
	assert.ok(seen.entry, "a compaction entry");
	assert.match(seen.entry.summary, /^## Goal\nThe summary by the cold model\./);
	assert.equal(seen.entry.fromHook, true, "marked as an extension's");
	assert.ok(seen.sameModel, "the session's model object is the one it had");
	assert.equal(seen.thinking[0], seen.thinking[1]);
	const [decision, result] = seen.card.data.records;
	assert.deepEqual([decision.outcome, decision.reason, decision.cold.model], ["cold", "the prompt cache has expired", "fixture-cold/summarizer"]);
	assert.deepEqual([result.event, result.by], ["result", "extension"]);
});

// 25
test("the same with the cold model failing: Pi's own compaction writes the entry", { skip }, async () => {
	const seen = await run(() => new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), { status: 529, headers: { "content-type": "application/json" } }));
	assert.equal(seen.cold.length, 1, "one attempt");
	assert.equal(seen.pi.length, 1, "then Pi's own summarizer");
	assert.equal(seen.entry.summary.startsWith("Pi's own summary."), true);
	assert.notEqual(seen.entry.fromHook, true, "Pi's own");
	assert.ok(seen.sameModel);
	const [decision, result] = seen.card.data.records;
	assert.equal(decision.outcome, "fallback");
	assert.match(decision.cold.skipped, /^its request failed: /);
	assert.deepEqual([result.event, result.by], ["result", "pi"]);
});
