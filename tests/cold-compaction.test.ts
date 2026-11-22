// The pure module of the cold compaction model (design/cold-compaction-model.md, section 7, tests 1 to 5).
import assert from "node:assert/strict";
import test from "node:test";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import {
	COLD_PROMPT_TOKENS,
	coldChoiceLabel,
	coldFit,
	coldNeedTokens,
	coldRequestTokens,
	coldTextTokens,
	coldUnusable,
	fitColdLine,
	formatModelRef,
	orderColdChoices,
	parseModelRef,
	type ColdChoice,
} from "../cold-compaction.ts";

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
const asText = (messages: unknown[]) => coldTextTokens(serializeConversation(convertToLlm(messages as never)));

// 1
test("a model reference parses at the first slash and formats back; an id with slashes keeps them; a bad string is refused", () => {
	assert.deepEqual(parseModelRef("google/gemini-2.5-flash"), { provider: "google", id: "gemini-2.5-flash" });
	assert.deepEqual(parseModelRef("openrouter/google/gemini-2.5-flash"), { provider: "openrouter", id: "google/gemini-2.5-flash" });
	assert.equal(formatModelRef({ provider: "openrouter", id: "google/gemini-2.5-flash" }), "openrouter/google/gemini-2.5-flash");
	for (const bad of ["", "gemini", "/gemini", "google/", "/"]) assert.equal(parseModelRef(bad), undefined, bad);
});

// 2
test("what would be sent: one request, two for a split turn, counted by the mixed rule; the previous summary and the instructions are counted; tool results are counted cut", () => {
	const history = [user("Read the file."), assistant("Reading."), toolResult("x ".repeat(5_000))];
	const one = coldRequestTokens({ messagesToSummarize: history, turnPrefixMessages: [], isSplitTurn: false, previousSummary: undefined });
	assert.equal(one.length, 1);
	assert.equal(one[0], asText(history) + COLD_PROMPT_TOKENS);
	assert.ok(asText(history) < 1_100, "the 10,000-character tool result is counted cut to 2,000 characters");
	const summary = "word ".repeat(500);
	const withSummary = coldRequestTokens({ messagesToSummarize: history, turnPrefixMessages: [], isSplitTurn: false, previousSummary: summary }, "focus on tests");
	assert.equal(withSummary[0], one[0] + coldTextTokens(summary) + coldTextTokens("\n\nAdditional focus: focus on tests"));
	const prefix = [user("Then the next."), assistant("On it.")];
	const split = coldRequestTokens({ messagesToSummarize: history, turnPrefixMessages: prefix, isSplitTurn: true, previousSummary: summary });
	assert.deepEqual(split, [one[0] + coldTextTokens(summary), asText(prefix) + COLD_PROMPT_TOKENS], "the history (with the previous summary), then the turn's prefix (without)");
	// A split turn with no earlier history sends only the prefix.
	assert.deepEqual(coldRequestTokens({ messagesToSummarize: [], turnPrefixMessages: prefix, isSplitTurn: true, previousSummary: undefined }), [asText(prefix) + COLD_PROMPT_TOKENS]);
	assert.equal(coldNeedTokens([3_000, 3_001]), 3_001, "the larger request");
	assert.equal(coldNeedTokens([]), 0);
});

// The mixed count itself (review 4b, round 2): an ASCII word up to 20 characters counts its length / 3 (at least 1);
// any other word counts its UTF-8 bytes; whitespace counts nothing.
test("the mixed count: short ASCII words at a third of their length, at least one; long or non-ASCII words at a token a byte", () => {
	assert.equal(coldTextTokens(""), 0);
	assert.equal(coldTextTokens("a"), 1, "at least one");
	assert.equal(coldTextTokens("abcdef"), 2);
	assert.equal(coldTextTokens("ab cd ef"), 3, "each word at least one");
	assert.equal(coldTextTokens("abcdefghijklmnopqrst"), 7, "20 characters: a third");
	assert.equal(coldTextTokens("abcdefghijklmnopqrstu"), 21, "21 characters: a token a character");
	assert.equal(coldTextTokens("é中"), 5, "non-ASCII: a token a byte (2 + 3)");
	assert.equal(coldTextTokens("  abc \n\t def  "), 2, "whitespace splits and counts nothing");
});

