import { calculateCost, type Api, type Model, type Usage } from "@earendil-works/pi-ai";
import { isPlainObject, type Payload } from "./cached-request.ts";

const OUTPUT_LIMIT_KEYS = ["max_tokens", "max_output_tokens", "max_completion_tokens"] as const;

/**
 * The APIs whose requests the extension re-sends: for each, pi 1.5.2's own adapter was checked (tests/replay-adapters
 * test drives it) to build the output limit of a refresh in one of OUTPUT_LIMIT_KEYS at the top level of the payload,
 * the key the captured request carries it in:
 * - anthropic-messages: `max_tokens`, always;
 * - openai-completions: `max_tokens` or `max_completion_tokens`, as the model's compat says;
 * - openai-responses: `max_output_tokens`, at least 16, when the model's compat supports it (else the captured request
 *   has no limit, and the period is left to Pi).
 * Every other API (Bedrock's `inferenceConfig.maxTokens`, Mistral's `maxTokens`, Gemini's `config.maxOutputTokens`,
 * Codex without a limit, …) is left to Pi's own warming: a refresh there could generate a full answer.
 */
export const REPLAYABLE_APIS: ReadonlySet<string> = new Set(["anthropic-messages", "openai-completions", "openai-responses"]);

/** The key the captured request carries its output limit in, or undefined when it has none the extension knows. */
export function outputLimitKey(payload: Payload): string | undefined {
	return OUTPUT_LIMIT_KEYS.find((key) => typeof payload[key] === "number");
}

/** A warm-up that read less than this share of its prompt from the cache wrote it again instead, so warming stops. */
export const MIN_WARM_CACHED_SHARE = 0.9;

/**
 * How long before expiry the extension refreshes the cache. Pi's own warming refreshes at 90% of the lifetime (at least
 * 10 s before expiry), so the extension goes later and only acts once Pi has stopped, but still before compacting
 * before expiry (`compactLeadMs`), which is the fallback when a warm-up is not possible.
 */
export function warmLeadMs(lifetimeMs: number, compactLeadMs: number): number {
	return Math.max(compactLeadMs + 5_000, Math.floor(lifetimeMs * 0.05));
}

/**
 * Whether a cache expiring at `expiresAt` would cool before the keep-warm window ends: `keepWarmMinutes` after Pi
 * went idle at `idleSince`. Once a refresh carries the cache past the window, it is left to expire (or compacted).
 */
export function wantsWarm(expiresAt: number, idleSince: number, keepWarmMinutes: number): boolean {
	return keepWarmMinutes > 0 && expiresAt < idleSince + keepWarmMinutes * 60_000;
}

/**
 * Whether the captured request can be re-sent with a one-token output cap and still read its cache entry. Anthropic's
 * budget-based thinking (`thinking.type: "enabled"`) needs a budget below max_tokens, and Anthropic keys the message
 * cache on that budget; Pi's own warming skips these requests for the same reason. Adaptive thinking is fine.
 */
export function canReplay(captured: Payload): boolean {
	const thinking = captured.thinking;
	return !(isPlainObject(thinking) && thinking.type === "enabled");
}

/**
 * The warm-up payload: the captured request exactly as it was sent, with only its output limit taken from `params`,
 * which the provider built for maxTokens 1 (some APIs raise that to their minimum). Refused when it would not carry
 * that capped limit: none of the known keys in `params`, or a value that is the captured one.
 */
export function warmPayload(params: unknown, captured: Payload): { payload: Payload } | { reason: string } {
	if (!isPlainObject(params)) return { reason: "the provider payload is not an object" };
	const payload: Payload = { ...captured };
	let capped = false;
	for (const key of OUTPUT_LIMIT_KEYS) {
		if (key in params) {
			payload[key] = params[key];
			if (typeof params[key] === "number" && params[key] !== captured[key]) capped = true;
		} else delete payload[key];
	}
	if (!capped) return { reason: "the provider did not build a capped output limit the extension knows, so the refresh could generate a full answer" };
	return { payload };
}

/** The share of a response's prompt that was read from the cache. */
export function cachedShare(usage: { input: number; cacheRead: number; cacheWrite: number }): number {
	const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
	return prompt > 0 ? usage.cacheRead / prompt : 0;
}

/** Without prices the budget cannot be counted in money: at most this many refreshes per idle period. */
export const MAX_UNPRICED_REFRESHES = 10;

