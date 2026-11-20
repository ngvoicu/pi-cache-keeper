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
/**
 * The refresh limit each re-sent API was proven to build for a one-token answer: the most a refresh payload may carry.
 * A payload with a higher limit, or none in a known key, never leaves (see `limitWithinCap`).
 */
export const REFRESH_LIMITS: Readonly<Record<string, number>> = { "anthropic-messages": 1, "openai-completions": 1, "openai-responses": 16 };
export const REPLAYABLE_APIS: ReadonlySet<string> = new Set(Object.keys(REFRESH_LIMITS));

/** The key the captured request carries its output limit in, or undefined when it has none the extension knows. */
export function outputLimitKey(payload: Payload): string | undefined {
	return OUTPUT_LIMIT_KEYS.find((key) => typeof payload[key] === "number");
}

/**
 * Whether a refresh payload for `api` carries its output limit in a known key, every known key at most the API's proven
 * refresh limit; else why not.
 */
export function limitWithinCap(api: string, payload: Payload): { ok: true } | { reason: string } {
	const cap = REFRESH_LIMITS[api];
	if (cap === undefined) return { reason: `this API's requests are not re-sent by the extension (${api})` };
	const keys = OUTPUT_LIMIT_KEYS.filter((key) => key in payload);
	if (keys.length === 0) return { reason: "the refresh carries no output limit the extension knows, so it could generate a full answer" };
	for (const key of keys) {
		const value = payload[key];
		if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > cap) {
			return { reason: `the refresh would ask for up to ${String(value)} output tokens (${key}), above the ${cap} a refresh of ${api} may` };
		}
	}
	return { ok: true };
}

/**
 * The cache tier a payload shows it was sent for, or undefined where it does not show one: Anthropic's `cache_control`
 * (`ttl: "1h"` long, none short), OpenAI-style `prompt_cache_retention: "24h"` and Kimi's `prompt_cache_options.ttl:
 * "1h"` (long).
 */
export function payloadTier(api: string, payload: Payload): "short" | "long" | undefined {
	if (api === "anthropic-messages") {
		let found: "short" | "long" | undefined;
		const visit = (value: unknown): void => {
			if (Array.isArray(value)) value.forEach(visit);
			else if (isPlainObject(value)) {
				const control = value.cache_control;
				if (isPlainObject(control)) found = control.ttl === "1h" ? "long" : (found ?? "short");
				for (const [key, field] of Object.entries(value)) if (key !== "cache_control") visit(field);
			}
		};
		visit([payload.system, payload.messages, payload.tools]);
		return found;
	}
	const options = payload.prompt_cache_options;
	if (payload.prompt_cache_retention === "24h" || (isPlainObject(options) && options.ttl === "1h")) return "long";
	return undefined;
}

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
/** "30m", "1h", "12h", "300s" in milliseconds; null for a lifetime written otherwise. */
export function ttlMs(value: unknown): number | null {
	const match = typeof value === "string" ? /^(\d+)(s|m|h)$/.exec(value) : null;
	if (!match) return null;
	return Number(match[1]) * { s: 1_000, m: 60_000, h: 3_600_000 }[match[2] as "s" | "m" | "h"];
}

/** One cache marker found in a request: the tier it asks for, where it says, and the lifetime it states, if any. */
export interface CacheMarker {
	/** Where it sits, as a path: `cache_control`, `system[0].cache_control`, `prompt_cache_options.ttl` … */
	at: string;
	/** The tier it asks for; absent for a marker that states only a lifetime (an OpenAI breakpoint with its own `ttl`). */
	tier?: "short" | "long";
	/** The lifetime it states, in milliseconds. */
	ms?: number;
	/**
	 * True when the request states no lifetime and `ms` is the provider's documented one for the tier (Anthropic's
	 * `cache_control` without `ttl`: 5 minutes). The footer shows the tier for it, not `ms`; the rules read `ms` as before.
	 */
	implied?: true;
}

