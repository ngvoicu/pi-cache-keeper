import assert from "node:assert/strict";
import test from "node:test";
import * as piAi from "@earendil-works/pi-ai";
import { KEEP_WARM_CHOICES } from "../config.ts";
import {
	budgetReached,
	cachedShare,
	canReplay,
	formatUsd,
	gateAllows,
	keepWarmLabel,
	keepWarmRule,
	limitWithinCap,
	payloadThinking,
	payloadTier,
	REFRESH_LIMITS,
	reserveFor,
	refreshCanPay,
	requestCache,
	whyNotReplayable,
	ttlMs,
	spendingText,
	wantsWarm,
	warmBudget,
	warmLeadMs,
	warmPayload,
} from "../keep-warm.ts";

test("the extension refreshes after Pi's own warming would (10% of the lifetime) and before compacting before expiry", () => {
	assert.equal(warmLeadMs(3_600_000, 20_000), 180_000, "1-hour cache: 3 min before expiry; Pi refreshes at 6 min");
	assert.equal(warmLeadMs(1_800_000, 20_000), 90_000);
	assert.equal(warmLeadMs(300_000, 20_000), 25_000, "5-minute cache: 25 s before expiry; Pi refreshes at 30 s, compaction runs at 20 s");
});

// Per million tokens: Claude-like with a cache-write price, GPT-like without one, and a subscription login.
const model = (cost: { input: number; output: number; cacheRead: number; cacheWrite: number }) => ({ provider: "p", id: "m", api: "anthropic-messages", cost }) as never;
const WITH_WRITE = model({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
const WITHOUT_WRITE = model({ input: 2, output: 8, cacheRead: 0.2, cacheWrite: 0 });
const NO_PRICES = model({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

test("the budget is one cache miss, worked out as Pi's own warming does", () => {
	const claude = warmBudget(WITH_WRITE, 1_000_000);
	assert.equal(claude.priced, true);
	assert.ok(Math.abs(claude.refreshCost - (0.3 + 15 / 1e6)) < 1e-12, "the prompt at the cache-read price plus one output token");
	assert.ok(Math.abs(claude.missCost - (3.75 - 0.3)) < 1e-12, "the prompt at the cache-write price, less the read");
	const gpt = warmBudget(WITHOUT_WRITE, 1_000_000);
	assert.ok(Math.abs(gpt.missCost - (2 - 0.2)) < 1e-12, "without a cache-write price: the input price, less the read");
	assert.deepEqual(warmBudget(NO_PRICES, 1_000_000), { priced: false, refreshCost: 0, missCost: 0 });
	assert.equal(warmBudget(WITH_WRITE, 0).priced, false, "an unknown prompt size");
	const cheaperWrite = warmBudget(model({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0.1 }), 1_000_000);
	assert.equal(cheaperWrite.missCost, 0, "never below 0");
});

// pi-ai exports evaluateCacheWarming from 1.5.1; the extension does not import it, so older Pi loads it too.
const evaluateCacheWarming = (piAi as Record<string, unknown>).evaluateCacheWarming as
	| ((model: never, promptTokens: number, phase: "idle") => { warmCost: number; missCost: number; economicsAvailable: boolean })
	| undefined;
test("the budget matches Pi's own evaluateCacheWarming where the installed Pi has it", { skip: evaluateCacheWarming ? false : "the installed pi-ai has no evaluateCacheWarming (before 1.5.1)" }, () => {
	const tiered = model({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, tiers: [{ inputTokensAbove: 200_000, input: 6, output: 22.5, cacheRead: 0.6, cacheWrite: 7.5 }] } as never);
	const cheaperWrite = model({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0.1 });
	for (const m of [WITH_WRITE, WITHOUT_WRITE, NO_PRICES, tiered, cheaperWrite]) {
		for (const tokens of [0, 1, 20_000, 600_002, 1_000_000]) {
			const pi = evaluateCacheWarming!(m, tokens, "idle");
			const own = warmBudget(m, tokens);
			assert.deepEqual([own.refreshCost, own.missCost, own.priced], [pi.warmCost, pi.missCost, pi.economicsAvailable], `${tokens} tokens`);
		}
	}
});

test("the gate: what was spent plus the next refresh's reserve stays within one miss; without prices, within 10 refreshes", () => {
	// How many refreshes fit, each settling at its expected cost: the same for every lifetime.
	const fit = (budget: ReturnType<typeof warmBudget>) => {
		const spending = { spent: 0, refreshes: 0 };
		while (gateAllows(budget, spending)) {
			spending.spent += reserveFor(budget, spending);
			spending.refreshes++;
		}
		return spending.refreshes;
	};
	assert.equal(fit(warmBudget(WITH_WRITE, 600_000)), 11, "3.45 / 0.3 = 11.5");
	assert.equal(fit(warmBudget(WITHOUT_WRITE, 600_000)), 8, "1.8 / 0.2 = 9, and the output token tips the 9th over");
	assert.equal(fit(warmBudget(NO_PRICES, 600_000)), 10);
	const budget = warmBudget(WITH_WRITE, 600_000);
	// The reserve is the larger of the expected cost and what the last refresh really cost.
	assert.equal(reserveFor(budget, { spent: 0, refreshes: 0 }), budget.refreshCost);
	assert.equal(reserveFor(budget, { spent: 0.1, refreshes: 1, last: 0.1 }), budget.refreshCost, "a cheaper last refresh does not lower it");
	assert.equal(reserveFor(budget, { spent: 1.8, refreshes: 10, last: 0.28 }), 0.28);
	assert.equal(gateAllows(budget, { spent: 1.8, refreshes: 10, last: budget.refreshCost }), true);
	assert.equal(gateAllows(budget, { spent: 1.8, refreshes: 10, last: 0.28 }), false, "$1.80 + $0.28 passes $2.07");
	// After a settlement: at the limit or past it, warming ends.
	assert.equal(budgetReached(budget, { spent: budget.missCost - 0.01, refreshes: 11 }), false);
	assert.equal(budgetReached(budget, { spent: budget.missCost, refreshes: 11 }), true);
	assert.equal(budgetReached(warmBudget(NO_PRICES, 600_000), { spent: 10, refreshes: 10 }), true);
	assert.equal(spendingText(budget, { spent: 1.98, refreshes: 11 }), "$1.98 spent, a miss costs $2.07");
	assert.equal(spendingText(warmBudget(NO_PRICES, 600_000), { spent: 3, refreshes: 3 }), "3 of 10 refreshes");
});

test("the rule as the settings say it", () => {
	assert.equal(keepWarmRule(120, true), "up to 2 h after Pi goes idle; stops once refreshing has cost as much as one cache miss");
	assert.equal(keepWarmRule(120, false), "up to 2 h after Pi goes idle; at most 10 refreshes (this model has no prices, so the cost of a miss is unknown)");
	assert.equal(keepWarmRule(0, true), "off");
	assert.deepEqual([0, 0.0031, 0.14, 2.0700069].map(formatUsd), ["$0", "$0.0031", "$0.14", "$2.07"]);
});

test("the cache is kept warm only while it would otherwise cool inside the window after Pi went idle", () => {
	const idle = 0;
	assert.equal(wantsWarm(54 * 60_000, idle, 120), true);
	assert.equal(wantsWarm(119 * 60_000, idle, 120), true);
	assert.equal(wantsWarm(120 * 60_000, idle, 120), false, "the cache already lasts to the end of the window");
	assert.equal(wantsWarm(5 * 60_000, idle, 0), false, "off");
});

test("a request with Claude's budget-based thinking cannot be re-sent with a one-token answer; adaptive thinking and other APIs can", () => {
	assert.equal(canReplay({ model: "claude", thinking: { type: "enabled", budget_tokens: 8000 } }), false);
	assert.equal(canReplay({ model: "claude", thinking: { type: "adaptive" } }), true);
	assert.equal(canReplay({ model: "gpt", reasoning: { effort: "high" } }), true);
});

test("the warm-up re-sends the captured request unchanged except for the output limit the provider built", () => {
	const captured = { model: "claude", max_tokens: 64_000, system: "s", messages: [{ role: "user", content: "hi" }], thinking: { type: "adaptive" } };
	const built = warmPayload({ model: "other", max_tokens: 1, messages: [] }, captured);
	assert.deepEqual(built, { payload: { ...captured, max_tokens: 1 } });
	assert.equal(captured.max_tokens, 64_000, "the captured request is not changed");
	// Building takes the provider's limit keys as they are; whether they may leave is the last gate's check.
	assert.deepEqual(warmPayload({ input: [] }, { input: ["x"], max_output_tokens: 32_000 }), { payload: { input: ["x"] } }, "a limit the provider leaves out is dropped");
	assert.deepEqual(warmPayload({ max_output_tokens: 16 }, { input: ["x"] }), { payload: { input: ["x"], max_output_tokens: 16 } });
	assert.deepEqual(warmPayload("nope", captured), { reason: "the provider payload is not an object" });
});

test("the absolute cap: a refresh payload carries its limit in a known key, at most the API's proven refresh limit", () => {
	assert.deepEqual(REFRESH_LIMITS, { "anthropic-messages": 1, "openai-completions": 1, "openai-responses": 16 });
	assert.deepEqual(limitWithinCap("anthropic-messages", { max_tokens: 1 }), { ok: true });
	assert.deepEqual(limitWithinCap("openai-completions", { max_completion_tokens: 1 }), { ok: true });
	assert.deepEqual(limitWithinCap("openai-responses", { max_output_tokens: 16 }), { ok: true }, "16 is the minimum OpenAI Responses accepts");
	assert.deepEqual(limitWithinCap("anthropic-messages", { max_tokens: 1025 }), { reason: "the refresh would ask for up to 1025 output tokens (max_tokens), above the 1 a refresh of anthropic-messages may" });
	assert.match((limitWithinCap("anthropic-messages", { max_tokens: 16_385 }) as { reason: string }).reason, /16385/);
	assert.match((limitWithinCap("openai-responses", { max_output_tokens: 17 }) as { reason: string }).reason, /above the 16/);
	assert.match((limitWithinCap("openai-completions", { max_tokens: 1, max_completion_tokens: 8192 }) as { reason: string }).reason, /8192/, "every known key");
	assert.match((limitWithinCap("anthropic-messages", { max_tokens: "1" }) as { reason: string }).reason, /above the 1/, "not a number");
	for (const value of [-1, 0, 0.5]) assert.ok("reason" in limitWithinCap("anthropic-messages", { max_tokens: value }), `${value}: a positive integer only`);
	assert.deepEqual(limitWithinCap("anthropic-messages", { inferenceConfig: { maxTokens: 1 } }), { reason: "the refresh carries no output limit the extension knows, so it could generate a full answer" });
	assert.deepEqual(limitWithinCap("bedrock-converse-stream", { max_tokens: 1 }), { reason: "this API's requests are not re-sent by the extension (bedrock-converse-stream)" });
});

test("the thinking level of a refresh is read from the captured payload", () => {
	assert.equal(payloadThinking("anthropic-messages", { thinking: { type: "disabled" }, max_tokens: 64_000 }), "off");
	assert.equal(payloadThinking("anthropic-messages", { max_tokens: 64_000 }), "off");
	assert.equal(payloadThinking("anthropic-messages", { thinking: { type: "adaptive" }, output_config: { effort: "high" } }), "high");
	assert.equal(payloadThinking("anthropic-messages", { thinking: { type: "adaptive" }, output_config: { effort: "max" } }), "off", "no Pi level: off, the smallest limit");
	assert.equal(payloadThinking("openai-completions", { reasoning_effort: "low" }), "low");
	assert.equal(payloadThinking("openai-completions", {}), "off");
	assert.equal(payloadThinking("openai-responses", { reasoning: { effort: "medium" } }), "medium");
});

test("the cache a request asks for, from every marker wherever it sits (R8)", () => {
	assert.deepEqual([ttlMs("30m"), ttlMs("1h"), ttlMs("12h"), ttlMs("300s"), ttlMs("1d"), ttlMs(30)], [1_800_000, 3_600_000, 43_200_000, 300_000, null, null]);
	const read = (payload: Record<string, unknown>) => {
		const r = requestCache(payload);
		return { tier: r.tier, mixed: r.mixed, unreadable: r.unreadable, markers: r.markers.map((m) => `${m.at}=${m.tier ?? "-"}/${m.ms ?? "-"}`) };
	};
	const one = { type: "ephemeral", ttl: "1h" };
	const five = { type: "ephemeral" };
	assert.deepEqual(read({ input: [] }), { tier: "short", mixed: false, unreadable: undefined, markers: [] }, "no marker: the default cache");
	// Anthropic: top level, system, tools, message content; without ttl it is the 5-minute cache.
	assert.deepEqual(read({ cache_control: five }).markers, ["cache_control=short/300000"]);
	assert.deepEqual(read({ cache_control: { type: "ephemeral", ttl: "5m" } }).markers, ["cache_control=short/300000"]);
	const stock = { system: [{ type: "text", text: "s", cache_control: one }], tools: [{ name: "t", cache_control: one }], messages: [{ role: "user", content: [{ type: "text", text: "x", cache_control: one }] }] };
	assert.deepEqual(read(stock), {
		tier: "long",
		mixed: false,
		unreadable: undefined,
		markers: ["system[0].cache_control=long/3600000", "tools[0].cache_control=long/3600000", "messages[0].content[0].cache_control=long/3600000"],
	});
	const mixed = read({ system: [{ type: "text", text: "s", cache_control: one }], messages: [{ role: "user", content: [{ type: "text", text: "x", cache_control: five }] }] });
	assert.deepEqual([mixed.mixed, mixed.markers.length], [true, 2], "the reviewer's request: 1 h on the system prompt, the default on the conversation");
	assert.equal(read({ tools: [{ name: "t", cache_control: five }], cache_control: one }).mixed, true, "a tools marker counts");
	assert.match(read({ cache_control: { type: "ephemeral", ttl: "2h" } }).unreadable ?? "", /cache_control/);
	assert.match(read({ cache_control: "ephemeral" }).unreadable ?? "", /cache_control/);
	// OpenAI and Kimi.
	assert.deepEqual(read({ prompt_cache_retention: "24h" }).markers, ["prompt_cache_retention=long/-"]);
	assert.deepEqual(read({ prompt_cache_retention: "in_memory" }).tier, "short");
	assert.match(read({ prompt_cache_retention: "7d" }).unreadable ?? "", /prompt_cache_retention/);
	assert.deepEqual(read({ prompt_cache_retention: "24h", prompt_cache_options: { mode: "implicit", ttl: "1h" } }), {
		tier: "long",
		mixed: false,
		unreadable: undefined,
		markers: ["prompt_cache_retention=long/-", "prompt_cache_options.ttl=long/3600000"],
	}, "Kimi's long option");
	assert.deepEqual(read({ prompt_cache_options: { ttl: "30m" } }).markers, ["prompt_cache_options.ttl=short/1800000"], "OpenAI's explicit mode: the default cache, 30 minutes");
	const gpt = read({ prompt_cache_options: { ttl: "30m" }, input: [{ role: "developer", content: [{ type: "input_text", text: "s", prompt_cache_breakpoint: { mode: "explicit", ttl: "12h" } }] }] });
	assert.deepEqual([gpt.mixed, gpt.markers], [true, ["prompt_cache_options.ttl=short/1800000", "input[0].content[0].prompt_cache_breakpoint=-/43200000"]]);
	assert.deepEqual(read({ input: [{ prompt_cache_breakpoint: { mode: "explicit" } }] }).markers, [], "a breakpoint without its own ttl states nothing");
	assert.match(read({ prompt_cache_options: { ttl: "1d" } }).unreadable ?? "", /prompt_cache_options/);
	assert.equal(read({ prompt_cache_retention: "24h", cache_control: five }).mixed, true, "an extended and a default marker");
	// An unknown type or mode is not read as the default cache.
	assert.match(read({ cache_control: { type: "future-type" } }).unreadable ?? "", /future-type/);
	assert.match(read({ cache_control: { type: "future-type", ttl: "1h" } }).unreadable ?? "", /future-type/);
	assert.match(read({ prompt_cache_options: { mode: "future-mode" } }).unreadable ?? "", /future-mode/);
	assert.match(read({ input: [{ prompt_cache_breakpoint: { mode: "future-mode" } }] }).unreadable ?? "", /future-mode/);
	assert.deepEqual(read({ prompt_cache_options: { mode: "explicit" } }).markers, [], "a known mode without a ttl states nothing");
});

test("a refresh that cannot pay for itself; a reason for thinking by what the request carries", () => {
	assert.equal(refreshCanPay({ priced: true, refreshCost: 0.18, missCost: 2.07 }), true);
	assert.equal(refreshCanPay({ priced: true, refreshCost: 2.07, missCost: 2.07 }), false, "as much as a miss");
	assert.equal(refreshCanPay({ priced: true, refreshCost: 0.6, missCost: 0 }), false, "no discount at all");
	assert.equal(refreshCanPay({ priced: false, refreshCost: 0, missCost: 0 }), true, "without prices the budget counts refreshes");
	assert.equal(whyNotReplayable({ thinking: { type: "adaptive" } }), undefined);
	assert.equal(whyNotReplayable({ messages: [] }), undefined);
	assert.equal(whyNotReplayable({ thinking: { type: "enabled" } }), 'the request turns thinking on (thinking: { type: "enabled" }), which a refresh capped at one output token cannot re-send as it was');
	assert.match(whyNotReplayable({ thinking: { type: "enabled", budget_tokens: 1024 } }) ?? "", /with a budget of 1024 tokens/);
});

test("the cache tier a payload shows it was sent for", () => {
	const block = (ttl?: string) => ({ type: "text", text: "s", cache_control: { type: "ephemeral", ...(ttl ? { ttl } : {}) } });
	assert.equal(payloadTier("anthropic-messages", { system: [block("1h")], messages: [] }), "long");
	assert.equal(payloadTier("anthropic-messages", { system: [block()], messages: [{ role: "user", content: [block()] }] }), "short");
	assert.equal(payloadTier("anthropic-messages", { messages: [] }), undefined, "no cache_control: not shown");
	assert.equal(payloadTier("openai-completions", { prompt_cache_retention: "24h" }), "long");
	assert.equal(payloadTier("openai-completions", { prompt_cache_options: { mode: "implicit", ttl: "1h" } }), "long", "Kimi's long cache");
	assert.equal(payloadTier("openai-completions", { messages: [] }), undefined);
});

test("cached share and labels", () => {
	assert.equal(cachedShare({ input: 2, cacheRead: 692_000, cacheWrite: 0 }) > 0.99, true);
	assert.equal(cachedShare({ input: 0, cacheRead: 0, cacheWrite: 692_000 }), 0);
	assert.equal(cachedShare({ input: 0, cacheRead: 0, cacheWrite: 0 }), 0);
	assert.deepEqual([0, 30, 60, 90, 120, 480].map(keepWarmLabel), ["off", "30 min", "1 h", "1.5 h", "2 h", "8 h"]);
	assert.deepEqual(KEEP_WARM_CHOICES.map(keepWarmLabel), ["off", "30 min", "1 h", "2 h", "3 h", "4 h", "6 h", "8 h", "12 h", "24 h"]);
	// A value from the settings file that is not offered takes its place in the cycle, as the menu builds it.
	const withOwn = [...new Set([...KEEP_WARM_CHOICES, 90])].sort((a, b) => a - b).map(keepWarmLabel);
	assert.deepEqual(withOwn.slice(0, 5), ["off", "30 min", "1 h", "1.5 h", "2 h"]);
	assert.equal(new Set(withOwn).size, withOwn.length, "every label names one value");
});
