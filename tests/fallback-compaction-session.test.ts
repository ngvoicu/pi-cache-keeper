// The fallback compaction model in Pi's own session runtime (design/fallback-compaction-model.md, section 7, tests 24 and 25):
// /compact on a session whose cache has gone cold, every other setting of the extension off. The second model is an
// in-memory one too, reached through the real Anthropic adapter; nothing leaves the process.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { anthropic, dir, flush, inWindow, piMessages, settingsFile, skip, textAnswer, type Any } from "./session-runtime.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FALLBACK_MODEL = { provider: "fixture-cold", id: "summarizer", name: "Summarizer", api: "anthropic-messages", baseUrl: "https://cold.invalid", reasoning: false, input: ["text"], contextWindow: 400_000, maxTokens: 32_000, cost: { input: 0.25, output: 1.25, cacheRead: 0.025, cacheWrite: 0.3 } };

// Every other setting off, the fallback model set, and Pi's compaction keeping little so there is something to summarize.
const settings = (pick = "fixture-cold/summarizer") =>
	writeFileSync(
		settingsFile,
		JSON.stringify({
			cacheKeeper: { compactAtPercent: 0, compactAtTokens: 0, compactBeforeExpiry: false, keepWarmMinutes: 0, modelData: false, cacheRetention: "short", fallbackCompactionModel: pick },
			compaction: { keepRecentTokens: 1 },
			retry: { enabled: false },
			cacheWarming: "idle",
			packages: [],
		}),
	);

// The fallback model, listed with credentials; its requests go through the Anthropic adapter to `answer`, counted.
const withFallbackModel = (w: Any, answer: () => Response) => {
	const registry = w.runtime.session.extensionRunner.createContext().modelRegistry;
	const find = registry.find.bind(registry);
	const auth = registry.hasConfiguredAuth.bind(registry);
	const stream = registry.streamSimple;
	const sent: Any[] = [];
	registry.find = (provider: string, id: string) => (provider === FALLBACK_MODEL.provider && id === FALLBACK_MODEL.id ? FALLBACK_MODEL : find(provider, id));
	registry.hasConfiguredAuth = (model: Any) => model === FALLBACK_MODEL || auth(model);
	registry.streamSimple = (model: Any, context: Any, options: Any) => {
		if (model !== FALLBACK_MODEL) return stream(model, context, options);
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
			const cold = withFallbackModel(w, answer);
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
test("/compact on a cold session, every other setting off: the entry is written through the fallback model, as the extension's, and the session's model and thinking level are unchanged", { skip }, async () => {
	const seen = await run(() => textAnswer("## Goal\nThe summary by the fallback model."));
	assert.equal(seen.cold.length, 1, "one request to the fallback model");
	assert.equal(seen.pi.length, 0, "Pi's own summarizer not asked");
	assert.match(seen.cold[0].options.cacheRetention, /^none$/);
	assert.ok(seen.entry, "a compaction entry");
	assert.match(seen.entry.summary, /^## Goal\nThe summary by the fallback model\./);
	assert.equal(seen.entry.fromHook, true, "marked as an extension's");
	assert.ok(seen.sameModel, "the session's model object is the one it had");
	assert.equal(seen.thinking[0], seen.thinking[1]);
	const [decision, result] = seen.card.data.records;
	assert.deepEqual([decision.outcome, decision.reason, decision.cold.model], ["cold", "the prompt cache has expired", "fixture-cold/summarizer"]);
	assert.deepEqual([result.event, result.by], ["result", "extension"]);
});

// 25
test("the same with the fallback model failing: Pi's own compaction writes the entry", { skip }, async () => {
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

// Finding 1 (review of 0.10.0, round 1), as the reviewer reproduced it on both Pi versions: a gateway streams part of the
// history's summary, then ends the reply aborted (or in an error) while the compaction's own signal is live. That is a
// failure: the turn's prefix is not sent, and Pi's own compaction writes the entry.
test("review 1: a split turn whose history reply streams text and then ends aborted or in an error: no prefix request, Pi's own compaction writes the entry", { skip: skip || !piMessages }, async () => {
	for (const end of ["aborted", "error"] as const) {
		settings("fixture/gateway");
		const seen: Any = {};
		const result = await inWindow(
			async (w) => {
				const s = w.runtime.session;
				const manager = w.manager();
				const registry = s.extensionRunner.createContext().modelRegistry;
				const target = { ...s.model, api: "pi-messages", provider: "fixture", id: "gateway", baseUrl: "https://gateway.invalid" };
				const find = registry.find.bind(registry);
				const auth = registry.hasConfiguredAuth.bind(registry);
				const stream = registry.streamSimple;
				const usage = { input: 1500, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 1520, cost: { input: 0.005, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.006 } };
				const cold: string[] = [];
				const native: string[] = [];
				registry.find = (provider: string, id: string) => (provider === "fixture" && id === "gateway" ? target : find(provider, id));
				registry.hasConfiguredAuth = (model: Any) => model === target || auth(model);
				registry.streamSimple = (model: Any, context: Any, options: Any) => {
					if (model !== target) return stream(model, context, options);
					return piMessages.streamSimple(model, context, {
						...options,
						apiKey: "fixture",
						fetch: async () => {
							const first = cold.length === 0;
							cold.push(JSON.stringify(context.messages).includes("prior implementation") ? "history" : "prefix");
							const events = [
								{ type: "start" },
								{ type: "text_start", contentIndex: 0 },
								{ type: "text_delta", contentIndex: 0, delta: first ? "Partial checkpoint from cancelled upstream" : "Completed checkpoint" },
								first ? { type: "error", reason: end, errorMessage: "upstream cancelled", usage } : { type: "done", reason: "stop", usage },
							];
							return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
						},
					});
				};
				s.agent.streamFunction = (model: Any, context: Any, options: Any) => {
					native.push(JSON.stringify(context.messages).includes("prior implementation") ? "history" : "prefix");
					return anthropic.streamSimple(model, context, { ...options, apiKey: "sk-fixture", fetch: async () => textAnswer("Native Pi checkpoint") });
				};
				const user = (text: string) => ({ role: "user", timestamp: Date.now(), content: text });
				const assistant = (text: string) => ({ role: "assistant", timestamp: Date.now(), content: [{ type: "text", text }], provider: s.model.provider, model: s.model.id, api: s.model.api, usage, stopReason: "stop" });
				manager.appendMessage(user("Preserve the prior implementation detail"));
				manager.appendMessage(assistant("A durable decision"));
				manager.appendMessage(user("Current task and progress"));
				manager.appendMessage(assistant("Newest kept answer"));
				await s.compact();
				await flush();
				seen.cold = cold;
				seen.native = native;
				seen.entry = manager.getBranch().findLast((e: Any) => e.type === "compaction");
				seen.record = readFileSync(join(dir, "cache-keeper.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).findLast((r: Any) => r.event === "compact");
			},
			{ realCompact: true },
		);
		assert.deepEqual(result.thrown, [], end);
		assert.deepEqual(seen.cold, ["history"], `${end}: the prefix is not sent`);
		assert.ok(seen.native.length > 0, `${end}: Pi's own compaction ran`);
		assert.notEqual(seen.entry.fromHook, true, `${end}: not the extension's entry`);
		assert.match(seen.entry.summary, /^Native Pi checkpoint/, end);
		assert.equal(seen.record.outcome, "fallback", end);
		assert.equal(seen.record.cold.requests, 1, end);
		assert.match(seen.record.cold.skipped, end === "aborted" ? /^its request ended early \(aborted\)/ : /^its request failed: /, end);
	}
});