/**
 * What a request asks the provider's cache for, read from every cache marker in the payload as it was sent, wherever
 * it sits; never from a setting:
 * - Anthropic's `cache_control` (top level, system blocks, tools, message content): without `ttl` it asks for the
 *   default cache, 5 minutes; `ttl: "5m"` the same; `ttl: "1h"` the extended cache.
 * - OpenAI's `prompt_cache_retention`: `"24h"` is the extended cache (also Kimi's long option), `"in_memory"` the
 *   default; `prompt_cache_options.ttl` (OpenAI's explicit mode, Kimi's 1-hour option as `"1h"`): `"1h"` is the
 *   extended cache, any other duration the default cache with that lifetime; a `prompt_cache_breakpoint` with its own
 *   `ttl` states a lifetime for a part of the request.
 * A request with no marker at all asks for the provider's default (automatic) cache: tier `short`. A `cache_control`
 * whose `type` is not `"ephemeral"`, or an option or breakpoint with a `mode` other than `"implicit"` or `"explicit"`,
 * is a marker the extension does not read, with or without a `ttl`.
 * `unreadable` names a marker written in a way the extension does not read; `mixed` says the markers ask for different
 * tiers or state different lifetimes. Either way the request is not one the extension keeps warm.
 */
/** The cache modes OpenAI's explicit prompt cache and Kimi's option are known to take; absent is fine. */
const knownMode = (mode: unknown) => mode === undefined || mode === "implicit" || mode === "explicit";

export function requestCache(payload: Payload): { tier: "short" | "long"; markers: CacheMarker[]; unreadable?: string; mixed: boolean } {
	const markers: CacheMarker[] = [];
	let unreadable: string | undefined;
	const bad = (at: string, value: unknown) => (unreadable ??= `${at}: ${JSON.stringify(value)}`);
	const visit = (value: unknown, path: string): void => {
		if (Array.isArray(value)) value.forEach((item, i) => visit(item, `${path}[${i}]`));
		else if (isPlainObject(value)) {
			for (const [key, field] of Object.entries(value)) {
				const at = path ? `${path}.${key}` : key;
				if (key === "cache_control") {
					if (!isPlainObject(field) || field.type !== "ephemeral") bad(at, field);
					else if (field.ttl === undefined) markers.push({ at, tier: "short", ms: 300_000, implied: true });
					else if (field.ttl === "5m") markers.push({ at, tier: "short", ms: 300_000 });
					else if (field.ttl === "1h") markers.push({ at, tier: "long", ms: 3_600_000 });
					else bad(at, field);
				} else if (key === "prompt_cache_breakpoint") {
					if (!isPlainObject(field) || !knownMode(field.mode)) bad(at, field);
					else if (field.ttl !== undefined) {
						const ms = ttlMs(field.ttl);
						if (ms === null) bad(at, field);
						else markers.push({ at, ms });
					}
				} else if (key === "prompt_cache_retention") {
					if (field === "24h") markers.push({ at, tier: "long" });
					else if (field === "in_memory") markers.push({ at, tier: "short" });
					else if (field !== undefined && field !== null) bad(at, field);
				} else if (key === "prompt_cache_options") {
					if (!isPlainObject(field)) {
						if (field !== undefined && field !== null) bad(at, field);
					} else if (!knownMode(field.mode)) bad(at, field);
					else if (field.ttl !== undefined) {
						const ms = ttlMs(field.ttl);
						if (ms === null) bad(at, field);
						else markers.push({ at: `${at}.ttl`, tier: field.ttl === "1h" ? "long" : "short", ms });
					}
				} else visit(field, at);
			}
		}
	};
	visit(payload, "");
	const tiers = new Set(markers.flatMap((m) => (m.tier ? [m.tier] : [])));
	const lifetimes = new Set(markers.flatMap((m) => (m.ms === undefined ? [] : [m.ms])));
	const tier = tiers.has("long") && !tiers.has("short") ? "long" : "short";
	return { tier, markers, ...(unreadable ? { unreadable } : {}), mixed: tiers.size > 1 || lifetimes.size > 1 };
}

const THINKING_LEVELS: ReadonlySet<string> = new Set(["minimal", "low", "medium", "high", "xhigh"]);
const level = (value: unknown): ThinkingLevel => (typeof value === "string" && THINKING_LEVELS.has(value) ? (value as ThinkingLevel) : "off");