// 3
test("the fit rule: fits, too small, window unknown, an output limit under 16k, and the larger of two requests decides", () => {
	assert.deepEqual(coldFit({ contextWindow: 1_000_000, maxTokens: 65_536 }, 150_000), { fits: true, need: 150_000, window: 1_000_000, maxTokens: 65_536 });
	assert.deepEqual(coldFit({ contextWindow: 200_000, maxTokens: 64_000 }, 170_000), { fits: true, need: 170_000, window: 200_000, maxTokens: 26_000 }, "the cap sent: what the window leaves");
	const reserved = coldFit({ contextWindow: 200_000, maxTokens: 64_000 }, 170_000, 2_048);
	assert.equal(reserved.fits ? reserved.maxTokens : undefined, 23_952, "less the thinking reserve");
	assert.equal(coldFit({ contextWindow: 200_000, maxTokens: 64_000 }, 180_000, 2_048).fits, false, "16k of room, less 2k of thinking");
	assert.deepEqual(coldFit({ contextWindow: 200_000, maxTokens: 64_000 }, 260_000), { fits: false, why: "it needs about 260k tokens and its window is 200k", need: 260_000, window: 200_000 });
	// Room for the summary: 200k - 182k - 4k = 14k, under 16k.
	assert.equal(coldFit({ contextWindow: 200_000, maxTokens: 64_000 }, 182_000).fits, false);
	assert.equal(coldFit({ contextWindow: 200_000, maxTokens: 64_000 }, 180_000).fits, true, "16k of room is enough");
	assert.deepEqual(coldFit({ contextWindow: 0, maxTokens: 8_000 }, 1_000), { fits: false, why: "it declares no context window", need: 1_000 });
	// An output limit under 16k: the whole limit is enough.
	assert.equal(coldFit({ contextWindow: 128_000, maxTokens: 8_192 }, 110_000).fits, true);
	assert.equal(coldFit({ contextWindow: 128_000, maxTokens: 8_192 }, 117_000).fits, false, "7k of room, under its 8k limit");
	// Two requests: the larger decides.
	const need = coldNeedTokens([150_000, 200_000]);
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

// Finding 4b (review, rounds 1 and 2): dense text. Measured with OpenAI's tokenizers (gpt-tokenizer 3.4.0): the reviewer's
// base64 attachment (221,872 characters) is 151,599 tokens in o200k_base; 20,000 rare CJK characters are 46,512 tokens in
// cl100k_base (46,648 for this string alone; 2.3 tokens a character). Both are words the mixed count takes at a token a
// byte, so both are counted high.
test("review 4b: dense text is counted high enough to be refused where it doesn't fit: the reviewer's base64, and CJK", async () => {
	const { createHash } = await import("node:crypto");
	const blob = Buffer.concat(Array.from({ length: 2600 }, (_, i) => createHash("sha256").update(`capture ${i}`).digest())).toString("base64");
	const base64 = coldNeedTokens(coldRequestTokens({ messagesToSummarize: [user(`This is the diagnostic attachment as base64:\n${blob}\n${blob}`)], turnPrefixMessages: [], isSplitTurn: false, previousSummary: undefined }));
	assert.ok(base64 >= 151_599, `${base64}`);
	assert.equal(coldFit({ contextWindow: 128_000, maxTokens: 16_384 }, base64).fits, false, "gpt-4o-mini's window: refused");
	const rare = Array.from({ length: 20_000 }, (_, i) => String.fromCodePoint(0x4e00 + ((i * 7919) % 20_000))).join("");
	const cjk = coldNeedTokens(coldRequestTokens({ messagesToSummarize: [user(rare)], turnPrefixMessages: [], isSplitTurn: false, previousSummary: undefined }));
	assert.ok(cjk >= 46_648, `${cjk}`);
	assert.equal(coldFit({ contextWindow: 50_000, maxTokens: 8_192 }, cjk).fits, false, "a 50k window can't hold 46k tokens of CJK");
});

// Finding 3 (review, round 1): the README says plainly what reaches the picked model's provider.
test("review 3: the README's privacy note names the shell output sent in full and, on older Pi, the thinking", async () => {
	const { readFileSync } = await import("node:fs");
	const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
	const note = readme.split("\n").find((line) => line.startsWith("**Where your conversation goes.**")) ?? "";
	assert.match(note, /full output of shell commands you ran with `!`/);
	assert.match(note, /on Pi before 1\.2, the assistant's thinking/);
});

// Finding 10 (review, round 1): a line too wide for the terminal keeps the end of a model id that doesn't fit.
test("review 10: fitting a menu line keeps the end of a long model id, and cuts the rest of a line whose id fits", () => {
	const a = "amazon-bedrock/anthropic.claude-sonnet-4-5-20250929-v1:0";
	const b = "amazon-bedrock/anthropic.claude-sonnet-4-6";
	const line = (ref: string) => `${ref} · 1M window · $3.30 in, $16.50 out per M · holds this session`;
	assert.equal(fitColdLine(line(a), a, 36), `…${a.slice(-35)}`);
	assert.equal(fitColdLine(line(b), b, 36), `…${b.slice(-35)}`);
	assert.notEqual(fitColdLine(line(a), a, 36), fitColdLine(line(b), b, 36));
	assert.equal(fitColdLine(line("google/gemini-2.5-flash"), "google/gemini-2.5-flash", 36), "google/gemini-2.5-flash · 1M window ");
	assert.equal(fitColdLine("off", "", 36), "off");
});

// Review 4b, round 2: ordinary English is counted near its size, so a big cold session can still fit a picked model. The
// paragraph below (from this README's "Compacting from the cache") is 122 tokens in OpenAI's o200k_base and 121 in
// cl100k_base, as gpt-tokenizer 3.4.0 counts it; the mixed count takes it at 155, 1.27 times.
test("review 4b: ordinary English prose is counted within 1.5 times its real size", () => {
	const prose =
		"Pi's compaction swaps the system prompt, drops the tools, and flattens the messages into text. None of that matches what the provider has cached, so every token of the summary request is billed at full price. It also cuts every tool result down to its first 2,000 characters, and the bigger the session, the more that throws away. Long sessions do their work in long outputs: whole files, test runs, build logs. The summarizer sees only the start of each one, so it misses the bottom of the file and the failures listed at the end of the test run.";
	const REAL = 122;
	const counted = coldTextTokens(prose);
	assert.ok(counted >= REAL, `${counted}: not counted low`);
	assert.ok(counted <= 1.5 * REAL, `${counted}: within 1.5 times`);
	assert.equal(counted, 155);
});
