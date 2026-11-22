// The pure module of the fallback compaction model (design/fallback-compaction-model.md, section 7, tests 1 to 5).
import assert from "node:assert/strict";
import test from "node:test";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import {
	FALLBACK_PROMPT_TOKENS,
	fallbackChoiceLabel,
	fallbackChoiceParts,
	fallbackFit,
	fallbackModelFit,
	fallbackNeedTokens,
	fallbackRowLines,
	fallbackRequestTokens,
	fallbackTextTokens,
	fallbackUnusable,
	fitFallbackLine,
	formatModelRef,
	orderFallbackChoices,
	OUTPUT_TOO_SMALL,
	parseModelRef,
	shortenModelRef,
	type FallbackChoice,
} from "../fallback-compaction.ts";

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
const asText = (messages: unknown[]) => fallbackTextTokens(serializeConversation(convertToLlm(messages as never)));

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
	const one = fallbackRequestTokens({ messagesToSummarize: history, turnPrefixMessages: [], isSplitTurn: false, previousSummary: undefined });
	assert.equal(one.length, 1);
	assert.equal(one[0], asText(history) + FALLBACK_PROMPT_TOKENS);
	assert.ok(asText(history) < 1_100, "the 10,000-character tool result is counted cut to 2,000 characters");
	const summary = "word ".repeat(500);
	const withSummary = fallbackRequestTokens({ messagesToSummarize: history, turnPrefixMessages: [], isSplitTurn: false, previousSummary: summary }, "focus on tests");
	assert.equal(withSummary[0], one[0] + fallbackTextTokens(summary) + fallbackTextTokens("\n\nAdditional focus: focus on tests"));
	const prefix = [user("Then the next."), assistant("On it.")];
	const split = fallbackRequestTokens({ messagesToSummarize: history, turnPrefixMessages: prefix, isSplitTurn: true, previousSummary: summary });
	assert.deepEqual(split, [one[0] + fallbackTextTokens(summary), asText(prefix) + FALLBACK_PROMPT_TOKENS], "the history (with the previous summary), then the turn's prefix (without)");
	// A split turn with no earlier history sends only the prefix.
	assert.deepEqual(fallbackRequestTokens({ messagesToSummarize: [], turnPrefixMessages: prefix, isSplitTurn: true, previousSummary: undefined }), [asText(prefix) + FALLBACK_PROMPT_TOKENS]);
	assert.equal(fallbackNeedTokens([3_000, 3_001]), 3_001, "the larger request");
	assert.equal(fallbackNeedTokens([]), 0);
});

// The mixed count itself (review 4b, round 2): an ASCII word up to 20 characters counts its length / 3 (at least 1);
// any other word counts its UTF-8 bytes; whitespace counts nothing.
test("the mixed count: short ASCII words at a third of their length, at least one; long or non-ASCII words at a token a byte", () => {
	assert.equal(fallbackTextTokens(""), 0);
	assert.equal(fallbackTextTokens("a"), 1, "at least one");
	assert.equal(fallbackTextTokens("abcdef"), 2);
	assert.equal(fallbackTextTokens("ab cd ef"), 3, "each word at least one");
	assert.equal(fallbackTextTokens("abcdefghijklmnopqrst"), 7, "20 characters: a third");
	assert.equal(fallbackTextTokens("abcdefghijklmnopqrstu"), 21, "21 characters: a token a character");
	assert.equal(fallbackTextTokens("é中"), 5, "non-ASCII: a token a byte (2 + 3)");
	assert.equal(fallbackTextTokens("  abc \n\t def  "), 2, "whitespace splits and counts nothing");
});

