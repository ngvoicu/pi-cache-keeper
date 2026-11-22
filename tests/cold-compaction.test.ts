// The pure module of the cold compaction model (design/cold-compaction-model.md, section 7, tests 1 to 5).
import assert from "node:assert/strict";
import test from "node:test";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import {
	COLD_CHARS_PER_TOKEN,
	coldChoiceLabel,
	coldFit,
	coldNeedTokens,
	coldRequestChars,
	coldUnusable,
	formatModelRef,
	orderColdChoices,
	parseModelRef,
	type ColdChoice,
} from "../cold-compaction.ts";
import { PI_PROMPT_CHARS } from "../cached-request.ts";

const user = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 1 });
const assistant = (text: string) => ({
	role: "assistant" as const,
	content: [{ type: "text" as const, text }, { type: "toolCall" as const, id: "t1", name: "read", arguments: { path: "a.ts" } }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "m",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "toolUse" as const,
	timestamp: 2,
});
const toolResult = (text: string) => ({ role: "toolResult" as const, toolCallId: "t1", toolName: "read", content: [{ type: "text" as const, text }], isError: false, timestamp: 3 });
const asText = (messages: unknown[]) => serializeConversation(convertToLlm(messages as never)).length;

// 1
test("a model reference parses at the first slash and formats back; an id with slashes keeps them; a bad string is refused", () => {
	assert.deepEqual(parseModelRef("google/gemini-2.5-flash"), { provider: "google", id: "gemini-2.5-flash" });
	assert.deepEqual(parseModelRef("openrouter/google/gemini-2.5-flash"), { provider: "openrouter", id: "google/gemini-2.5-flash" });
	assert.equal(formatModelRef({ provider: "openrouter", id: "google/gemini-2.5-flash" }), "openrouter/google/gemini-2.5-flash");
	for (const bad of ["", "gemini", "/gemini", "google/", "/"]) assert.equal(parseModelRef(bad), undefined, bad);
});

// 2
test("what would be sent: one request, two for a split turn; the previous summary and the instructions are counted; tool results are counted cut", () => {
	const history = [user("Read the file."), assistant("Reading."), toolResult("x".repeat(10_000))];
	const one = coldRequestChars({ messagesToSummarize: history, turnPrefixMessages: [], isSplitTurn: false, previousSummary: undefined });
	assert.equal(one.length, 1);
	assert.equal(one[0], asText(history) + PI_PROMPT_CHARS);
	assert.ok(asText(history) < 3_000, "the 10,000-character tool result is counted cut to 2,000");
	const withSummary = coldRequestChars({ messagesToSummarize: history, turnPrefixMessages: [], isSplitTurn: false, previousSummary: "s".repeat(500) }, "focus on tests");
	assert.equal(withSummary[0], one[0] + 500 + "\n\nAdditional focus: ".length + "focus on tests".length);
	const prefix = [user("Then the next."), assistant("On it.")];
	const split = coldRequestChars({ messagesToSummarize: history, turnPrefixMessages: prefix, isSplitTurn: true, previousSummary: "s".repeat(500) });
	assert.deepEqual(split, [one[0] + 500, asText(prefix) + PI_PROMPT_CHARS], "the history (with the previous summary), then the turn's prefix (without)");
	// A split turn with no earlier history sends only the prefix.
	assert.deepEqual(coldRequestChars({ messagesToSummarize: [], turnPrefixMessages: prefix, isSplitTurn: true, previousSummary: undefined }), [asText(prefix) + PI_PROMPT_CHARS]);
	assert.equal(COLD_CHARS_PER_TOKEN, 3);
	assert.equal(coldNeedTokens([3_000, 3_001]), 1_001, "the larger request, rounded up");
	assert.equal(coldNeedTokens([]), 0);
});

// 3
test("the fit rule: fits, too small, window unknown, an output limit under 16k, and the larger of two requests decides", () => {
	assert.deepEqual(coldFit({ contextWindow: 1_000_000, maxTokens: 65_536 }, 150_000), { fits: true, need: 150_000, window: 1_000_000 });
	assert.deepEqual(coldFit({ contextWindow: 200_000, maxTokens: 64_000 }, 260_000), { fits: false, why: "it needs about 260k tokens and its window is 200k", need: 260_000, window: 200_000 });
	// Room for the summary: 200k - 182k - 4k = 14k, under 16k.
	assert.equal(coldFit({ contextWindow: 200_000, maxTokens: 64_000 }, 182_000).fits, false);
	assert.equal(coldFit({ contextWindow: 200_000, maxTokens: 64_000 }, 180_000).fits, true, "16k of room is enough");
	assert.deepEqual(coldFit({ contextWindow: 0, maxTokens: 8_000 }, 1_000), { fits: false, why: "it declares no context window", need: 1_000 });
	// An output limit under 16k: the whole limit is enough.
	assert.equal(coldFit({ contextWindow: 128_000, maxTokens: 8_192 }, 110_000).fits, true);
	assert.equal(coldFit({ contextWindow: 128_000, maxTokens: 8_192 }, 117_000).fits, false, "7k of room, under its 8k limit");
	// Two requests: the larger decides.
	const need = coldNeedTokens([300_000, 600_000]);
	assert.equal(need, 200_000);
	assert.equal(coldFit({ contextWindow: 200_000, maxTokens: 32_000 }, need).fits, false);
	assert.equal(coldFit({ contextWindow: 400_000, maxTokens: 32_000 }, need).fits, true);
	assert.equal(coldUnusable({ api: "pi-virtual" }), "it is a virtual model");
	assert.equal(coldUnusable({ api: "claude-bridge" }), "it runs through pi-claude-bridge");
	assert.equal(coldUnusable({ api: "google-generative-ai" }), undefined);
});

const priced: ColdChoice = { ref: "google/gemini-2.5-flash", window: 1_048_576, price: { input: 0.3, output: 2.5 }, subscription: false, fit: coldFit({ contextWindow: 1_048_576, maxTokens: 65_536 }, 150_000) };
const sub: ColdChoice = { ref: "openai-codex/gpt-5.5", window: 272_000, price: { input: 1.25, output: 10 }, subscription: true, fit: coldFit({ contextWindow: 272_000, maxTokens: 128_000 }, 150_000) };
const free: ColdChoice = { ref: "ollama/qwen3", window: 200_000, subscription: false, fit: coldFit({ contextWindow: 200_000, maxTokens: 32_000 }, 150_000) };
const unknown: ColdChoice = { ref: "local/llama", subscription: false, fit: coldFit({ contextWindow: 0, maxTokens: 0 }, 150_000) };
const small: ColdChoice = { ref: "anthropic/claude-haiku-4-5", window: 200_000, price: { input: 1, output: 5 }, subscription: false, fit: coldFit({ contextWindow: 200_000, maxTokens: 64_000 }, 190_000) };
const virtual: ColdChoice = { ref: "pi/auto", subscription: false, unusable: "it is a virtual model" };

// 4
test("a menu line for each kind: priced, subscription, no price, window unknown, too small", () => {
	assert.equal(coldChoiceLabel(priced), "google/gemini-2.5-flash · 1.05M window · $0.30 in, $2.50 out per M · holds this session");
	assert.equal(coldChoiceLabel(sub), "openai-codex/gpt-5.5 · 272k window · subscription · holds this session");
	assert.equal(coldChoiceLabel(free), "ollama/qwen3 · 200k window · no price · holds this session");
	assert.equal(coldChoiceLabel(unknown), "local/llama · window unknown · no price · can't be used: it declares no context window");
	assert.equal(coldChoiceLabel(small), "anthropic/claude-haiku-4-5 · 200k window · $1.00 in, $5.00 out per M · too small now (needs about 190k)");
	assert.equal(coldChoiceLabel({ ...priced, ref: "x/y", window: 1_000_000, price: { input: 0.075, output: 0.3 } }), "x/y · 1M window · $0.075 in, $0.30 out per M · holds this session");
	assert.equal(coldChoiceLabel(virtual), "pi/auto · window unknown · no price · can't be used: it is a virtual model");
});

// 5
test("the order of the list: the ones that hold this session first, subscriptions, then by input price, then without a price; names break ties", () => {
	const cheap = { ...priced, ref: "google/gemini-2.5-flash-lite", price: { input: 0.1, output: 0.4 } };
	const twin = { ...priced, ref: "a/gemini-2.5-flash" };
	const order = orderColdChoices([virtual, small, free, priced, unknown, sub, cheap, twin]).map((c) => c.ref);
	assert.deepEqual(order, ["openai-codex/gpt-5.5", "google/gemini-2.5-flash-lite", "a/gemini-2.5-flash", "google/gemini-2.5-flash", "ollama/qwen3", "anthropic/claude-haiku-4-5", "local/llama", "pi/auto"]);
});