/**
 * What a refresh and a cache miss cost for a prompt of `promptTokens` tokens, worked out as Pi's own warming does
 * (`evaluateCacheWarming` in pi-ai 1.5.1 and later; computed here so older Pi loads the extension too): a refresh is the
 * prompt at the cache-read price plus one output token; a miss is the prompt at the cache-write price (the input price
 * when the model has none) minus the prompt at the cache-read price, not below 0. `priced` is false when the model has
 * no prices (a subscription login) or the prompt size is unknown.
 */
export interface WarmBudget {
	priced: boolean;
	refreshCost: number;
	missCost: number;
}

function price(model: Model<Api>, tokens: Partial<Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">>): number {
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...tokens,
	};
	return calculateCost(model, usage).total;
}

export function warmBudget(model: Model<Api>, promptTokens: number): WarmBudget {
	if (!model.cost) return { priced: false, refreshCost: 0, missCost: 0 };
	const hit = price(model, { cacheRead: promptTokens });
	const miss = price(model, model.cost.cacheWrite > 0 ? { cacheWrite: promptTokens } : { input: promptTokens });
	return {
		priced: promptTokens > 0 && (hit > 0 || miss > 0),
		refreshCost: price(model, { cacheRead: promptTokens, output: 1 }),
		missCost: Math.max(0, miss - hit),
	};
}

/** Whether the model has any price; without one, the budget counts refreshes instead of money. */
export function hasPrices(model: Model<Api>): boolean {
	if (!model.cost) return false;
	const { input, cacheRead, cacheWrite } = model.cost;
	return input > 0 || cacheRead > 0 || cacheWrite > 0;
}

/**
 * What the extension's refreshes have cost in one idle period (from one real answer to the next): in dollars, or, for a
 * model without prices, in refreshes. `last` is what the period's last refresh really cost, once one reported it.
 */
export interface WarmSpending {
	spent: number;
	refreshes: number;
	last?: number;
}

/** The period's limit: one cache miss, or `MAX_UNPRICED_REFRESHES` refreshes. */
export function spendingLimit(budget: WarmBudget): number {
	return budget.priced ? budget.missCost : MAX_UNPRICED_REFRESHES;
}

/** What the next refresh is reserved at: the larger of its expected cost and what the last refresh really cost (1 without prices). */
export function reserveFor(budget: WarmBudget, spending: WarmSpending): number {
	return budget.priced ? Math.max(budget.refreshCost, spending.last ?? 0) : 1;
}

/** The gate: a refresh may go out only if what has been spent plus what it is reserved at stays within the limit. */
export function gateAllows(budget: WarmBudget, spending: WarmSpending): boolean {
	return spending.spent + reserveFor(budget, spending) <= spendingLimit(budget);
}

/** Whether the period's spending has reached its limit: warming ends ("budget"), whatever the last refresh's outcome. */
export function budgetReached(budget: WarmBudget, spending: WarmSpending): boolean {
	return spending.spent >= spendingLimit(budget);
}

/** "$0.14", "$2.07", "$0.0031": enough digits to compare a refresh with a miss. */
export function formatUsd(amount: number): string {
	if (amount === 0) return "$0";
	return amount >= 0.1 ? `$${amount.toFixed(2)}` : `$${Number(amount.toPrecision(2))}`;
}

/** The amounts as the footer, /cache-keeper and the log say them: "$1.98 spent, a miss costs $2.07", "10 of 10 refreshes". */
export function spendingText(budget: WarmBudget, spending: WarmSpending): string {
	return budget.priced
		? `${formatUsd(spending.spent)} spent, a miss costs ${formatUsd(budget.missCost)}`
		: `${spending.refreshes} of ${MAX_UNPRICED_REFRESHES} refreshes`;
}

/** The rule as the settings and /cache-keeper say it. */
export function keepWarmRule(minutes: number, priced: boolean): string {
	if (minutes <= 0) return "off";
	const cap = priced ? "stops once refreshing has cost as much as one cache miss" : `at most ${MAX_UNPRICED_REFRESHES} refreshes (this model has no prices, so the cost of a miss is unknown)`;
	return `up to ${keepWarmLabel(minutes)} after Pi goes idle; ${cap}`;
}

/** "off", "30 min", "1 h", "1.5 h". */
export function keepWarmLabel(minutes: number): string {
	if (minutes <= 0) return "off";
	return minutes < 60 ? `${minutes} min` : `${Number((minutes / 60).toFixed(1))} h`;
}