/**
 * The thinking level a refresh is built with, read from the captured payload as it was sent rather than from Pi's state
 * at some moment. Only the output limit is taken from what the adapter builds (the rest is the captured payload), and
 * the absolute cap stands behind it; where the payload shows no level, "off", which builds the smallest limit.
 * - anthropic-messages: `thinking.type` "adaptive" with `output_config.effort`; "disabled" or none is off (a budget,
 *   `thinking.type: "enabled"`, is never re-sent: see canReplay);
 * - openai-completions: `reasoning_effort`;
 * - openai-responses: `reasoning.effort`.
 */
export function payloadThinking(api: string, payload: Payload): ThinkingLevel {
	if (api === "anthropic-messages") {
		const thinking = payload.thinking;
		const config = payload.output_config;
		return isPlainObject(thinking) && thinking.type === "adaptive" && isPlainObject(config) ? level(config.effort) : "off";
	}
	if (api === "openai-completions") return level(payload.reasoning_effort);
	if (api === "openai-responses") return isPlainObject(payload.reasoning) ? level(payload.reasoning.effort) : "off";
	return "off";
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
	return whyNotReplayable(captured) === undefined;
}

/**
 * Why `canReplay` says no, by what the request carries, for any provider: `thinking: { type: "enabled" }` (Claude's
 * budget-based thinking; on Chat Completions DeepSeek, GLM, Kimi K2, MiMo and others with thinking on).
 */
export function whyNotReplayable(captured: Payload): string | undefined {
	const thinking = captured.thinking;
	if (!(isPlainObject(thinking) && thinking.type === "enabled")) return undefined;
	const budget = typeof thinking.budget_tokens === "number" ? ` with a budget of ${thinking.budget_tokens} tokens` : "";
	return `the request turns thinking on (thinking: { type: "enabled" }${budget}), which a refresh capped at one output token cannot re-send as it was`;
}

/**
 * The warm-up payload: the captured request exactly as it was sent, with only its output limit taken from `params`,
 * which the provider built for maxTokens 1 (some APIs raise that to their minimum). Whether that limit may leave is the
 * last gate's check (limitWithinCap), not this one's.
 */
export function warmPayload(params: unknown, captured: Payload): { payload: Payload } | { reason: string } {
	if (!isPlainObject(params)) return { reason: "the provider payload is not an object" };
	const payload: Payload = { ...captured };
	for (const key of OUTPUT_LIMIT_KEYS) {
		if (key in params) payload[key] = params[key];
		else delete payload[key];
	}
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
	// At the rates for the request's size, as Pi prices it: a price tier above a number of input tokens replaces the base.
	const rates = ratesFor(model, promptTokens);
	const miss = price(model, rates.cacheWrite > 0 ? { cacheWrite: promptTokens } : { input: promptTokens });
	return {
		// Counted in refreshes only where the model has no price at all, in any tier; any price counts in money.
		priced: promptTokens > 0 && hasPrices(model),
		refreshCost: price(model, { cacheRead: promptTokens, output: 1 }),
		missCost: Math.max(0, miss - hit),
	};
}

type Rates = { input: number; output: number; cacheRead: number; cacheWrite: number };
type TieredCost = Rates & { tiers?: (Rates & { inputTokensAbove: number })[] };

/** The rates Pi prices a request of this many input tokens at (calculateCost): the highest tier it passes, else the base. */
function ratesFor(model: Model<Api>, inputTokens: number): Rates {
	const cost = model.cost as TieredCost;
	let rates: Rates = cost;
	let matched = -1;
	for (const tier of cost.tiers ?? []) {
		if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matched) {
			rates = tier;
			matched = tier.inputTokensAbove;
		}
	}
	return rates;
}

/**
 * Whether the model has any price, in its base rates or in any price tier; without one, the budget counts refreshes
 * instead of money.
 */
export function hasPrices(model: Model<Api>): boolean {
	if (!model.cost) return false;
	const cost = model.cost as TieredCost;
	const paid = (r: Rates) => r.input > 0 || r.output > 0 || r.cacheRead > 0 || r.cacheWrite > 0;
	return paid(cost) || (cost.tiers ?? []).some(paid);
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

/**
 * Whether a refresh can pay for itself at all: with prices, one refresh must cost less than the miss it avoids (the
 * same figures as the gate). Where it does not, the extension does not take the period: Pi's own warming decides it.
 */
export function refreshCanPay(budget: WarmBudget): boolean {
	return !budget.priced || budget.refreshCost < spendingLimit(budget);
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