// 3
test("the fit rule: fits, too small, window unknown, an output limit under 16k, and the larger of two requests decides", () => {
	assert.deepEqual(fallbackFit({ contextWindow: 1_000_000, maxTokens: 65_536 }, 150_000), { fits: true, need: 150_000, window: 1_000_000, maxTokens: 65_536 });
	assert.deepEqual(fallbackFit({ contextWindow: 200_000, maxTokens: 64_000 }, 170_000), { fits: true, need: 170_000, window: 200_000, maxTokens: 26_000 }, "the cap sent: what the window leaves");
	const reserved = fallbackFit({ contextWindow: 200_000, maxTokens: 64_000 }, 170_000, 2_048);
	assert.equal(reserved.fits ? reserved.maxTokens : undefined, 23_952, "less the thinking reserve");
	assert.equal(fallbackFit({ contextWindow: 200_000, maxTokens: 64_000 }, 180_000, 2_048).fits, false, "16k of room, less 2k of thinking");
	assert.deepEqual(fallbackFit({ contextWindow: 200_000, maxTokens: 64_000 }, 260_000), { fits: false, why: "it needs about 260k tokens and its window is 200k", need: 260_000, window: 200_000 });
	// Room for the summary: 200k - 182k - 4k = 14k, under 16k.
	assert.equal(fallbackFit({ contextWindow: 200_000, maxTokens: 64_000 }, 182_000).fits, false);
	assert.equal(fallbackFit({ contextWindow: 200_000, maxTokens: 64_000 }, 180_000).fits, true, "16k of room is enough");
	assert.deepEqual(fallbackFit({ contextWindow: 0, maxTokens: 8_000 }, 1_000), { fits: false, why: "it declares no context window", need: 1_000 });
	// An output limit under 16k: the whole limit is enough.
	assert.equal(fallbackFit({ contextWindow: 128_000, maxTokens: 8_192 }, 110_000).fits, true);
	assert.equal(fallbackFit({ contextWindow: 128_000, maxTokens: 8_192 }, 117_000).fits, false, "7k of room, under its 8k limit");
	// Two requests: the larger decides.
	const need = fallbackNeedTokens([150_000, 200_000]);
	assert.equal(need, 200_000);
	assert.equal(fallbackFit({ contextWindow: 200_000, maxTokens: 32_000 }, need).fits, false);
	assert.equal(fallbackFit({ contextWindow: 400_000, maxTokens: 32_000 }, need).fits, true);
	assert.equal(fallbackUnusable({ api: "pi-virtual" }), "it is a virtual model");
	assert.equal(fallbackUnusable({ api: "claude-bridge" }), "it runs through pi-claude-bridge");
	assert.equal(fallbackUnusable({ api: "google-generative-ai" }), undefined);
});

const priced: FallbackChoice = { ref: "google/gemini-2.5-flash", window: 1_048_576, price: { input: 0.3, output: 2.5 }, subscription: false, fit: fallbackFit({ contextWindow: 1_048_576, maxTokens: 65_536 }, 150_000) };
const sub: FallbackChoice = { ref: "openai-codex/gpt-5.5", window: 272_000, price: { input: 1.25, output: 10 }, subscription: true, fit: fallbackFit({ contextWindow: 272_000, maxTokens: 128_000 }, 150_000) };
const free: FallbackChoice = { ref: "ollama/qwen3", window: 200_000, subscription: false, fit: fallbackFit({ contextWindow: 200_000, maxTokens: 32_000 }, 150_000) };
const unknown: FallbackChoice = { ref: "local/llama", subscription: false, fit: fallbackFit({ contextWindow: 0, maxTokens: 0 }, 150_000) };
const small: FallbackChoice = { ref: "anthropic/claude-haiku-4-5", window: 200_000, price: { input: 1, output: 5 }, subscription: false, fit: fallbackFit({ contextWindow: 200_000, maxTokens: 64_000 }, 190_000) };
const virtual: FallbackChoice = { ref: "pi/auto", subscription: false, unusable: "it is a virtual model" };

// 4
test("a menu line for each kind: priced, subscription, no price, window unknown, too small", () => {
	assert.equal(fallbackChoiceLabel(priced), "google/gemini-2.5-flash · 1.05M window · $0.30 in, $2.50 out per M · holds this session");
	assert.equal(fallbackChoiceLabel(sub), "openai-codex/gpt-5.5 · 272k window · subscription · holds this session");
	assert.equal(fallbackChoiceLabel(free), "ollama/qwen3 · 200k window · no price · holds this session");
	assert.equal(fallbackChoiceLabel(unknown), "local/llama · window unknown · no price · can't be used: it declares no context window");
	assert.equal(fallbackChoiceLabel(small), "anthropic/claude-haiku-4-5 · 200k window · $1.00 in, $5.00 out per M · too small now (needs about 190k)");
	assert.equal(fallbackChoiceLabel({ ...priced, ref: "x/y", window: 1_000_000, price: { input: 0.075, output: 0.3 } }), "x/y · 1M window · $0.075 in, $0.30 out per M · holds this session");
	assert.equal(fallbackChoiceLabel(virtual), "pi/auto · window unknown · no price · can't be used: it is a virtual model");
});

