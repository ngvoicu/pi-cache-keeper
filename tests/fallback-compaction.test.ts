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
	fallbackAccess,
	fallbackModelLabel,
	fallbackModelParts,
	fallbackRowLayout,
	distinctModelName,
	modelSearchText,
	nameAccess,
	partsText,
	formatModelRef,
	orderFallbackChoices,
	OUTPUT_TOO_SMALL,
	parseModelRef,
	type FallbackChoice,
	type FallbackRow,
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
test("a menu line for each kind: priced, subscription, no price, window unknown, too small; as Pi's picker names a model, id then [provider]", () => {
	assert.equal(fallbackChoiceLabel(priced), "gemini-2.5-flash [google] · 1.05M window · $0.30 in, $2.50 out per M · holds this session");
	assert.equal(fallbackChoiceLabel(sub), "gpt-5.5 [openai-codex] · 272k window · subscription · holds this session");
	assert.equal(fallbackChoiceLabel(free), "qwen3 [ollama] · 200k window · no price · holds this session");
	assert.equal(fallbackChoiceLabel(unknown), "llama [local] · window unknown · no price · can't be used: it declares no context window");
	assert.equal(fallbackChoiceLabel(small), "claude-haiku-4-5 [anthropic] · 200k window · $1.00 in, $5.00 out per M · too small now (needs about 190k)");
	assert.equal(fallbackChoiceLabel({ ...priced, ref: "x/y", window: 1_000_000, price: { input: 0.075, output: 0.3 } }), "y [x] · 1M window · $0.075 in, $0.30 out per M · holds this session");
	assert.equal(fallbackChoiceLabel(virtual), "auto [pi] · window unknown · no price · can't be used: it is a virtual model");
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
test("review 3: the README's privacy note names the shell output sent in full", async () => {
	const { readFileSync } = await import("node:fs");
	const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
	const note = readme.split("\n").find((line) => line.startsWith("**Where your conversation goes.**")) ?? "";
	assert.match(note, /full output of shell commands you ran with `!`/);
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

// Blocker 2 and the price paragraph: what the README promises.
test("round 2, the README: the output cap is passed to Pi; the price comparison is for cached compactions only", async () => {
	const { readFileSync } = await import("node:fs");
	const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
	const fit = readme.split("\n").find((line) => line.startsWith("- The conversation and the summary don't fit it.")) ?? "";
	assert.match(fit, /That room is the output limit passed to Pi with the request; Pi's adapter sends it to the provider\./);
	assert.match(fit, /A request the provider then rejects falls back as any failed reply does\./);
	assert.doesNotMatch(readme, /so the request can't ask for more than the fit allowed/);
	assert.match(fit, /`can't be used: output limit too small`/);
	const card = readme.split("\n").find((line) => line.startsWith("**The card**")) ?? "";
	assert.match(card, /^\*\*The card\*\* .*For a compaction read from the cache, its second line compares it with what Pi's would have cost/);
	assert.match(card, /The comparison is for cached compactions only/);
});

// ------------------------------------------------------------- 0.10.4: each model as Pi's /model picker shows it

// pi-provimux 105.0.5's models (the service and the access in the name) beside a plain anthropic one, as the list has them.
const holds = fallbackFit({ contextWindow: 1_000_000, maxTokens: 128_000 }, 150_000);
const opus = { window: 1_000_000, price: { input: 5, output: 25 }, fit: holds };
const PROVIMUX: FallbackChoice[] = [
	{ ref: "provimux/claude-opus-5-5", name: "Claude Opus 5.5 · Anthropic sub, fallback api", subscription: true, ...opus },
	{ ref: "provimux/devin/claude-opus-5-5", name: "Claude Opus 5.5 (Devin) · Devin sub", subscription: false, ...opus },
	{ ref: "provimux/anthropic/claude-opus-5.5", name: "Claude Opus 5.5 · OpenRouter api", subscription: false, ...opus },
];
const ANTHROPIC: FallbackChoice = { ref: "anthropic/claude-opus-4-5", name: "Claude Opus 4.5 (latest)", subscription: false, window: 200_000, price: { input: 5, output: 25 }, fit: holds };
const rowOf = (choice: FallbackChoice): FallbackRow => ({ ref: choice.ref, name: choice.name, rest: fallbackChoiceParts(choice) });

test("0.10.4: the name is shown as Pi's picker shows it, the same function as Pi's; a name that only restates the id is not", async () => {
	const pi = await import("@earendil-works/pi-coding-agent/dist/modes/interactive/model-search.js" as string).catch(() => undefined);
	const cases = [
		{ id: "claude-opus-5-5", name: "Claude Opus 5.5 · Anthropic sub, fallback api" },
		{ id: "devin/claude-opus-5-5", name: "Claude Opus 5.5 (Devin) · Devin sub" },
		{ id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5 · OpenRouter api" },
		{ id: "claude-opus-4-5", name: "Claude Opus 4.5 (latest)" },
		{ id: "claude-opus-4-5", name: "Claude Opus 4.5" },
		{ id: "eu.anthropic.claude-sonnet-4-5-20250929-v1:0", name: "Claude Sonnet 4.5 (EU)" },
		{ id: "mistral-small-2603", name: "Mistral Small 4" },
		{ id: "gpt-5.5", name: undefined },
		{ id: "gpt-5.5", name: "  " },
	];
	assert.equal(distinctModelName(cases[0]), "Claude Opus 5.5 · Anthropic sub, fallback api");
	assert.equal(distinctModelName(cases[4]), undefined, "a name that restates the id");
	assert.equal(distinctModelName(cases[5]), undefined, "Pi's own example: a dropped namespace and version");
	assert.equal(distinctModelName(cases[6]), "Mistral Small 4");
	for (const item of cases) {
		assert.equal(modelSearchText({ ...item, provider: "provimux" }), `provimux provimux/${item.id} provimux ${item.id}${item.name ? ` ${item.name}` : ""}`);
		// Where the installed Pi has its module (1.6.0 does), the same answers as Pi's own.
		if (pi?.getDistinctModelName) assert.equal(distinctModelName(item), pi.getDistinctModelName(item), item.id);
		if (pi?.getModelSelectorSearchText) assert.equal(modelSearchText({ ...item, provider: "provimux" }), pi.getModelSelectorSearchText({ ...item, provider: "provimux" }), item.id);
	}
});

test("0.10.4: a row is `model-id (Name) [provider] · window · price · fit`; the access part is left out where the name states one it would contradict", () => {
	assert.deepEqual(PROVIMUX.map(fallbackChoiceLabel), [
		// pi-cache-keeper has it as a subscription; the name says a failed request falls back to an API key.
		"claude-opus-5-5 (Claude Opus 5.5 · Anthropic sub, fallback api) [provimux] · 1M window · holds this session",
		// pi-cache-keeper would show its price; the name says it is a Devin subscription.
		"devin/claude-opus-5-5 (Claude Opus 5.5 (Devin) · Devin sub) [provimux] · 1M window · holds this session",
		// Both say an API key: the price stays.
		"anthropic/claude-opus-5.5 (Claude Opus 5.5 · OpenRouter api) [provimux] · 1M window · $5.00 in, $25.00 out per M · holds this session",
	]);
	assert.equal(fallbackChoiceLabel(ANTHROPIC), "claude-opus-4-5 (Claude Opus 4.5 (latest)) [anthropic] · 200k window · $5.00 in, $25.00 out per M · holds this session");
	assert.equal(fallbackChoiceLabel({ ...ANTHROPIC, name: "Claude Opus 4.5" }), "claude-opus-4-5 [anthropic] · 200k window · $5.00 in, $25.00 out per M · holds this session");
	// The rule, both ways: a name that says nothing leaves this extension's own value.
	assert.deepEqual(nameAccess("Claude Opus 5.5 · Anthropic sub, fallback api"), { sub: true, api: true });
	assert.deepEqual(nameAccess("Claude Opus 5.5 (Devin) · Devin sub"), { sub: true, api: false });
	assert.deepEqual(nameAccess("Claude Opus 5.5 · OpenRouter api"), { sub: false, api: true });
	assert.deepEqual(nameAccess("Claude Opus 4.5"), { sub: false, api: false });
	const price = { input: 5, output: 25 };
	assert.equal(fallbackAccess({ name: "X · Devin sub", subscription: true, price }), "subscription", "both say a subscription");
	assert.equal(fallbackAccess({ name: "X · OpenRouter api", subscription: true, price }), undefined, "a subscription beside a name that says api");
	assert.equal(fallbackAccess({ name: "X · OpenRouter api", subscription: false }), "no price");
	assert.equal(fallbackAccess({ name: "X · Devin sub", subscription: false }), undefined, "no price beside a name that says sub");
	assert.equal(fallbackAccess({ name: "Gemini 2.5 Flash", subscription: false, price }), "$5.00 in, $25.00 out per M");
	assert.equal(fallbackAccess({ subscription: true }), "subscription");
	// /cache-keeper shows the picked model's parts by the same rule.
	assert.deepEqual(fallbackModelParts(PROVIMUX[1]), ["1M window"]);
	assert.deepEqual(fallbackModelParts(PROVIMUX[2]), ["1M window", "$5.00 in, $25.00 out per M"]);
});

// The list's rows at 80 and 120 columns: 6 columns go to the marks (2 + 2) and the free margin (2).
test("0.10.4: at 80 and 120 columns the id, the name and the badge stay whole; the window, access and fit are cut first, the fit kept longest", () => {
	const rows = [...PROVIMUX, ANTHROPIC].map(rowOf) as { ref: string; name?: string; rest: string[] }[];
	const lines = (width: number) => rows.map((row) => fallbackRowLayout(row, width).map(partsText));
	assert.deepEqual(lines(114), [
		["claude-opus-5-5 (Claude Opus 5.5 · Anthropic sub, fallback api) [provimux] · 1M window · holds this session"],
		["devin/claude-opus-5-5 (Claude Opus 5.5 (Devin) · Devin sub) [provimux] · 1M window · holds this session"],
		// The price, too wide to keep beside the fit, goes first.
		["anthropic/claude-opus-5.5 (Claude Opus 5.5 · OpenRouter api) [provimux] · 1M window · holds this session"],
		// Here the window goes: the price and the fit fit, the three don't.
		["claude-opus-4-5 (Claude Opus 4.5 (latest)) [anthropic] · $5.00 in, $25.00 out per M · holds this session"],
	]);
	assert.deepEqual(lines(74), [
		["claude-opus-5-5 (Claude Opus 5.5 · Anthropic sub, fallback api) [provimux]"],
		["devin/claude-opus-5-5 (Claude Opus 5.5 (Devin) · Devin sub) [provimux]"],
		["anthropic/claude-opus-5.5 (Claude Opus 5.5 · OpenRouter api) [provimux]"],
		// The fit alone, one column short: cut at its end.
		["claude-opus-4-5 (Claude Opus 4.5 (latest)) [anthropic] · holds this sessi…"],
	]);
	// Narrower: the name and the badge go whole onto the next line, indented, rather than being cut.
	assert.deepEqual(lines(54), [
		["claude-opus-5-5", "  (Claude Opus 5.5 · Anthropic sub, fallback api)", "  [provimux] · 1M window · holds this session"],
		["devin/claude-opus-5-5", "  (Claude Opus 5.5 (Devin) · Devin sub) [provimux]"],
		["anthropic/claude-opus-5.5", "  (Claude Opus 5.5 · OpenRouter api) [provimux]"],
		["claude-opus-4-5 (Claude Opus 4.5 (latest)) [anthropic]"],
	]);
	// A name wider than a whole line is broken between its words, never inside one.
	assert.deepEqual(lines(34)[0], ["claude-opus-5-5 (Claude Opus 5.5 ·", "  Anthropic sub, fallback api)", "  [provimux] · holds this session"]);
	for (const width of [114, 74, 54, 34, 20]) {
		const drawn = lines(width);
		for (const row of drawn) for (const line of row) assert.ok(line.length <= width, `${width}: ${line}`);
		// Joined again, each row holds its id, its name and its badge whole, in that order.
		drawn.forEach((row, i) => {
			const text = row.map((line, at) => (at === 0 ? line : line.slice(2))).join(" ");
			const parsed = parseModelRef(rows[i].ref) as { provider: string; id: string };
			const head = [parsed.id, ...(distinctModelName({ id: parsed.id, name: rows[i].name }) ? [`(${rows[i].name})`] : []), `[${parsed.provider}]`].join(" ");
			assert.ok(text.replace(/ +/g, " ").startsWith(head) || text.replace(/\s/g, "").startsWith(head.replace(/\s/g, "")), `${width}: ${text}`);
		});
		assert.equal(new Set(drawn.map((row) => row.join("\n"))).size, drawn.length, `${width}: every row reads differently`);
	}
});

test("0.10.4: the Bedrock rows that read alike when shortened stay whole and distinct, wrapping at 40 and 60 columns", () => {
	const fit = fallbackFit({ contextWindow: 200_000, maxTokens: 64_000 }, 1_000);
	const rows = ["eu", "us"].map((region): FallbackRow => rowOf({ ref: `amazon-bedrock/${region}.anthropic.claude-haiku-4-5-20251001-v1:0`, name: `Claude Haiku 4.5 (${region.toUpperCase()})`, subscription: false, window: 200_000, price: { input: 1.1, output: 5.5 }, fit }));
	assert.deepEqual(fallbackRowLayout(rows[0], 54).map(partsText), ["eu.anthropic.claude-haiku-4-5-20251001-v1:0", "  [amazon-bedrock] · 200k window · holds this session"]);
	// An id wider than the line goes on where the line ends; the badge stays whole beside its end.
	assert.deepEqual(fallbackRowLayout(rows[1], 34).map(partsText), ["us.anthropic.claude-haiku-4-5-2025", "  1001-v1:0 [amazon-bedrock]"]);
	for (const width of [34, 54]) assert.notDeepEqual(fallbackRowLayout(rows[0], width).map(partsText), fallbackRowLayout(rows[1], width).map(partsText));
});

test("0.10.4: the list is searched as Pi's picker searches, by provider, id and name: provimux, devin and openrouter filter it", async () => {
	const { fuzzyFilter } = await import("@earendil-works/pi-tui");
	const all = [...PROVIMUX, ANTHROPIC, priced];
	const search = (query: string) =>
		fuzzyFilter(all, query, (choice) => {
			const parsed = parseModelRef(choice.ref) as { provider: string; id: string };
			return modelSearchText({ ...parsed, name: choice.name });
		}).map((choice) => choice.ref);
	assert.deepEqual(search("provimux").sort(), PROVIMUX.map((choice) => choice.ref).sort(), "by provider");
	assert.equal(search("devin")[0], "provimux/devin/claude-opus-5-5", "by id and name, the Devin model first");
	assert.ok(!search("devin").includes("anthropic/claude-opus-4-5"));
	assert.deepEqual(search("openrouter"), ["provimux/anthropic/claude-opus-5.5"], "by name only: the id doesn't say OpenRouter");
	assert.deepEqual(search("fallback api"), ["provimux/claude-opus-5-5"]);
	assert.deepEqual(search("google"), ["google/gemini-2.5-flash"]);
});

test("0.10.4: the picked model is shown as `model-id [provider]`; the saved value stays provider/id, old values read the same", () => {
	assert.equal(fallbackModelLabel("provimux/devin/claude-opus-5-5"), "devin/claude-opus-5-5 [provimux]");
	assert.equal(fallbackModelLabel("google/gemini-2.5-flash"), "gemini-2.5-flash [google]");
	assert.equal(fallbackModelLabel("amazon-bedrock/eu.anthropic.claude-haiku-4-5-20251001-v1:0"), "eu.anthropic.claude-haiku-4-5-20251001-v1:0 [amazon-bedrock]");
	// Not a reference: as it is.
	assert.equal(fallbackModelLabel("gemini"), "gemini");
	assert.deepEqual(parseModelRef("provimux/devin/claude-opus-5-5"), { provider: "provimux", id: "devin/claude-opus-5-5" });
	assert.equal(formatModelRef({ provider: "provimux", id: "devin/claude-opus-5-5" }), "provimux/devin/claude-opus-5-5");
});
