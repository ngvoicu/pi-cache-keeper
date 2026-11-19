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
	reserveFor,
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
	// Never a refresh whose output is not capped: no known limit key from the provider, or the captured value again.
	const uncapped = { reason: "the provider did not build a capped output limit the extension knows, so the refresh could generate a full answer" };
	assert.deepEqual(warmPayload({ input: [] }, { input: ["x"], max_output_tokens: 32_000 }), uncapped, "a limit the provider leaves out");
	assert.deepEqual(warmPayload({ inferenceConfig: { maxTokens: 1 } }, { messages: [], inferenceConfig: { maxTokens: 8192 } }), uncapped, "a limit under a key the extension does not know");
	assert.deepEqual(warmPayload({ max_tokens: 64_000 }, captured), uncapped, "the captured value");
	assert.deepEqual(warmPayload({ max_output_tokens: 16 }, { input: ["x"] }), { payload: { input: ["x"], max_output_tokens: 16 } });
	assert.deepEqual(warmPayload("nope", captured), { reason: "the provider payload is not an object" });
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