// 5
test("the order of the list: the ones that hold this session first, subscriptions, then by input price, then without a price; names break ties", () => {
	const cheap = { ...priced, ref: "google/gemini-2.5-flash-lite", price: { input: 0.1, output: 0.4 } };
	const twin = { ...priced, ref: "a/gemini-2.5-flash" };
	const order = orderFallbackChoices([virtual, small, free, priced, unknown, sub, cheap, twin]).map((c) => c.ref);
	assert.deepEqual(order, ["openai-codex/gpt-5.5", "google/gemini-2.5-flash-lite", "a/gemini-2.5-flash", "google/gemini-2.5-flash", "ollama/qwen3", "anthropic/claude-haiku-4-5", "local/llama", "pi/auto"]);
});

// Finding 4b (review, rounds 1 and 2): dense text. Measured with OpenAI's tokenizers (gpt-tokenizer 3.4.0): the reviewer's
// base64 attachment (221,872 characters) is 151,599 tokens in o200k_base; 20,000 rare CJK characters are 46,512 tokens in
// cl100k_base (46,648 for this string alone; 2.3 tokens a character). Both are words the mixed count takes at a token a
// byte, so both are counted high.
test("review 4b: dense text is counted high enough to be refused where it doesn't fit: the reviewer's base64, and CJK", async () => {
	const { createHash } = await import("node:crypto");
	const blob = Buffer.concat(Array.from({ length: 2600 }, (_, i) => createHash("sha256").update(`capture ${i}`).digest())).toString("base64");
	const base64 = fallbackNeedTokens(fallbackRequestTokens({ messagesToSummarize: [user(`This is the diagnostic attachment as base64:\n${blob}\n${blob}`)], turnPrefixMessages: [], isSplitTurn: false, previousSummary: undefined }));
	assert.ok(base64 >= 151_599, `${base64}`);
	assert.equal(fallbackFit({ contextWindow: 128_000, maxTokens: 16_384 }, base64).fits, false, "gpt-4o-mini's window: refused");
	const rare = Array.from({ length: 20_000 }, (_, i) => String.fromCodePoint(0x4e00 + ((i * 7919) % 20_000))).join("");
	const cjk = fallbackNeedTokens(fallbackRequestTokens({ messagesToSummarize: [user(rare)], turnPrefixMessages: [], isSplitTurn: false, previousSummary: undefined }));
	assert.ok(cjk >= 46_648, `${cjk}`);
	assert.equal(fallbackFit({ contextWindow: 50_000, maxTokens: 8_192 }, cjk).fits, false, "a 50k window can't hold 46k tokens of CJK");
});

// Finding 3 (review, round 1): the README says plainly what reaches the picked model's provider.
test("review 3: the README's privacy note names the shell output sent in full and, on older Pi, the thinking", async () => {
	const { readFileSync } = await import("node:fs");
	const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
	const note = readme.split("\n").find((line) => line.startsWith("**Where your conversation goes.**")) ?? "";
	assert.match(note, /full output of shell commands you ran with `!`/);
	assert.match(note, /on Pi before 1\.2, the assistant's thinking/);
});

// Finding 10 (review, round 1), and 3 (round 2): a line too wide for the terminal shortens a model id that doesn't fit in
// the middle, keeping the provider, the start of the id and its end.
test("review 10: fitting a menu line shortens a long model id in the middle, and cuts the rest of a line whose id fits", () => {
	const a = "amazon-bedrock/anthropic.claude-sonnet-4-5-20250929-v1:0";
	const b = "amazon-bedrock/anthropic.claude-sonnet-4-6";
	const line = (ref: string) => `${ref} · 1M window · $3.30 in, $16.50 out per M · holds this session`;
	assert.equal(fitFallbackLine(line(a), a, 36), "amazon-bedrock/anthrop…20250929-v1:0");
	assert.equal(fitFallbackLine(line(b), b, 36), "amazon-bedrock/anthrop…de-sonnet-4-6");
	assert.notEqual(fitFallbackLine(line(a), a, 36), fitFallbackLine(line(b), b, 36));
	assert.equal(fitFallbackLine(line("google/gemini-2.5-flash"), "google/gemini-2.5-flash", 36), "google/gemini-2.5-flash · 1M window ");
	assert.equal(fitFallbackLine("off", "", 36), "off");
});

// Review 4b, round 2: ordinary English is counted near its size, so a big cold session can still fit a picked model. The
// paragraph below (from this README's "Compacting from the cache") is 122 tokens in OpenAI's o200k_base and 121 in
// cl100k_base, as gpt-tokenizer 3.4.0 counts it; the mixed count takes it at 155, 1.27 times.
test("review 4b: ordinary English prose is counted within 1.5 times its real size", () => {
	const prose =
		"Pi's compaction swaps the system prompt, drops the tools, and flattens the messages into text. None of that matches what the provider has cached, so every token of the summary request is billed at full price. It also cuts every tool result down to its first 2,000 characters, and the bigger the session, the more that throws away. Long sessions do their work in long outputs: whole files, test runs, build logs. The summarizer sees only the start of each one, so it misses the bottom of the file and the failures listed at the end of the test run.";
	const REAL = 122;
	const counted = fallbackTextTokens(prose);
	assert.ok(counted >= REAL, `${counted}: not counted low`);
	assert.ok(counted <= 1.5 * REAL, `${counted}: within 1.5 times`);
	assert.equal(counted, 155);
});

// ------------------------------------------------------------------- the review's findings (0.10.0, round 2)

// Blocker 1: one fit for the list and the compaction. A model whose output limit, less what its lowest thinking level
// adds, can never reach the summary's minimum can't be used, whatever the session's size.
test("round 2, blocker 1: one fit; an output limit that can never leave room for a summary is \"output limit too small\"", () => {
	// Cloudflare's gpt-oss-120b in Pi 1.6.0: 16,384 out, thinking at least low (2,048).
	const gptOss = { provider: "cloudflare-workers-ai", id: "@cf/openai/gpt-oss-120b", api: "openai-completions", reasoning: true, contextWindow: 128_000, maxTokens: 16_384, thinkingLevelMap: { off: null, minimal: null } } as never;
	for (const need of [715, 50_000]) {
		const { fit, thinking } = fallbackModelFit(gptOss, need);
		assert.equal(thinking, "low");
		assert.deepEqual(fit, { fits: false, why: OUTPUT_TOO_SMALL, need, window: 128_000, never: true }, String(need));
		assert.equal(fallbackChoiceParts({ ref: "x/y", subscription: false, window: 128_000, fit }).at(-1), "can't be used: output limit too small");
	}
	// The same model with thinking off holds a small session, with its whole output limit as the cap.
	assert.deepEqual(fallbackModelFit({ ...(gptOss as object), thinkingLevelMap: undefined } as never, 715).fit, { fits: true, need: 715, window: 128_000, maxTokens: 16_384 });
	// An output limit under 16k with no thinking: the whole limit is enough, as before.
	assert.equal(fallbackFit({ contextWindow: 128_000, maxTokens: 8_192 }, 715).fits, true);
	assert.equal(fallbackFit({ contextWindow: 128_000, maxTokens: 8_192 }, 715, 1_024).fits, false);
	assert.equal((fallbackFit({ contextWindow: 128_000, maxTokens: 8_192 }, 715, 1_024) as { never?: true }).never, true);
	// Too small now is not never.
	const now = fallbackFit({ contextWindow: 200_000, maxTokens: 64_000 }, 260_000);
	assert.equal((now as { never?: true }).never, undefined);
	// The list orders never with the models that can't be used.
	const never: FallbackChoice = { ref: "a/never", subscription: true, window: 128_000, fit: fallbackModelFit(gptOss, 715).fit };
	const fits: FallbackChoice = { ref: "b/fits", subscription: false, window: 128_000, price: { input: 9, output: 9 }, fit: fallbackFit({ contextWindow: 128_000, maxTokens: 64_000 }, 715) };
	const small: FallbackChoice = { ref: "c/small", subscription: false, window: 128_000, price: { input: 9, output: 9 }, fit: fallbackFit({ contextWindow: 128_000, maxTokens: 64_000 }, 260_000) };
	assert.deepEqual(orderFallbackChoices([never, small, fits]).map((c) => c.ref), ["b/fits", "c/small", "a/never"]);
});

// Blocker 3: a long id is shortened in the middle, keeping the provider, the start of the id and its end; where no single
// cut tells two references apart, the rows show the whole id.
test("round 2, blocker 3: shortened in the middle, the cut placed so no other reference reads the same; rows still alike show the whole id", () => {
	const eu = "amazon-bedrock/eu.anthropic.claude-haiku-4-5-20251001-v1:0";
	const us = "amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0";
	assert.equal(shortenModelRef(eu, 36, [eu, us]), "amazon-bedrock/eu.anth\u202620251001-v1:0");
	assert.equal(shortenModelRef(us, 36, [eu, us]), "amazon-bedrock/us.anth\u202620251001-v1:0");
	// The cut moves where the third doesn't tell two apart.
	const a = "amazon-bedrock/meta.llama3-1-70b-instruct-v1:0";
	const b = "amazon-bedrock/meta.llama3-1-8b-instruct-v1:0";
	const [sa, sb] = [shortenModelRef(a, 36, [a, b]), shortenModelRef(b, 36, [a, b])];
	assert.notEqual(sa, sb);
	for (const s of [sa, sb]) {
		assert.equal(s.length, 36);
		assert.match(s, /^amazon-bedrock\/meta.*\u2026.*-instruct-v1:0$/);
	}
	// A reference that fits is left whole; a provider too long to keep leaves the end.
	assert.equal(shortenModelRef("google/gemini-2.5-flash", 36), "google/gemini-2.5-flash");
	assert.equal(shortenModelRef("a-very-long-provider-name-indeed-yes/model-x", 20), "\u2026-indeed-yes/model-x");
	// Two references no single cut tells apart at 36 columns: those rows show the whole id, then the rest of the row.
	const q6 = "qwen-token-plan-individual-cn/qwen3.6-flash";
	const q8 = "qwen-token-plan-individual-cn/qwen3.8-flash";
	const label = (ref: string) => `${ref} \u00b7 1M window \u00b7 no price \u00b7 holds this session`;
	const rows = fallbackRowLines([{ label: "off", ref: "" }, { label: label(q6), ref: q6 }, { label: label(q8), ref: q8 }, { label: label(eu), ref: eu }, { label: label(us), ref: us }], 36);
	assert.deepEqual(rows[0], ["off"]);
	assert.deepEqual(rows[1], ["qwen-token-plan-individual-cn/qwen3.", "6-flash", "1M window \u00b7 no price \u00b7 holds this se"]);
	assert.deepEqual(rows[2], ["qwen-token-plan-individual-cn/qwen3.", "8-flash", "1M window \u00b7 no price \u00b7 holds this se"]);
	assert.deepEqual(rows[3], ["amazon-bedrock/eu.anth\u202620251001-v1:0"]);
	assert.deepEqual(rows[4], ["amazon-bedrock/us.anth\u202620251001-v1:0"]);
	for (const row of rows) for (const line of row) assert.ok(line.length <= 36, line);
});

// Blocker 2 and the price paragraph: what the README promises.
test("round 2, the README: the output cap is passed to Pi and some older adapters don't send it; the price comparison is for cached compactions only", async () => {
	const { readFileSync } = await import("node:fs");
	const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
	const fit = readme.split("\n").find((line) => line.startsWith("- The conversation and the summary don't fit it.")) ?? "";
	assert.match(fit, /That room is the output limit passed to Pi with the request; Pi's adapter sends it to the provider, except some adapters of older Pi versions, which leave it out/);
	assert.match(fit, /A request the provider then rejects falls back as any failed reply does\./);
	assert.doesNotMatch(readme, /so the request can't ask for more than the fit allowed/);
	assert.match(fit, /`can't be used: output limit too small`/);
	const card = readme.split("\n").find((line) => line.startsWith("**The card**")) ?? "";
	assert.match(card, /^\*\*The card\*\* .*For a compaction read from the cache, its second line compares it with what Pi's would have cost/);
	assert.match(card, /The comparison is for cached compactions only/);
});
