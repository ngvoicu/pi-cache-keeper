import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { calculateCost, contentText, type Api, type AssistantMessage, type Model, type Usage } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	getLastAssistantUsage,
	getLatestCompactionEntry,
	getSettingsListTheme,
	keyHint,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, type SettingItem } from "@earendil-works/pi-tui";
import { cacheState, cacheTier, hasExplicitPromptCache, isKimiOnMoonshot, type CacheState } from "./cache-state.ts";
import {
	checkpointSummary,
	isPlainObject,
	keptStart,
	messageArrayKey,
	piCompactionInput,
	summaryInstruction,
	summaryPayload,
	trailingMessages,
	withKimiLongCache,
	withSharedPrefixCache,
	type CachedPrefix,
	type Payload,
	type PrefixMismatch,
} from "./cached-request.ts";
import {
	autoCompactionEnabled,
	COMPACT_AT_PERCENTS,
	COMPACT_AT_TOKEN_CHOICES,
	fullThreshold,
	KEEP_WARM_CHOICES,
	loadConfig,
	MIN_CONTEXT_CHOICES,
	MIN_SUMMARY_TOKENS,
	saveConfig,
	SETTINGS_KEY,
	settingsKeyInUse,
	summaryBudget,
	type CacheKeeperConfig,
} from "./config.ts";
import {
	appendTrace,
	comparison,
	describeTrace,
	formatDuration,
	formatRemaining,
	formatTokens,
	readTraces,
	TRACE_PATH_LABEL,
	stopLabel,
	traceDetails,
	type CompactTrace,
	type TimerContext,
	type TraceEvent,
	type TraceRecord,
	type TraceUsage,
	type Trigger,
	type WarmStop,
	type WarmTrace,
} from "./trace.ts";
import {
	budgetReached,
	cachedShare,
	formatUsd,
	gateAllows,
	hasPrices,
	keepWarmLabel,
	keepWarmRule,
	MAX_UNPRICED_REFRESHES,
	MIN_WARM_CACHED_SHARE,
	limitWithinCap,
	outputLimitKey,
	payloadThinking,
	payloadTier,
	REPLAYABLE_APIS,
	requestCache,
	refreshCanPay,
	whyNotReplayable,
	reserveFor,
	spendingText,
	wantsWarm,
	warmBudget,
	warmLeadMs,
	warmPayload,
	type WarmBudget,
	type WarmSpending,
} from "./keep-warm.ts";
import {
	DATA_MAX_AGE_MS,
	DATA_SOURCE,
	describeFound,
	desiredOverride,
	fetchDataset,
	findFacts,
	fieldStates,
	accessVia,
	parseAnsweredEvent,
	parseUpstreamsEvent,
	type Upstream,
	ANSWERED_EVENT,
	REQUEST_EVENT,
	UPSTREAMS_EVENT,
	usableLifetime,
	loadStore,
	lookupsFor,
	modelsPathLabel,
	planOverrides,
	readModelsFile,
	saveStore,
	writeModelsFile,
	type Access,
	type DataStore,
	type Fetch,
	type Found,
} from "./model-data.ts";
import { formatFooter, lifetimesView, priceAt, sentView, type Countdown, type DataView, type FooterView, type KeepWarmView, type PriceView } from "./footer.ts";

interface CapturedRequest {
	transcript: AgentMessage[];
	payload?: Payload;
	model: Model<Api>;
	at: number;
	/** The timestamp of the answer to this request, when that answer read or wrote the cache (message_end). */
	answeredAt?: number;
	/**
	 * The cache tier the request was sent for, recorded when it was captured: from the payload where it shows it
	 * (payloadTier), else the retention in force at that instant. A setting changed later does not change it.
	 */
	tier: "short" | "long";
	/**
	 * What the request's cache markers ask for (requestCache), where the payload was seen. Only the ownership decision
	 * and a period the extension keeps warm read the tier from here (R8).
	 */
	cache?: ReturnType<typeof requestCache>;
	/** The extension's shared-prefix cache (a 12-hour prefix) was applied: the request carries two cache lifetimes. */
	sharedPrefix?: boolean;
}

/** A cache lifetime under this cannot carry a refresh: Pi's own warming keeps such a session, if anything does. */
const MIN_OWNED_LIFETIME_MS = 60_000;

/**
 * R9: per model (provider/id), how many refreshes in a row missed the cache, and the models left to Pi's own warming
 * after two in a row, with when. A hit sets the run back to zero; /cache-keeper-warm clears both. A wrong lifetime
 * costs at most two missed refreshes, then nothing until the user starts warming again. Pi loads the extension again
 * (a new instance, its modules imported afresh) on /new, /resume, /fork and /reload, so the store is kept on
 * `globalThis` under a registered symbol: every instance in the process finds it, and it ends with the process. In
 * memory only.
 */
const WARM_MISSES = Symbol.for("pi-cache-keeper.warm-misses");
const MISSES_IN_A_ROW = 2;
interface WarmMisses {
	counts: Map<string, number>;
	fallback: Map<string, number>;
}
function warmMissStore(): WarmMisses {
	const host = globalThis as Record<symbol, unknown>;
	const found = host[WARM_MISSES] as Partial<WarmMisses> | undefined;
	if (!(found?.counts instanceof Map) || !(found.fallback instanceof Map)) host[WARM_MISSES] = { counts: new Map(), fallback: new Map() };
	return host[WARM_MISSES] as WarmMisses;
}

/**
 * Lifetimes `cacheState` assumes for a model family rather than reads from the model's data, with the provider's own
 * API they hold on. Elsewhere (a proxy, a gateway, a custom base URL) a period is owned only with a declared lifetime.
 */
const ASSUMED_LIFETIMES: Record<string, RegExp | undefined> = {
	"OpenAI's minimum": /^https:\/\/api\.openai\.com(\/|$)/,
	"Kimi's 1-hour option": /^https:\/\/api\.moonshot\.(ai|cn)\//,
	"Kimi's default": /^https:\/\/api\.moonshot\.(ai|cn)\//,
};

/**
 * One idle period, from one real answer (an answer that read or wrote the cache) to the next. With keep-warm on, either
 * the extension keeps its cache warm (and tells Pi's own idle warming to stop) or Pi's warming decides alone, for the
 * whole period: `notOwned` says why not, from facts that do not change during it. The budget and what the refreshes
 * have spent belong to the period: only a new real answer starts them again, not a run that sent nothing.
 */
interface WarmPeriod {
	answeredAt?: number;
	/** When Pi went idle after the period's answer; the time limit counts from here. */
	idleSince: number;
	notOwned?: string;
	/** What the footer says of `notOwned`, in a few words; none where nothing is worth saying (no answer yet). */
	notOwnedLabel?: string;
	/** The request of the period's answer; forgotten with the cached request (model switch, compaction, branch move). */
	request?: CapturedRequest;
	budget?: WarmBudget;
	spending: WarmSpending;
	/** Why keeping warm ended for the rest of the period. */
	ended?: { stop: WarmStop; reason: string };
	/** Keep-warm read on when the period started; a period started while it read off is never owned. */
	onAtStart: boolean;
	/** The expiry the refresh was decided for (sent, or too late), so it is not tried again for it. */
	doneFor?: number;
	/** The expiry for which "Pi is busy" was logged, so a refresh tried on every tick logs it once. */
	busyFor?: number;
	/**
	 * What an owned period's cached request was written with, fixed at the period's start: the model, the cache tier and
	 * the lifetime. The expiry is counted with this lifetime; reading anything else later ends warming ("unable").
	 */
	fixed?: { model: string; tier: "short" | "long"; requested: "short" | "long"; ms: number; source: string };
}

interface CachedPath {
	request: CapturedRequest;
	prefix?: CachedPrefix;
	trailing: AgentMessage[];
	cache: CacheState;
}

/** The extension's one status in Pi's footer: the countdown, what went wrong, and the values in use (see footer.ts). */
const STATUS_KEY = "cache-keeper";
const httpFetch: Fetch = (url, init) => fetch(url, init);
const CARD_TYPE = "cache-keeper";
/** The card type pi-cached-compaction wrote; still rendered so cards in older sessions show. */
const LEGACY_CARD_TYPE = "cached-compaction";
const PREFIX_MISMATCH = "pi-cache-keeper: request prefix differs from the cached request";
const BRIDGE_API = "claude-bridge";
const FORK_REQUEST_HEADER = "x-claude-bridge-fork";
const EXPIRY_LEAD_MS = 20_000;
const RETENTION_MARKER = "PI_CACHE_KEEPER_RETENTION";
const INTERACTIVE_OWNER = Symbol.for("pi-cache-keeper.interactive-long-retention");

// Only OpenAI keeps tool_choice out of the cached prefix; elsewhere changing it costs cache.
function isOpenAiResponses(model: Model<Api>): boolean {
	return model.provider === "openai" && model.api === "openai-responses";
}

function sharedPrefixKey(model: Model<Api>, cwd: string): string | undefined {
	if (!hasExplicitPromptCache(model) || process.env.PI_CACHE_RETENTION !== "long") return undefined;
	return `pi-${createHash("sha256").update(cwd).digest("hex").slice(0, 40)}`;
}

function traceUsage(usage: Usage): TraceUsage {
	return { input: usage.input, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, output: usage.output, cost: usage.cost.total };
}

function applyRetention(preferLong: boolean, interactive: boolean): void {
	const current = process.env.PI_CACHE_RETENTION;
	if (current !== undefined && process.env[RETENTION_MARKER] !== current) return;
	const host = globalThis as Record<symbol, unknown>;
	if (preferLong && interactive) {
		process.env.PI_CACHE_RETENTION = process.env[RETENTION_MARKER] = "long";
		host[INTERACTIVE_OWNER] = true;
	} else if (interactive || !host[INTERACTIVE_OWNER]) {
		delete process.env.PI_CACHE_RETENTION;
		delete process.env[RETENTION_MARKER];
		host[INTERACTIVE_OWNER] = false;
	}
}

export default function cacheKeeper(pi: ExtensionAPI) {
	let config = loadConfig();

	let pendingTranscript: AgentMessage[] | undefined;
	let captured: CapturedRequest | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;
	// Set while a compaction the extension started itself is running.
	let ownTrigger: "expiry" | "full" | undefined;
	// The last "full" skip reason logged, so a context that stays past the mark logs each reason once.
	let lastFullSkip: string | undefined;
	// Set when compacting "when full" left the context past the mark, so it is not retried after every turn.
	let fullStuck = false;
	let compactionTrigger: Trigger | undefined;
	let decision: Extract<TraceRecord, { event: "compact" }> | undefined;
	let traceError: string | undefined;
	// Keeping the cache warm: the idle period (see WarmPeriod), whether an agent run is active (agent_start to
	// agent_settled), when this extension last refreshed the cache, the refresh in flight, and when Pi last decided to
	// refresh it itself.
	let period: WarmPeriod | undefined;
	// Whether keep-warm is on and for how long, from the saved settings, so a switch in any Pi window holds in every one
	// from the next decision on. Ownership, the decision handler, the countdown and the last gate all read it here.
	// Undefined when the settings cannot be read: then no refresh is sent and the handler returns nothing. A reading is
	// kept for the current millisecond (the countdown asks several times per tick); `fresh` reads again.
	let keepWarmRead: { at: number; value: { minutes: number } | undefined } | undefined;
	const keepWarmSetting = (fresh = false): { minutes: number } | undefined => {
		const now = Date.now();
		if (!fresh && keepWarmRead?.at === now) return keepWarmRead.value;
		let value: { minutes: number } | undefined;
		try {
			value = { minutes: loadConfig().keepWarmMinutes };
		} catch {
			value = undefined;
		}
		keepWarmRead = { at: now, value };
		return value;
	};
	const warmMinutes = (fresh = false) => keepWarmSetting(fresh)?.minutes ?? 0;
	// The request whose answer was the latest to read or write the cache: a later request that failed before using the
	// cache does not replace it.
	let answerRequest: CapturedRequest | undefined;
	let running = false;
	let warmedAt: number | undefined;
	let warming: AbortController | undefined;
	let piWarmAt: number | undefined;
	// The cache lifetime of a proxy model follows what answered (see servedModel below).
	// How a period the extension keeps warm reads its cache, and how the ownership decision reads it: the expiry counted
	// from the latest real answer (an aborted one that used the cache included), and, where no answer reported a tier,
	// the tier the request as sent asked for (R8).
	const keptState = (model: Model<Api>, entries: SessionEntry[], requested: "short" | "long") =>
		cacheState(servedModel(model), entries, warmedAt, true, requested);
	// The countdown, the footer, compacting before expiry and everything else: for a period the extension keeps warm, as
	// that period reads it; otherwise (keep-warm off, or a period left to Pi) exactly as with keep-warm off.
	const stateOf = (model: Model<Api>, entries: SessionEntry[]) => {
		const p = period;
		return owns(p) ? keptState(model, entries, p.fixed.requested) : cacheState(servedModel(model), entries, warmedAt);
	};
	// R9: each model's run of missed refreshes, and the models two misses in a row left to Pi (see WARM_MISSES).
	const misses = warmMissStore();
	const fallbackLine = (model: string, at: number) =>
		`two refreshes in a row missed the cache for ${model} (the last at ${new Date(at).toTimeString().slice(0, 5)}), so it is left to Pi's own warming; /cache-keeper-warm starts keeping it warm again`;
	const fallbackFor = (model: Model<Api> | undefined): { key: string; at: number } | undefined => {
		const key = model && `${model.provider}/${model.id}`;
		const at = key === undefined ? undefined : misses.fallback.get(key);
		return key !== undefined && at !== undefined ? { key, at } : undefined;
	};
	// A refresh's evidence, counted per model: a miss adds one, a hit sets the run back to zero. The second miss in a
	// row leaves the model to Pi (true once, when that happens). Touches no session context.
	const recordRefresh = (model: string, verdict: "miss" | "hit", at: number): boolean => {
		if (verdict === "hit") {
			misses.counts.delete(model);
			return false;
		}
		const count = (misses.counts.get(model) ?? 0) + 1;
		misses.counts.set(model, count);
		if (count < MISSES_IN_A_ROW || misses.fallback.has(model)) return false;
		misses.fallback.set(model, at);
		return true;
	};
	// Why the extension cannot keep a period warm itself, from facts that last for the period, with what the footer says
	// of it in a few words; undefined when it can.
	const whyNotOwned = (state: CacheState | undefined, model: Model<Api> | undefined): { reason: string; label?: string } | undefined => {
		const no = (label: string | undefined, reason: string) => ({ reason, ...(label ? { label } : {}) });
		const fellBack = fallbackFor(model);
		// While it lasts the footer says it on its own; after /cache-keeper-warm the period stays Pi's until the next answer.
		if (fellBack) return no("until your next message", fallbackLine(fellBack.key, fellBack.at));
		if (state?.answeredAt === undefined) return no(undefined, "no answer has read or written the prompt cache yet");
		if (!state.lifetime) return no("no cache lifetime", "the cache lifetime is unknown");
		if (state.lifetime.ms < MIN_OWNED_LIFETIME_MS) return no("lifetime under a minute", `the cache lifetime (${formatDuration(state.lifetime.ms)}) is under a minute`);
		// The same state the countdown reads: without a cached answer there is no expiry to keep warm.
		if (!state.cached) return no("last answer used no cache", "the last answer did not use the prompt cache");
		const request = answerRequest;
		if (!request || request.answeredAt !== state.answeredAt) return no("request not seen", "the request of the last answer was not captured");
		if (!request.payload) return no("no request to re-send", `${request.model.api} requests cannot be re-sent`);
		// The same checks the refresh makes, on the payload as it was sent: only where a refresh is proven to go out with
		// its output capped (see REPLAYABLE_APIS) does the extension keep the cache warm and stop Pi's warming.
		if (!REPLAYABLE_APIS.has(request.model.api)) return no(`${request.model.api} not re-sent`, `this API's requests are not re-sent by the extension (${request.model.api})`);
		if (!messageArrayKey(request.payload)) return no("request not checkable", `the ${request.model.api} request has no message list the extension can check`);
		if (!outputLimitKey(request.payload)) return no("no output limit", "the request carries no output limit the extension can cap");
		const thinking = whyNotReplayable(request.payload);
		if (thinking) return no("thinking on", thinking);
		// R8: the tier is the one the request as sent asks for, never the setting. One lifetime for the whole request, the
		// one the period would fix; no attempt to work out another.
		const cache = request.cache ?? requestCache(request.payload);
		if (cache.unreadable) return no("unreadable cache marker", `the request carries a cache marker the extension does not read (${cache.unreadable})`);
		if (request.sharedPrefix || cache.mixed) return no("several cache lifetimes", "the request carries more than one cache lifetime");
		// The answer's own report wins: writes in the other tier, or in both, and the request is not what was cached.
		const answered = state.answerTiers;
		if (answered && answered.length > 1) return no("both tiers written", "the answer reports cache writes in both tiers (5 min and 1 h)");
		if (answered?.length === 1 && answered[0] !== cache.tier) return no("the answer wrote the other tier", `the answer reports cache writes in the ${answered[0]} tier, the request asked for the ${cache.tier} one`);
		if (state.tier !== cache.tier) return no("tier mismatch", `the cache tier reported earlier (${state.tier}) does not match the one the request asked for (${cache.tier})`);
		if (cache.markers.some((m) => m.ms !== undefined && m.ms !== state.lifetime?.ms)) return no("lifetime differs from the data", "the request's cache lifetime does not match the model data");
		// A lifetime assumed for a model family holds only on that provider's own API.
		const ownApi = ASSUMED_LIFETIMES[state.lifetime.source];
		if (ownApi && !ownApi.test(request.model.baseUrl)) {
			return no(
				"lifetime only assumed here",
				`the cache lifetime (${state.lifetime.source}) is only assumed on the provider's own API, not at ${request.model.baseUrl}; declare one with modelOverrides.promptCache`,
			);
		}
		// Owned or left alone, never in between: where one refresh costs as much as the miss it avoids, the gate would
		// stop the first refresh, so the period is not taken from Pi at all.
		if (state.answerPrompt !== undefined && !refreshCanPay(warmBudget(request.model, state.answerPrompt))) return no("a refresh costs a miss", "at this model's prices a refresh costs as much as a miss");
		return undefined;
	};
	// Pi is idle. After a run that brought a new real answer (or at a session's start) a new period starts; after one that
	// sent nothing, the period goes on, with its spending and its time limit.
	const goIdle = (ctx: ExtensionContext, fresh = false) => {
		running = false;
		const requested = answerRequest?.cache?.tier ?? answerRequest?.tier ?? "short";
		const state = ctx.model ? keptState(ctx.model, ctx.sessionManager.getBranch(), requested) : undefined;
		const answeredAt = state?.answeredAt;
		if (!fresh && period && (answeredAt === undefined || answeredAt === period.answeredAt)) return;
		const why = whyNotOwned(state, answerRequest?.model ?? ctx.model);
		const request = why === undefined ? answerRequest : undefined;
		const model = ctx.model;
		period = {
			answeredAt,
			idleSince: Date.now(),
			notOwned: why?.reason,
			...(why?.label ? { notOwnedLabel: why.label } : {}),
			onAtStart: warmMinutes(true) > 0,
			request,
			budget: request && state?.answerPrompt !== undefined ? warmBudget(request.model, state.answerPrompt) : undefined,
			spending: { spent: 0, refreshes: 0 },
			fixed:
				request && model && state?.lifetime
					? {
							model: `${model.provider}/${model.id}`,
							tier: cacheTier(ctx.sessionManager.getBranch(), model, requested),
							requested,
							ms: state.lifetime.ms,
							source: state.lifetime.source,
						}
					: undefined,
		};
	};
	// The extension keeps this period's cache warm: keep-warm on and the period's facts hold.
	const owns = (p: WarmPeriod | undefined): p is WarmPeriod & { budget: WarmBudget; fixed: NonNullable<WarmPeriod["fixed"]> } =>
		warmMinutes() > 0 && p !== undefined && p.onAtStart && p.notOwned === undefined && p.budget !== undefined && p.fixed !== undefined;
	// What differs from what the period's cached request was written with, if anything.
	const driftReason = (fixed: NonNullable<WarmPeriod["fixed"]>, model: Model<Api>, state: CacheState, tier: "short" | "long"): string | undefined => {
		const now = `${model.provider}/${model.id}`;
		if (now !== fixed.model) return `the model is now ${now}, the cached request was written with ${fixed.model}`;
		const written = formatDuration(fixed.ms);
		if (!state.lifetime) return `the cache lifetime is now unknown, the cached request was written with ${written}`;
		if (state.lifetime.ms !== fixed.ms) return `the cache lifetime now reads ${formatDuration(state.lifetime.ms)}, the cached request was written with ${written}`;
		if (tier !== fixed.tier) return `the cache tier now reads ${tier}, the cached request was written with ${fixed.tier}`;
		return undefined;
	};
	const abortWarm = () => {
		warming?.abort();
		warming = undefined;
	};

	const trace = <E extends TraceEvent>(ctx: ExtensionContext, event: E) => {
		const record = { ...event, at: new Date().toISOString(), session: ctx.sessionManager.getSessionId() };
		try {
			appendTrace(record);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI && message !== traceError) ctx.ui.notify(`pi-cache-keeper could not write ${TRACE_PATH_LABEL}: ${message}`, "warning");
			traceError = message;
		}
		return record;
	};

	const renderCard: Parameters<typeof pi.registerEntryRenderer<{ records: TraceRecord[] }>>[1] = (entry, { expanded }, theme) => {
		const records = entry.data?.records;
		if (!records?.length) return undefined;
		const lines = [`${theme.fg("accent", "cached compaction")}${expanded ? "" : `  ${theme.fg("muted", "(")}${keyHint("app.tools.expand", "for details")}${theme.fg("muted", ")")}`}`];
		for (const record of records) {
			const line = describeTrace(record);
			const missed = record.event === "failed" || (record.event === "compact" && (record.outcome !== "cached" || record.response?.usage.cacheRead === 0));
			lines.push(missed ? theme.fg("warning", line) : line);
			const versus = record.event === "compact" ? comparison(record) : undefined;
			if (versus) {
				const text = `         ${versus.text}`;
				lines.push(versus.ratio <= 0.95 ? theme.fg("success", text) : versus.ratio >= 1.05 ? theme.fg("warning", text) : text);
			}
			if (expanded && record.event === "compact") lines.push(...traceDetails(record).map((detail) => theme.fg("dim", `         ${detail}`)));
		}
		if (expanded) lines.push(theme.fg("dim", `log: ${TRACE_PATH_LABEL}`));
		return new Text(lines.join("\n"), 1, 0);
	};
	pi.registerEntryRenderer(CARD_TYPE, renderCard);
	pi.registerEntryRenderer(LEGACY_CARD_TYPE, renderCard);
	const showCard = (records: TraceRecord[]) => pi.appendEntry<{ records: TraceRecord[] }>(CARD_TYPE, { records });

	// The footer (see footer.ts): the countdown as the timer last set it, the model's values as showData last read them,
	// and what keep-warm says now, fitted to the terminal's width. Pi is told only when the text changes.
	let countdown: Countdown | undefined;
	let modelView: Omit<FooterView, "countdown" | "keepWarm"> | undefined;
	let footerText: string | undefined;
	let onResize: (() => void) | undefined;
	// Pi's footer is as wide as the terminal; elsewhere (RPC, tests) nothing is fitted.
	const footerWidth = () => (process.stdout.isTTY && process.stdout.columns > 0 ? process.stdout.columns : Number.POSITIVE_INFINITY);
	// What keep-warm says in the footer, while it is on: two misses in a row left the model to Pi (for as long as that
	// lasts, countdown or not), warming ended for this idle period and why (until your next message), the period is
	// Pi's and why, or keep-warm was switched on during the period.
	const keepWarmView = (model: Model<Api>): KeepWarmView | undefined => {
		if (warmMinutes() <= 0) return undefined;
		if (fallbackFor(model)) return { fallback: true };
		const p = period;
		if (!p) return undefined;
		if (owns(p)) return p.ended && !running ? { ended: { stop: p.ended.stop, limit: keepWarmLabel(warmMinutes()), amounts: spendingText(p.budget, p.spending) } } : undefined;
		if (!p.onAtStart) return { pending: true };
		return p.notOwnedLabel ? { leftToPi: p.notOwnedLabel } : undefined;
	};
	const renderFooter = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const model = ctx.model;
		const text = model ? formatFooter({ countdown, keepWarm: keepWarmView(model), ...modelView }, footerWidth(), (piece, tone) => ctx.ui.theme.fg(tone, piece)) : undefined;
		if (text === footerText) return;
		footerText = text;
		ctx.ui.setStatus(STATUS_KEY, text);
	};
	const stopTimer = (ctx: ExtensionContext, render = true) => {
		clearInterval(ticker);
		ticker = undefined;
		countdown = undefined;
		if (render) renderFooter(ctx);
	};
	const forget = (ctx: ExtensionContext) => {
		pendingTranscript = undefined;
		captured = answerRequest = undefined;
		// Nothing to keep warm until the next real answer.
		if (period) period.request = undefined;
		warmedAt = undefined;
		abortWarm();
		stopTimer(ctx);
	};

	// A compaction can outlive its session (Pi exiting, /new, /reload). Pi then calls back with a ctx that throws on
	// use, and an error thrown from a callback takes the whole process down with exit code 1.
	const ifSessionAlive = (action: () => void) => {
		try {
			action();
		} catch {
			// The session this compaction belonged to is gone; there is nothing left to update.
		}
	};

	// Model data from providers.dev: each model's input window, cache lifetimes and prices, written into the
	// modelOverrides of pi's models.json, so pi's own warming and compaction and this extension's countdown use them.
	let data = loadStore();
	let dataRefresh: Promise<DataSummary> | undefined;
	let dataError: string | undefined;
	// The session's context, for the events other extensions send (they come without one).
	let sessionCtx: ExtensionContext | undefined;
	let upstreamsChanged = false;
	interface DataSummary {
		/** How many models' entries in models.json changed. */
		models: number;
		downloaded: boolean;
	}

	// How pi reaches a model: with a subscription login or an API key, or, for a model a proxy extension serves, from
	// where that extension says. Pi's answer is the same for every model of a provider, so one pass over the models
	// asks pi once per provider.
	const accessReader = (ctx: ExtensionContext) => {
		const registry = ctx.modelRegistry;
		const subscriptions = new Map<string, boolean>();
		return (model: Model<Api>): Access => {
			const routes = data.upstreams[model.provider];
			// A provider whose extension said where its models come from: a model it did not name is not known.
			if (routes) return { upstreams: routes[model.id]?.upstreams ?? [] };
			let subscription = subscriptions.get(model.provider);
			if (subscription === undefined) {
				subscription = registry.isUsingOAuth(model) && registry.getProvider(model.provider)?.auth.oauth?.isSubscription === true;
				subscriptions.set(model.provider, subscription);
			}
			return { subscription };
		};
	};
	const foundFor = (ctx: ExtensionContext, model: Model<Api>, accessOf = accessReader(ctx)): Found => findFacts(lookupsFor(model, accessOf(model)), data.providers);

	// What served the last request to a proxy model, as its extension said. The values in models.json are those of
	// what may serve it; when something else answered (that failed or is cooling down, or several take turns), the
	// lifetime of what answered is the one that holds.
	let answered: { provider: string; id: string; upstreams: Upstream[] } | undefined;
	const answeredFor = (model: Model<Api> | undefined): Upstream[] | undefined =>
		model && answered && answered.provider === model.provider && answered.id === model.id ? answered.upstreams : undefined;
	const lookupKeys = (model: Model<Api>, access: Access) => lookupsFor(model, access).map((one) => `${one.provider}/${one.model}`).sort().join(" ");
	// What answered, when it is not what the values are for.
	const servedOtherwise = (model: Model<Api> | undefined): Upstream[] | undefined => {
		const upstreams = answeredFor(model);
		const route = model ? data.upstreams[model.provider]?.[model.id] : undefined;
		if (!model || !upstreams || !route) return undefined;
		return lookupKeys(model, { upstreams }) === lookupKeys(model, { upstreams: route.upstreams }) ? undefined : upstreams;
	};
	const servedModel = (model: Model<Api>): Model<Api> => {
		const upstreams = servedOtherwise(model);
		if (!upstreams) return model;
		const found = findFacts(lookupsFor(model, { upstreams }), data.providers);
		const short = usableLifetime(found.facts.short);
		const long = usableLifetime(found.facts.long);
		const promptCache = short === undefined && long === undefined ? undefined : { ...(short === undefined ? {} : { short }), ...(long === undefined ? {} : { long }) };
		return { ...model, promptCache };
	};

	// The model's values for the footer: the cache lifetimes and the tier in use, what the last request asked for, the
	// price, and what providers.dev has to say. Each value is one Pi or the extension has: Pi's model as it is now (its
	// catalog, your models.json, providers.dev's values written there), the lifetime the countdown runs on, the request
	// as it was sent.
	const modelViewOf = (ctx: ExtensionContext, model: Model<Api>): Omit<FooterView, "countdown" | "keepWarm"> => {
		const entries = ctx.sessionManager.getBranch();
		const bridge = model.api === BRIDGE_API;
		const access = accessReader(ctx)(model);
		const otherwise = servedOtherwise(model);
		const lastAnswer = answeredFor(model);
		const via = bridge ? undefined : accessVia(lastAnswer ? { upstreams: lastAnswer } : access);
		const fetched = data.checkedAt !== undefined;
		// providers.dev's entries for the values in use: those of what answered, when that is not what the values are for.
		const found = config.modelData && fetched ? findFacts(lookupsFor(model, otherwise ? { upstreams: otherwise } : access), data.providers) : undefined;
		const served = servedModel(model);
		// The tier and lifetime the countdown runs on: as a period the extension keeps warm fixed them, else as with
		// keep-warm off. Claude Code picks the tier for the bridge model.
		const p = period;
		const owned = owns(p);
		const tier = owned ? p.fixed.tier : bridge ? undefined : cacheTier(entries, model);
		const counted = owned ? undefined : stateOf(model, entries).lifetime;
		const declared = tier === undefined ? undefined : served.promptCache?.[tier];
		// Where the model declares none for the tier, the countdown's own (the provider's report, a family's documented one).
		const inUse = owned ? p.fixed.ms / 1000 : (declared ?? (counted && counted.source !== "declared by the model" ? counted.ms / 1000 : undefined));
		const lifetimes = lifetimesView(served.promptCache, { tier, seconds: inUse }, found);
		const request = captured && captured.model.provider === model.provider && captured.model.id === model.id ? captured : undefined;
		const cache = request?.payload ? (request.cache ?? requestCache(request.payload)) : undefined;
		const retention = process.env.PI_CACHE_RETENTION === "long" ? "long" : "short";
		const sent = cache ? sentView(cache, { tier, ms: inUse === undefined ? undefined : inUse * 1000 }, served.promptCache, retention) : undefined;
		const rates = hasPrices(model) ? priceAt(model.cost, ctx.getContextUsage()?.tokens ?? undefined) : undefined;
		const priceState = found && found.refs.length > 0 ? fieldStates(found).price : undefined;
		const price: PriceView = {
			...(via ? { via } : {}),
			// A subscription login has no per-token price; nor has Claude Code through the bridge, which Pi prices at $0.
			...(via === "sub" || (bridge && !rates) ? { subscription: true } : {}),
			...(rates ? { rates } : priceState === "unsure" ? { partial: true } : {}),
		};
		const dataView: DataView = {};
		if (config.modelData) {
			if (!fetched && dataError !== undefined) dataView.fetch = "failed";
			else if (!fetched && process.env.PI_OFFLINE) dataView.fetch = "offline";
			if (fetched && dataError !== undefined) dataView.staleMs = Date.now() - (data.checkedAt as number);
			if (found && found.refs.length === 0) dataView.noEntry = true;
			if (otherwise) dataView.served = accessVia({ upstreams: otherwise });
			if (lifetimes.short.mark === "guess" || lifetimes.long.mark === "guess") dataView.guess = via === "sub" || via === "api" ? "login" : "access";
		}
		return { lifetimes, ...(sent ? { sent } : {}), price, data: dataView };
	};
	const showData = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const model = ctx.model;
		modelView = model ? modelViewOf(ctx, model) : undefined;
		renderFooter(ctx);
	};

	// Brings models.json in line with the saved data (or, with the setting off, takes this extension's values out).
	const applyData = async (ctx: ExtensionContext): Promise<number> => {
		const registry = ctx.modelRegistry;
		const models = config.modelData ? registry.getAvailable() : [];
		const byKey = new Map(models.map((model) => [`${model.provider}\n${model.id}`, model]));
		let file: Record<string, unknown>;
		try {
			file = readModelsFile();
		} catch (error) {
			throw new Error(`${modelsPathLabel()} is not plain JSON (${error instanceof Error ? error.message : String(error)}), so it is left as it is`);
		}
		const accessOf = accessReader(ctx);
		const plan = planOverrides(file, data.written, models, (provider, id, owned) => {
			const model = byKey.get(`${provider}\n${id}`);
			return model ? desiredOverride(model, foundFor(ctx, model, accessOf).facts, owned) : {};
		});
		if (plan.changed.length > 0) writeModelsFile(plan.file);
		data = { ...data, written: plan.written };
		saveStore(data);
		if (plan.changed.length === 0) return 0;
		await registry.refresh({ providers: [...new Set(plan.changed.map((one) => one.provider))], allowNetwork: false });
		// The session holds the model as it was; selecting it again picks up the new values. setModel resets the
		// thinking level and makes the extension forget the last request, so it waits for an idle moment.
		const current = ctx.model;
		if (current && ctx.isIdle() && plan.changed.some((one) => one.provider === current.provider && one.id === current.id)) {
			const fresh = registry.find(current.provider, current.id);
			const level = pi.getThinkingLevel();
			if (fresh && (await pi.setModel(fresh))) {
				pi.setThinkingLevel(level);
				startTimer(ctx);
			}
		}
		return plan.changed.length;
	};

	// Which providers.dev providers describe the models pi can use right now.
	const neededProviders = (ctx: ExtensionContext): string[] => {
		const needed = new Set<string>();
		const accessOf = accessReader(ctx);
		for (const model of ctx.modelRegistry.getAvailable()) {
			const access = accessOf(model);
			for (const lookup of lookupsFor(model, access)) needed.add(lookup.provider);
			// Whatever a proxy may fall back to, so its values are at hand when it answers.
			for (const upstream of data.upstreams[model.provider]?.[model.id]?.fallbacks ?? []) {
				for (const lookup of lookupsFor(model, { upstreams: [upstream] })) needed.add(lookup.provider);
			}
		}
		return [...needed].sort();
	};

	const refreshData = (ctx: ExtensionContext, force: boolean): Promise<DataSummary> =>
		(dataRefresh ??= (async () => {
						const dataset = await fetchDataset(neededProviders(ctx), data, httpFetch, { force });
			data = { ...data, providers: dataset.providers, datasetVersion: dataset.datasetVersion, checkedAt: Date.now() };
			saveStore(data);
			return { models: await applyData(ctx), downloaded: dataset.downloaded };
		})().finally(() => {
			dataRefresh = undefined;
		}));

	// Runs a refresh and reports it: in the log, in the footer, and (when asked for, or when something changed) as a notice.
	const refreshAndReport = async (ctx: ExtensionContext, force: boolean, announce: boolean) => {
		try {
			const summary = await refreshData(ctx, force);
			dataError = undefined;
			ifSessionAlive(() => {
				trace(ctx, { event: "data", action: summary.models > 0 ? "updated" : "unchanged", models: summary.models, dataset: data.datasetVersion, downloaded: summary.downloaded });
				showData(ctx);
				if (!ctx.hasUI || (!announce && summary.models === 0)) return;
				const changed = summary.models > 0 ? `${summary.models} model${summary.models === 1 ? "" : "s"} updated in ${modelsPathLabel()}` : `${modelsPathLabel()} already holds it`;
				const current = ctx.model ? `\nThis model: ${describeFound(foundFor(ctx, ctx.model))}` : "";
				ctx.ui.notify(`Model data from ${DATA_SOURCE}: ${changed}${announce ? current : ""}`, "info");
			});
		} catch (error) {
			dataError = error instanceof Error ? error.message : String(error);
			ifSessionAlive(() => {
				trace(ctx, { event: "data", action: "failed", reason: dataError });
				showData(ctx);
				if (ctx.hasUI && announce) ctx.ui.notify(`pi-cache-keeper could not refresh the model data: ${dataError}. The saved data stays in use.`, "warning");
			});
		}
	};

	// Where a proxy's models come from changed: what is new to look up is fetched (when this session may fetch);
	// otherwise models.json follows at once.
	const followUpstreams = (ctx: ExtensionContext, afterRefresh = false) => {
		upstreamsChanged = false;
		if (!config.modelData) return;
		// A refresh already running looked for what was needed before: look again when it ends (once, so a failing
		// refresh is not tried again and again).
		if (dataRefresh && !afterRefresh) {
			void dataRefresh.then(
				() => followUpstreams(ctx, true),
				() => followUpstreams(ctx, true),
			);
			return;
		}
		ifSessionAlive(() => {
			const missing = neededProviders(ctx).some((provider) => data.providers[provider] === undefined);
			if (missing && ctx.hasUI && !process.env.PI_OFFLINE) void refreshAndReport(ctx, false, false);
			else if (data.checkedAt !== undefined) void applyData(ctx).then(() => ifSessionAlive(() => showData(ctx)), () => {});
		});
	};

	// At the start of an interactive session: ask providers.dev again when the saved data is a day old, or when pi
	// can now use a provider it has no data for. Never waited for, and never in PI_OFFLINE mode.
	const refreshDataIfDue = (ctx: ExtensionContext) => {
		// Turned off by hand in settings.json: take this extension's values out of models.json, as the menu does.
		// The footer then shows Pi's own values again.
		if (!config.modelData && Object.keys(data.written).length > 0) void applyData(ctx).then(() => ifSessionAlive(() => showData(ctx)), () => {});
		if (!config.modelData || !ctx.hasUI || process.env.PI_OFFLINE) return;
		const due = data.checkedAt === undefined || Date.now() - data.checkedAt > DATA_MAX_AGE_MS || neededProviders(ctx).some((provider) => data.providers[provider] === undefined);
		if (due) void refreshAndReport(ctx, false, false);
	};

	// `timer` (the model and lifetime) is logged with keep-warm on; with it off the records are as they were.
	const compactBeforeExpiry = (ctx: ExtensionContext, remainingMs: number, timer: TimerContext = {}) => {
		if (!config.compactBeforeExpiry) return;
		const secondsLeft = Math.ceil(remainingMs / 1000);
		const contextTokens = ctx.getContextUsage()?.tokens ?? undefined;
		const skip = (reason: string) => trace(ctx, { event: "expiry", action: "skip", reason, secondsLeft, contextTokens, ...timer });
		let compactionOn: boolean;
		try {
			compactionOn = autoCompactionEnabled(ctx.isProjectTrusted() ? ctx.cwd : undefined);
		} catch (error) {
			return skip(`Pi's settings could not be read: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!compactionOn) return skip("automatic compaction is off in Pi's settings");
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return skip("Pi is busy or has queued messages");
		if (contextTokens === undefined) return skip("the context size is unknown");
		if (contextTokens < config.minContextTokens) {
			return skip(`the context holds ${formatTokens(contextTokens)} tokens, under minContextTokens (${formatTokens(config.minContextTokens)})`);
		}
		const check = checkCachedPath(ctx.sessionManager.getBranch(), ctx.model);
		if ("reason" in check) return skip(check.reason);
		trace(ctx, { event: "expiry", action: "compact", secondsLeft, contextTokens, ...timer });
		ownTrigger = "expiry";
		stopTimer(ctx);
		if (ctx.hasUI) {
			ctx.ui.notify(`Prompt cache expires in ${secondsLeft}s with ${formatTokens(contextTokens)} tokens of context. Compacting now, while the cache is warm.`, "info");
		}
		ctx.compact({
			onComplete: () => {
				ownTrigger = undefined;
			},
			onError: () => {
				ownTrigger = undefined;
				ifSessionAlive(() => {
					if (ctx.isIdle()) startTimer(ctx, false);
				});
			},
		});
	};

	// After a turn, compacts once the context passes compactAtPercent of the window or the compactAtTokens cap,
	// whichever comes first, so a summary still fits beside it
	// and the cache the turn just wrote is warm. Returns whether a compaction started.
	const compactWhenFull = (ctx: ExtensionContext): boolean => {
		// In print and JSON mode nothing follows a settled run: the process is exiting, so a compaction started here is
		// cut off before its request is sent. There, Pi's own between-turn check (compaction.reserveTokens) starts
		// compaction during the run, and session_before_compact still writes that summary from the cache.
		if (!ctx.hasUI) return false;
		const threshold = ctx.model ? fullThreshold(ctx.model, config.compactAtPercent, config.compactAtTokens) : undefined;
		const contextTokens = ctx.getContextUsage()?.tokens ?? undefined;
		if (threshold === undefined || contextTokens === undefined || contextTokens < threshold) {
			lastFullSkip = undefined;
			fullStuck = false;
			return false;
		}
		const cap = config.compactAtTokens > 0 && threshold === config.compactAtTokens ? config.compactAtTokens : undefined;
		const base = { contextTokens, threshold, percent: config.compactAtPercent, ...(cap === undefined ? {} : { tokens: cap }) };
		const skip = (reason: string) => {
			if (reason !== lastFullSkip) trace(ctx, { event: "full", action: "skip", reason, ...base });
			lastFullSkip = reason;
			return false;
		};
		if (fullStuck) return skip("the last compaction left the context past the mark (raise compactAtPercent or compactAtTokens, or keep fewer recent tokens)");
		let compactionOn: boolean;
		try {
			compactionOn = autoCompactionEnabled(ctx.isProjectTrusted() ? ctx.cwd : undefined);
		} catch (error) {
			return skip(`Pi's settings could not be read: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!compactionOn) return skip("automatic compaction is off in Pi's settings");
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return skip("Pi is busy or has queued messages");
		lastFullSkip = undefined;
		trace(ctx, { event: "full", action: "compact", ...base });
		ownTrigger = "full";
		stopTimer(ctx);
		if (ctx.hasUI) {
			const mark = cap === undefined ? `${config.compactAtPercent}% of the model's window` : `your ${formatTokens(cap)}-token cap`;
			ctx.ui.notify(`The context holds ${formatTokens(contextTokens)} tokens, past ${mark}. Compacting now, while the cache is warm.`, "info");
		}
		ctx.compact({
			onComplete: () => {
				ownTrigger = undefined;
				ifSessionAlive(() => {
					const after = ctx.getContextUsage()?.tokens;
					fullStuck = after !== undefined && after !== null && after >= threshold;
				});
			},
			onError: () => {
				ownTrigger = undefined;
				fullStuck = true;
				ifSessionAlive(() => {
					if (ctx.isIdle()) startTimer(ctx);
				});
			},
		});
		return true;
	};

	// What the log and the footer say about a period's budget and why warming ended.
	const budgetRecord = (p: WarmPeriod & { budget: WarmBudget }): WarmTrace["budget"] =>
		p.budget.priced
			? { unit: "usd", spent: p.spending.spent, limit: p.budget.missCost, next: reserveFor(p.budget, p.spending) }
			: { unit: "refreshes", spent: p.spending.refreshes, limit: MAX_UNPRICED_REFRESHES };
	const endedStatus = (p: WarmPeriod & { budget: WarmBudget }): string | undefined =>
		p.ended && `keep-warm ended (${stopLabel(p.ended.stop, keepWarmLabel(warmMinutes()))}): ${spendingText(p.budget, p.spending)}`;
	const warmBase = (ctx: ExtensionContext, p: WarmPeriod, expiresAt: number, timer: TimerContext) => ({
		event: "warm" as const,
		secondsLeft: Math.ceil((expiresAt - Date.now()) / 1000),
		contextTokens: ctx.getContextUsage()?.tokens ?? undefined,
		idleMinutes: Math.floor((Date.now() - p.idleSince) / 60_000),
		...timer,
	});
	// Keeping warm ends for the rest of the period, once: returns the fields of the one record that says so.
	const endWarm = (p: WarmPeriod, stop: WarmStop, reason: string): { stop: WarmStop; reason: string } | Record<string, never> => {
		if (p.ended) return {};
		p.ended = { stop, reason };
		return { stop, reason };
	};
	const budgetReason = (p: WarmPeriod & { budget: WarmBudget }, gate: boolean): string => {
		const { budget, spending } = p;
		if (!budget.priced) return `${spending.refreshes} refreshes since the last answer, the most without prices (the model has none, so the cost of a cache miss is unknown)`;
		return gate
			? `refreshing has cost ${formatUsd(spending.spent)} since the last answer; another refresh (${formatUsd(reserveFor(budget, spending))}) would pass the ${formatUsd(budget.missCost)} one cache miss costs`
			: `refreshing has cost ${formatUsd(spending.spent)} since the last answer, as much as the ${formatUsd(budget.missCost)} one cache miss costs`;
	};
	const limitReason = () => `the cache lasts to the end of the ${keepWarmLabel(warmMinutes())} limit after Pi went idle`;

	// What the countdown reads. In a period the extension keeps warm, the expiry is counted with the lifetime the period
	// started with, and each read is compared with what the period started with (model, lifetime, tier): on any
	// difference warming ends for the period, without another refresh. Otherwise (keep-warm off included) as before.
	// A fresh read of what an owned period fixed, against the fixed values: what differs, if anything.
	const readDrift = (ctx: ExtensionContext, p: WarmPeriod & { fixed: NonNullable<WarmPeriod["fixed"]> }): string | undefined => {
		const model = ctx.model;
		if (!model) return `there is no model now, the cached request was written with ${p.fixed.model}`;
		const entries = ctx.sessionManager.getBranch();
		return driftReason(p.fixed, model, keptState(model, entries, p.fixed.requested), cacheTier(entries, model, p.fixed.requested));
	};
	const timerState = (ctx: ExtensionContext): CacheState | undefined => {
		const model = ctx.model;
		if (!model) return undefined;
		const entries = ctx.sessionManager.getBranch();
		const state = stateOf(model, entries);
		const p = period;
		if (!owns(p)) return state;
		const { fixed } = p;
		const expiresAt = state.refreshedAt === undefined ? undefined : state.refreshedAt + fixed.ms;
		const drift = p.ended ? undefined : readDrift(ctx, p);
		if (drift) {
			const timer = { model: fixed.model, lifetimeSeconds: fixed.ms / 1000, lifetimeSource: fixed.source };
			trace(ctx, { ...warmBase(ctx, p, expiresAt ?? Date.now(), timer), action: "skip", ...endWarm(p, "unable", drift), budget: budgetRecord(p) });
		}
		return { ...state, lifetime: { ms: fixed.ms, source: fixed.source }, expiresAt };
	};

	// The time limit takes effect: the cache already lasts to `idleSince + keepWarmMinutes` or beyond (the answer's own
	// lifetime covers the window, or Pi's refresh from the run just ended carried it there), so no refresh goes out in
	// this period. Recorded when it happens. A refresh of the extension's that carries the cache there says so itself.
	const noteLimit = (ctx: ExtensionContext, expiresAt: number, timer: TimerContext) => {
		const p = period;
		if (!owns(p) || p.ended || running || wantsWarm(expiresAt, p.idleSince, warmMinutes())) return;
		trace(ctx, { ...warmBase(ctx, p, expiresAt, timer), action: "skip", ...endWarm(p, "limit", limitReason()), budget: budgetRecord(p) });
	};

	// The last gate: the only way a refresh payload leaves. Called as the last thing in the payload hook, after which only
	// the reservation and the return follow. It checks, in this order, on a fresh read: the refresh was not cancelled;
	// keep-warm is still on in the current settings; the period is the one the refresh was started for and has not
	// ended; the period's fixed facts still read the same (model, tier, lifetime); Pi is idle and nothing is queued; the
	// last safe moment has not passed; the payload's output limit is within the API's proven refresh limit. "hold": a
	// passing reason, tried again per R2 (a cancelled refresh, by the run that cancelled it); "refuse": withheld for good,
	// and warming ends for the period where it has not ended yet.
	type GateVerdict = { pass: true } | { hold: "cancelled" | "busy" | "late"; reason: string } | { refuse: string };
	const lastGate = (
		ctx: ExtensionContext,
		p: WarmPeriod & { fixed: NonNullable<WarmPeriod["fixed"]> },
		signal: AbortSignal,
		lastSafe: number,
		api: string,
		payload: Payload | undefined,
		unbuilt?: string,
	): GateVerdict => {
		if (signal.aborted) return { hold: "cancelled", reason: "the refresh was cancelled before it went out" };
		const setting = keepWarmSetting(true);
		if (!setting) return { refuse: "the settings could not be read" };
		if (setting.minutes <= 0) return { refuse: "keep-warm was turned off" };
		if (period !== p) return { refuse: "a new idle period started" };
		if (p.ended) return { refuse: `keep-warm ended: ${p.ended.reason}` };
		// Two misses in a row on this model since the period started (another period's refresh): it is Pi's now.
		const fellBackAt = misses.fallback.get(p.fixed.model);
		if (fellBackAt !== undefined) return { refuse: fallbackLine(p.fixed.model, fellBackAt) };
		const drift = readDrift(ctx, p);
		if (drift) return { refuse: drift };
		if (running || !ctx.isIdle() || ctx.hasPendingMessages()) return { hold: "busy", reason: "Pi is busy or has queued messages" };
		if (Date.now() > lastSafe) return { hold: "late", reason: "the cache was about to expire before the refresh went out" };
		if (!payload) return { refuse: unbuilt ?? "the refresh payload could not be built" };
		const cap = limitWithinCap(api, payload);
		if ("reason" in cap) return { refuse: cap.reason };
		return { pass: true };
	};

	// Keep-warm now reads off (in this window or another) in a period that started while it read on and was kept warm by
	// the extension: warming ends there, said once. Pi's own warming may already have been stopped for the period.
	const noteSwitchOff = (ctx: ExtensionContext, expiresAt: number, timer: TimerContext) => {
		const p = period;
		if (!p || !p.onAtStart || p.notOwned !== undefined || !p.budget || !p.fixed || p.ended || running) return;
		const budget = p.budget;
		const reason = keepWarmSetting() ? "keep-warm was turned off" : "the settings could not be read";
		trace(ctx, { ...warmBase(ctx, p, expiresAt, timer), action: "skip", ...endWarm(p, "unable", reason), budget: budgetRecord({ ...p, budget }) });
	};

	// Shortly before the cache expires, while Pi is idle in a period the extension owns, inside the keep-warm window and
	// the budget, re-sends the period's request exactly as it was sent with a one-token answer, so the cache entry is
	// read and its lifetime starts again. Called on every tick from `warmLead` before expiry: a refresh held back for a
	// passing reason (Pi busy, a message queued, Pi's own refresh from the run just ended still in flight) is tried again
	// until the last safe moment, half the lead before expiry; a lasting reason ends warming for the period.
	const keepWarm = (ctx: ExtensionContext, expiresAt: number, warmLead: number, timer: TimerContext) => {
		const p = period;
		if (!owns(p) || p.ended || running || p.doneFor === expiresAt || !wantsWarm(expiresAt, p.idleSince, warmMinutes())) return;
		const base = warmBase(ctx, p, expiresAt, timer);
		const lastSafe = expiresAt - Math.floor(warmLead / 2);
		if (Date.now() > lastSafe) {
			p.doneFor = expiresAt;
			trace(ctx, { ...base, action: "skip", reason: "too late: less than half the warm lead is left before the cache expires, so a refresh would likely arrive after it" });
			return;
		}
		if (!ctx.isIdle() || ctx.hasPendingMessages()) {
			if (p.busyFor !== expiresAt) trace(ctx, { ...base, action: "skip", reason: "Pi is busy or has queued messages; tried again until the last safe moment" });
			p.busyFor = expiresAt;
			return;
		}
		// Pi's own refresh from the run just ended may still be in flight; its usage entry moves the expiry when it lands.
		if (piWarmAt !== undefined && Date.now() - piWarmAt < 60_000) return;
		// Read again just before a refresh: a model, lifetime or tier other than the period's ends warming.
		timerState(ctx);
		if (p.ended) return;
		const check = checkRequestPath(ctx.sessionManager.getBranch(), ctx.model, p.request);
		if ("reason" in check) {
			trace(ctx, { ...base, action: "skip", ...endWarm(p, "unable", check.reason), budget: budgetRecord(p) });
			return;
		}
		if (!gateAllows(p.budget, p.spending)) {
			trace(ctx, { ...base, action: "skip", ...endWarm(p, "budget", budgetReason(p, true)), budget: budgetRecord(p) });
			return;
		}
		p.doneFor = expiresAt;
		const { request } = check;
		const sent = request.payload as Payload;
		const { budget, spending } = p;
		let out = false;
		let reserved = 0;
		let late = false;
		let held = false;
		let refused: string | undefined;

		const controller = new AbortController();
		warming = controller;
		const started = Date.now();
		// The level the cached request was sent with, as its payload shows it.
		const thinkingLevel = payloadThinking(request.model.api, sent);
		void (async () => {
			let response: AssistantMessage | undefined;
			let error: string | undefined;
			try {
				response = await ctx.modelRegistry
					.streamSimple(request.model, { messages: convertToLlm(request.transcript) }, {
						reasoning: thinkingLevel === "off" ? undefined : thinkingLevel,
						maxTokens: 1,
						maxRetries: 0,
						// Repeats the last request; it must not replace the conversation's provider-side thread state.
						...({ disableContinuation: true } as object),
						sessionId: ctx.sessionManager.getSessionId(),
						signal: controller.signal,
						onPayload: (params: unknown) => {
							const built = warmPayload(params, sent);
							const payload = "payload" in built ? built.payload : undefined;
							// The last gate, the last check; nothing is reserved before it passes.
							let verdict: GateVerdict;
							try {
								verdict = lastGate(ctx, p, controller.signal, lastSafe, request.model.api, payload, "reason" in built ? built.reason : undefined);
							} catch {
								// The session's context is gone (/new, /reload, Pi exiting): nothing leaves.
								verdict = { refuse: "the session ended before the refresh went out" };
							}
							if ("hold" in verdict) {
								if (verdict.hold === "busy") held = true;
								if (verdict.hold === "late") late = true;
								throw new Error(verdict.reason);
							}
							if ("refuse" in verdict) {
								refused = verdict.refuse;
								throw new Error(verdict.refuse);
							}
							// It goes out: reserved at the larger of its expected cost and what the last refresh really cost.
							out = true;
							reserved = reserveFor(budget, spending);
							spending.spent += reserved;
							spending.refreshes += 1;
							return payload;
						},
					})
					.result();
			} catch (caught) {
				error = caught instanceof Error ? caught.message : String(caught);
			}
			if (warming === controller) warming = undefined;
			// What the refresh reported it cost replaces the reserve; without a report (an error or abort before any
			// usage, a model without prices) the reserve stays.
			const reported = out && budget.priced ? (response?.usage?.cost?.total ?? 0) : 0;
			if (reported > 0) {
				spending.spent += reported - reserved;
				spending.last = reported;
			}
			const used = response?.usage;
			const usage = out && used && used.input + used.cacheRead + used.cacheWrite + used.output > 0 ? traceUsage(used) : undefined;
			const seconds = (Date.now() - started) / 1000;
			const aborted = controller.signal.aborted || response?.stopReason === "aborted";
			const failed = !aborted && !held && !refused && !late && (!response || response.stopReason === "error");
			const failure = error ?? response?.errorMessage ?? "the request failed";
			// Whatever the outcome: once the period's spending reached its limit, warming ends.
			const reached = () => (out && budgetReached(budget, spending) ? endWarm(p, "budget", budgetReason(p, false)) : undefined);
			// What the refresh shows, however it ended: only reported usage with a prompt is evidence. Under 90% of the
			// prompt read from the cache is a miss, the rest a hit; without a prompt in the usage it is neither.
			const prompt = out && used ? used.input + used.cacheRead + used.cacheWrite : 0;
			const share = used && prompt > 0 ? used.cacheRead / prompt : undefined;
			const verdict = share === undefined ? undefined : share < MIN_WARM_CACHED_SHARE ? "miss" : "hit";
			const missReason = `the refresh read only ${Math.floor(100 * (share ?? 0))}% from the cache, so it wrote the context again`;
			// Recorded here, without the session's context, which may be gone (/new, /reload, Pi exiting): the model's run of
			// misses (two in a row and it is left to Pi), the period's end, the timer's bookkeeping.
			const fellBack = verdict ? recordRefresh(p.fixed.model, verdict, started) : false;
			let ended: ReturnType<typeof endWarm> | undefined;
			if (out) {
				ended =
					reached() ??
					(verdict === "miss" ? endWarm(p, "missed", failed ? `${missReason} before it failed: ${failure}` : missReason) : failed ? endWarm(p, "failed", failure) : undefined);
			} else if (refused) ended = endWarm(p, "unable", refused);
			else if (failed) ended = endWarm(p, "failed", failure);
			if ((aborted || held) && p.doneFor === expiresAt) p.doneFor = undefined;
			// Either way the provider refreshed (or wrote) the entry when it received the request.
			if (out && !aborted && !failed) warmedAt = started;
			const fallback = fellBack ? { leftToPi: fallbackLine(p.fixed.model, started) } : {};
			// What is said and shown, only while the session is alive.
			ifSessionAlive(() => {
				if (fellBack && ctx.hasUI) {
					ctx.ui.notify(`Two refreshes in a row missed the cache for ${p.fixed.model}, so pi-cache-keeper stopped keeping it warm; Pi's own warming takes over. /cache-keeper-warm starts it again.`, "warning");
				}
			});
			// A real request started (or the session moved on); it refreshes the cache itself. What went out stays counted.
			// If that run sent nothing, the refresh for this expiry is tried again, as for any passing hold-up.
			if (aborted) {
				if (!out) return;
				ifSessionAlive(() => {
					trace(ctx, { ...base, action: "cancelled", seconds, ...ended, reason: "a new request or a change of session cancelled it", usage, budget: budgetRecord(p), ...fallback });
				});
				return;
			}
			ifSessionAlive(() => {
				if (held) {
					// Tried again on the next ticks, as any passing hold-up.
					if (p.busyFor !== expiresAt) trace(ctx, { ...base, action: "skip", seconds, reason: "Pi got busy or a message was queued while the refresh was being prepared, so it was withheld; tried again until the last safe moment" });
					p.busyFor = expiresAt;
				} else if (refused) {
					// Withheld for good; warming ends with the reason where it has not ended yet.
					trace(ctx, { ...base, action: "skip", seconds, ...ended, reason: refused, budget: budgetRecord(p) });
				} else if (late) {
					trace(ctx, { ...base, action: "skip", seconds, reason: "too late: the cache was about to expire before the refresh went out, so it was not sent" });
				} else if (failed) {
					if (ctx.hasUI) ctx.ui.notify(`pi-cache-keeper could not keep the cache warm: ${failure}`, "warning");
					trace(ctx, { ...base, action: "failed", seconds, ...ended, reason: failure, usage, budget: budgetRecord(p), ...fallback });
				} else {
					const after = timerState(ctx)?.expiresAt;
					const limit = !ended && after !== undefined && !wantsWarm(after, p.idleSince, warmMinutes()) ? endWarm(p, "limit", limitReason()) : undefined;
					trace(ctx, { ...base, action: verdict === "miss" ? "missed" : "warm", seconds, ...(ended ?? limit), usage, budget: budgetRecord(p), ...fallback });
					if (verdict === "miss" && !fellBack && ctx.hasUI) {
						ctx.ui.notify(`Keeping the cache warm read only ${Math.floor(100 * (share ?? 0))}% from the cache, so it wrote the context again. Stopped until your next message.`, "warning");
					}
				}
				if (ctx.isIdle()) startTimer(ctx);
			});
		})();
	};

	const startTimer = (ctx: ExtensionContext, compactAtExpiry = true) => {
		stopTimer(ctx, false);
		const readState = () => timerState(ctx);
		const first = readState();
		if (first?.expiresAt === undefined) return renderFooter(ctx);
		let expiresAt = first.expiresAt;
		const warmLead = first.lifetime ? warmLeadMs(first.lifetime.ms, EXPIRY_LEAD_MS) : 0;
		const timer: TimerContext = {
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			lifetimeSeconds: first.lifetime && first.lifetime.ms / 1000,
			lifetimeSource: first.lifetime?.source,
		};
		let ticks = 0;
		let attempted = !compactAtExpiry;
		let warmChecked = false;
		const tick = () => {
			if (++ticks % 15 === 0 || expiresAt - Date.now() <= Math.max(EXPIRY_LEAD_MS, warmLead)) expiresAt = readState()?.expiresAt ?? expiresAt;
			const remaining = expiresAt - Date.now();
			const keepWarmOn = warmMinutes() > 0;
			if (keepWarmOn && remaining > 0 && !warming) noteLimit(ctx, expiresAt, timer);
			if (!keepWarmOn) noteSwitchOff(ctx, expiresAt, timer);
			countdown = warming ? { state: "refreshing" } : remaining > 0 ? { state: "warm", ms: remaining } : { state: "cold" };
			renderFooter(ctx);
			if (remaining <= 0) {
				// Expired (or the timer ran this late): nothing is refreshed or compacted from a cache that is gone.
				clearInterval(ticker);
				ticker = undefined;
			} else if (warming) {
				// Wait for the refresh; it restarts the countdown when it lands.
			} else if (!keepWarmOn || !owns(period)) {
				// Keep-warm off, or a period left to Pi: as with keep-warm off.
				if (remaining <= warmLead && !warmChecked) {
					warmChecked = true;
				} else if (remaining <= EXPIRY_LEAD_MS && !attempted) {
					// Pi's own refresh may still be in flight; its usage entry moves the expiry when it lands.
					if (piWarmAt !== undefined && Date.now() - piWarmAt < 30_000) return;
					attempted = true;
					compactBeforeExpiry(ctx, remaining);
				}
			} else {
				if (remaining <= warmLead) keepWarm(ctx, expiresAt, warmLead, timer);
				if (!warming && remaining <= EXPIRY_LEAD_MS && !attempted) {
					if (piWarmAt !== undefined && Date.now() - piWarmAt < 30_000) return;
					attempted = true;
					compactBeforeExpiry(ctx, remaining, timer);
				}
			}
		};
		// A tick runs outside any event of Pi's: if this session's context is gone (/new, /reload, Pi exiting before
		// session_shutdown stopped it), the timer stops instead of throwing out of a callback, which would end Pi.
		const own = setInterval(() => {
			try {
				tick();
			} catch {
				clearInterval(own);
				if (ticker === own) ticker = undefined;
			}
		}, 1000);
		ticker = own;
		own.unref();
		tick();
	};

	pi.on("context_with_system", (event) => {
		pendingTranscript = [...event.messages];
	});
	pi.on("before_provider_request", (event, ctx) => {
		const transcript = pendingTranscript;
		pendingTranscript = undefined;
		if (!ctx.model || !isPlainObject(event.payload)) return;
		const sharedKey = sharedPrefixKey(ctx.model, ctx.cwd);
		let payload = sharedKey ? withSharedPrefixCache(event.payload, sharedKey) : event.payload;
		const sharedPrefix = payload !== event.payload;
		if (isKimiOnMoonshot(ctx.model)) payload = withKimiLongCache(payload);
		if (transcript) {
			const tier = payloadTier(ctx.model.api, payload) ?? (process.env.PI_CACHE_RETENTION === "long" ? "long" : "short");
			captured = { transcript, payload, model: ctx.model, at: Date.now(), tier, cache: requestCache(payload), sharedPrefix };
		}
		return payload === event.payload ? undefined : payload;
	});
	pi.on("message_start", (event, ctx) => {
		const transcript = pendingTranscript;
		pendingTranscript = undefined;
		if (transcript && event.message.role === "assistant" && ctx.model?.api === BRIDGE_API) {
			captured = { transcript, model: ctx.model, at: Date.now(), tier: process.env.PI_CACHE_RETENTION === "long" ? "long" : "short" };
		}
	});
	// Which answer the captured request got, so a keep-warm period knows the request of its real answer.
	pi.on("message_end", (event) => {
		const message = event.message;
		if (message.role !== "assistant" || !captured || captured.answeredAt !== undefined) return;
		if (message.usage.cacheRead + message.usage.cacheWrite <= 0) return;
		captured.answeredAt = message.timestamp;
		answerRequest = captured;
	});
	pi.on("session_start", (_event, ctx) => {
		sessionCtx = ctx;
		// A new session, a reload or a restart starts a new idle period (its state is in memory).
		goIdle(ctx, true);
		applyRetention(config.cacheRetention === "long", ctx.hasUI);
		startTimer(ctx);
		// Another Pi window may have refreshed the data since this one loaded it.
		data = loadStore();
		showData(ctx);
		if (upstreamsChanged && !dataRefresh) followUpstreams(ctx);
		refreshDataIfDue(ctx);
		// Proxy extensions answer with where their models come from (UPSTREAMS_EVENT).
		if (config.modelData) pi.events.emit(REQUEST_EVENT, {});
		// The footer is fitted to the terminal's width again when it changes.
		if (ctx.hasUI && !onResize) {
			onResize = () => {
				const current = sessionCtx;
				if (current) ifSessionAlive(() => renderFooter(current));
			};
			process.stdout.on("resize", onResize);
		}
	});
	// One warmer per idle period. Where the extension keeps the period warm itself (see whyNotOwned), every decision of
	// Pi's own warming that arrives while the window is idle (between agent_settled and agent_start, and Pi idle) is
	// answered "stop". In any other state, and with keep-warm off, it returns nothing and Pi's decision stands.
	pi.on("cache_warming_decision", (event, ctx) => {
		const p = period;
		// A fresh read of the saved setting: a switch-off in any window holds from this decision on.
		keepWarmSetting(true);
		if (owns(p) && !running && ctx.isIdle()) {
			const state = ctx.model ? stateOf(ctx.model, ctx.sessionManager.getBranch()) : undefined;
			const expiresAt = state?.expiresAt ?? Date.now();
			trace(ctx, {
				...warmBase(ctx, p, expiresAt, {
					model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
					lifetimeSeconds: state?.lifetime && state.lifetime.ms / 1000,
					lifetimeSource: state?.lifetime?.source,
				}),
				action: "pi-stopped",
				reason: `this extension keeps this idle period's cache warm (Pi would have ${event.action === "warm" ? "refreshed" : "stopped"})`,
				budget: budgetRecord(p),
			});
			return { action: "stop" as const };
		}
		if (event.action === "warm") piWarmAt = Date.now();
		return undefined;
	});
	pi.on("agent_start", (_event, ctx) => {
		abortWarm();
		// The idle period, its spending and its time limit stay: they end only when this run brings a new real answer.
		running = true;
		stopTimer(ctx, false);
		// Keep the countdown's place during a request, so it does not appear and vanish with each turn.
		if (ctx.hasUI && ctx.model && stateOf(ctx.model, ctx.sessionManager.getBranch()).lifetime) countdown = { state: "running" };
		renderFooter(ctx);
	});
	pi.on("agent_settled", (_event, ctx) => {
		goIdle(ctx);
		// The latest answer may say which cache tier it wrote.
		showData(ctx);
		if (!compactWhenFull(ctx)) startTimer(ctx);
	});
	pi.on("session_compact", (event, ctx) => {
		const entry = event.compactionEntry;
		const result = trace(ctx, {
			event: "result",
			trigger: compactionTrigger ?? event.reason,
			by: event.fromExtension ? "extension" : "pi",
			entryId: entry.id,
			tokensBefore: entry.tokensBefore,
			usage: entry.usage ? traceUsage(entry.usage) : undefined,
			summaryChars: entry.summary.length,
		});
		// Pi redraws the chat after this handler returns; appending now would put the card above the summary.
		const records = decision ? [decision, result] : [result];
		setTimeout(() => ifSessionAlive(() => showCard(records)), 0);
		decision = undefined;
		compactionTrigger = undefined;
		forget(ctx);
		showData(ctx);
	});
	pi.on("session_compact_failed", (event, ctx) => {
		const failed = trace(ctx, { event: "failed", trigger: compactionTrigger ?? event.reason, aborted: event.aborted, error: event.errorMessage });
		if (decision) showCard(decision.outcome === "cancelled" && event.aborted ? [decision] : [decision, failed]);
		decision = undefined;
		compactionTrigger = undefined;
	});
	// A proxy extension says where its models come from (see the README): at its start, and when its list changes.
	pi.events.on(UPSTREAMS_EVENT, (payload) => {
		const event = parseUpstreamsEvent(payload);
		if (!event || JSON.stringify(data.upstreams[event.provider]) === JSON.stringify(event.models)) return;
		data = { ...data, upstreams: { ...data.upstreams, [event.provider]: event.models } };
		saveStore(data);
		if (sessionCtx) followUpstreams(sessionCtx);
		// Before this extension's session started: done then.
		else upstreamsChanged = true;
	});
	// And what served a request.
	pi.events.on(ANSWERED_EVENT, (payload) => {
		const event = parseAnsweredEvent(payload);
		const ctx = sessionCtx;
		if (!event) return;
		answered = { provider: event.provider, id: event.model, upstreams: event.upstreams };
		if (ctx) ifSessionAlive(() => showData(ctx));
	});
	pi.on("model_select", (_event, ctx) => {
		answered = undefined;
		forget(ctx);
		showData(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		forget(ctx);
		startTimer(ctx);
		// The request the footer says was sent is forgotten with the branch.
		showData(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		sessionCtx = undefined;
		if (onResize) process.stdout.off("resize", onResize);
		onResize = undefined;
		abortWarm();
		stopTimer(ctx, false);
		footerText = undefined;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	const checkCachedPath = (entries: SessionEntry[], model: Model<Api> | undefined): CachedPath | { reason: string } => checkRequestPath(entries, model, captured);
	// The same check for a given request: a keep-warm period checks the request of its own answer.
	const checkRequestPath = (entries: SessionEntry[], model: Model<Api> | undefined, request: CapturedRequest | undefined): CachedPath | { reason: string } => {
		if (!request) return { reason: "no request since the session started or compacted, or since the model or branch changed" };
		if (model?.provider !== request.model.provider || model.id !== request.model.id) return { reason: "the model changed since the last request" };
		let prefix: CachedPrefix | undefined;
		if (request.payload) {
			const key = messageArrayKey(request.payload);
			if (!key) return { reason: `${request.model.api} requests are not supported` };
			prefix = { payload: request.payload, key };
		}
		const trailing = trailingMessages(entries, request.transcript);
		if ("reason" in trailing) return { reason: `the conversation changed since the last request: ${trailing.reason}` };
		const cache = stateOf(request.model, entries);
		if (!cache.cached) return { reason: "the last request did not use the prompt cache" };
		if (cache.expiresAt !== undefined && Date.now() >= cache.expiresAt) return { reason: "the prompt cache has expired" };
		return { request, prefix, trailing: trailing.messages, cache };
	};

	pi.on("session_before_compact", async (event, ctx) => {
		// Before expiry, Pi's own compaction would pay full price for nothing urgent, so a failed cached path cancels;
		// when full, Pi's compaction is still wanted.
		const fromExpiry = ownTrigger === "expiry";
		const trigger: Trigger = ownTrigger ?? event.reason;
		compactionTrigger = trigger;
		const { preparation } = event;
		const record: CompactTrace = {
			event: "compact",
			trigger,
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none",
			outcome: "cached",
			tokensBefore: preparation.tokensBefore,
			cwd: ctx.cwd,
			sessionFile: ctx.sessionManager.getSessionFile(),
		};
		const fallBack = (reason: string, mismatch?: PrefixMismatch) => {
			const diff = mismatch?.captured === undefined ? undefined : { captured: mismatch.captured, rebuilt: mismatch.rebuilt };
			decision = trace(ctx, { ...record, outcome: fromExpiry ? "cancelled" : "fallback", reason, mismatch: diff });
			return fromExpiry ? { cancel: true } : undefined;
		};
		if (event.reason === "overflow") return fallBack("the last request overflowed the context window");
		const check = checkCachedPath(event.branchEntries, ctx.model);
		if ("reason" in check) return fallBack(check.reason);
		const { request, prefix, trailing, cache } = check;
		const lastUsage = getLastAssistantUsage(event.branchEntries);
		record.lastRequest = {
			secondsAgo: Math.round((Date.now() - request.at) / 1000),
			messages: request.transcript.length,
			promptTokens: lastUsage && lastUsage.input + lastUsage.cacheRead + lastUsage.cacheWrite,
			newMessages: trailing.length,
		};
		record.cache = {
			lifetimeSeconds: cache.lifetime && cache.lifetime.ms / 1000,
			source: cache.lifetime?.source,
			expiresInSeconds: cache.expiresAt === undefined ? undefined : Math.round((cache.expiresAt - Date.now()) / 1000),
		};

		const budget = summaryBudget(request.model, preparation.tokensBefore);
		if (budget !== undefined && budget < MIN_SUMMARY_TOKENS) {
			return fallBack(`only ${formatTokens(budget)} tokens of the context window are left for the summary (it needs ${formatTokens(MIN_SUMMARY_TOKENS)})`);
		}
		const maxTokens = budget ?? Math.floor(0.8 * preparation.settings.reserveTokens);

		const kept = keptStart(event.branchEntries, preparation.firstKeptEntryId, [...request.transcript, ...trailing]);
		if (!kept) return fallBack("no kept message in the request has text to mark where the summary ends");
		const instruction: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: summaryInstruction(kept, event.customInstructions) }],
			timestamp: Date.now(),
		};

		let mismatch: PrefixMismatch | undefined;
		const thinkingLevel = pi.getThinkingLevel();
		const controller = new AbortController();
		const disableTools = prefix !== undefined && isOpenAiResponses(request.model);
		const cacheNeutral = new Set(disableTools ? ["tool_choice"] : []);
		const sharedKey = prefix ? sharedPrefixKey(request.model, ctx.cwd) : undefined;
		const requestInfo = { thinking: thinkingLevel, bridgeFork: prefix === undefined, toolChoiceNone: disableTools, sharedPrefix: false };
		record.request = requestInfo;
		const started = Date.now();
		const sent = [...request.transcript, ...trailing, instruction];
		let response: AssistantMessage;
		try {
			response = await ctx.modelRegistry
				.streamSimple(request.model, { messages: convertToLlm(sent) }, {
				reasoning: thinkingLevel === "off" ? undefined : thinkingLevel,
				maxTokens,
				sessionId: ctx.sessionManager.getSessionId(),
				signal: AbortSignal.any([event.signal, controller.signal]),
				...(disableTools ? { toolChoice: "none" as const } : {}),
				...(prefix
					? {
						onPayload: (params: unknown) => {
							const built = summaryPayload(params, prefix, sharedKey, cacheNeutral);
							requestInfo.sharedPrefix = built.sharedPrefix;
							if ("reason" in built) {
								mismatch = built;
								throw new Error(PREFIX_MISMATCH);
							}
							return built.payload;
						},
					}
					: { headers: { [FORK_REQUEST_HEADER]: "1" }, cacheRetention: "none" as const }),
				})
				.result();
		} catch (error) {
			return fallBack(`the summary request failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		// A bridge query that called a tool waits for the result until aborted.
		if (response.stopReason === "toolUse") controller.abort();
		const summary = contentText(response.content).trim();
		record.response = {
			stopReason: response.stopReason,
			seconds: (Date.now() - started) / 1000,
			usage: traceUsage(response.usage),
			summaryChars: summary.length,
			error: mismatch ? undefined : response.errorMessage,
		};

		if (response.stopReason === "aborted") {
			decision = trace(ctx, { ...record, outcome: "cancelled", reason: "the compaction was aborted" });
			return { cancel: true };
		}
		if (mismatch) return fallBack(mismatch.reason, mismatch);
		if (response.stopReason === "error") return fallBack(response.errorMessage ?? "the summary request failed");
		if (response.stopReason === "length") return fallBack("the summary hit the output limit");
		if (response.stopReason === "toolUse") return fallBack("the model called a tool instead of writing the summary");
		if (!summary) return fallBack("the model returned no summary text");

		const checkpoint = checkpointSummary(summary, preparation.fileOps, getLatestCompactionEntry(event.branchEntries)?.details);
		const promptTokens = response.usage.input + response.usage.cacheRead + response.usage.cacheWrite;
		if (promptTokens > 0) {
			const piInput = piCompactionInput(preparation, sent, promptTokens);
			const piUsage: Usage = { ...response.usage, input: piInput, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cost: { ...response.usage.cost } };
			record.piEstimate = { input: piInput, cost: calculateCost(request.model, piUsage).total };
		}
		decision = trace(ctx, record);

		return {
			compaction: {
				summary: checkpoint.summary,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				usage: response.usage,
				details: { readFiles: checkpoint.readFiles, modifiedFiles: checkpoint.modifiedFiles },
			},
		};
	});

	const percentLabel = (percent: number) => (percent === 0 ? "off" : `${percent}%`);
	const capLabel = (tokens: number) => (tokens === 0 ? "off" : `${formatTokens(tokens)} tokens`);
	const fullNote = (model: Model<Api> | undefined): string => {
		const { compactAtPercent: percent, compactAtTokens: cap } = config;
		if (percent === 0 && cap === 0) return "off: Pi compacts only when the window is nearly full, often with too little room left for a cached summary";
		const at = model ? fullThreshold(model, percent, cap) : undefined;
		if (!model || at === undefined) return `at ${percent}% of the window; the current model declares no window, so not here`;
		const byCap = cap > 0 && at === cap;
		const budget = summaryBudget(model, at);
		const room = budget === undefined ? "" : `, leaving ${formatTokens(budget)} for the summary`;
		const tight = budget !== undefined && budget < MIN_SUMMARY_TOKENS ? `, too little for a cached summary: pick a lower ${byCap ? "cap" : "percentage"}` : "";
		const mark = byCap ? `at the ${formatTokens(cap)}-token cap` : `at ${percent}%: ${formatTokens(at)} of ${formatTokens(model.contextWindow)}`;
		return `${mark} on ${model.provider}/${model.id}${room}${tight}`;
	};
	const expiryNote = () => (config.compactBeforeExpiry ? `on, from ${formatTokens(config.minContextTokens)} tokens of context` : "off");
	const keepWarmNote = (model: Model<Api> | undefined) => {
		const minutes = warmMinutes(true);
		if (minutes <= 0) return "off";
		const p = period;
		const rule = keepWarmRule(minutes, p?.budget ? p.budget.priced : !model || hasPrices(model));
		if (!p || running) return rule;
		const fellBack = fallbackFor(model);
		const line = fellBack && fallbackLine(fellBack.key, fellBack.at);
		if (p.notOwned !== undefined) return `${rule}; ${line && p.notOwned === line ? line : `this session is left to Pi's own warming: ${p.notOwned}`}`;
		if (!owns(p)) return line ? `${rule}; ${line}` : rule;
		const window = line ? `; ${line}` : "";
		if (p.ended) return `${rule}; ${endedStatus(p)}, until your next message (${p.ended.reason})${window}`;
		return `${rule}; so far ${spendingText(p.budget, p.spending)}`;
	};

	const dataNote = (ctx: ExtensionContext): string => {
		if (!config.modelData) return "off";
		const failed = dataError ? `; the last refresh failed: ${dataError}` : "";
		if (data.checkedAt === undefined) return `not fetched from ${DATA_SOURCE} yet${failed}; /cache-keeper-refresh fetches it`;
		const model = ctx.model;
		let found = model ? describeFound(foundFor(ctx, model)) : "no model";
		const otherwise = servedOtherwise(model);
		if (model && otherwise) {
			const via = accessVia({ upstreams: otherwise });
			const what = via === "api" ? "an API key" : via === "sub" ? "a login" : "another account";
			found += `; the last answer came from ${what}: ${describeFound(findFacts(lookupsFor(model, { upstreams: otherwise }), data.providers))}`;
		}
		return `${found} (${DATA_SOURCE}, checked ${formatDuration(Date.now() - data.checkedAt)} ago${failed}; /cache-keeper-refresh fetches it again)`;
	};

	const openSettings = async (ctx: ExtensionCommandContext) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify(
				[
					`pi-cache-keeper settings (${settingsKeyInUse()} in ~/.pi/agent/settings.json; /cache-keeper-settings in the TUI changes them and saves them to ${SETTINGS_KEY})`,
					`compactAtPercent: ${config.compactAtPercent} · compactAtTokens: ${config.compactAtTokens} (${fullNote(ctx.model)})`,
					`compactBeforeExpiry: ${config.compactBeforeExpiry} · minContextTokens: ${config.minContextTokens}`,
					`keepWarmMinutes: ${warmMinutes(true)} (${keepWarmNote(ctx.model)})`,
					`cacheRetention: ${config.cacheRetention}`,
					`modelData: ${config.modelData} (${dataNote(ctx)})`,
				].join("\n"),
				"info",
			);
			return;
		}
		const percents = [...new Set([...COMPACT_AT_PERCENTS, config.compactAtPercent])].sort((a, b) => a - b);
		const caps = [...new Set([...COMPACT_AT_TOKEN_CHOICES, config.compactAtTokens])].sort((a, b) => a - b);
		const minimums = [...new Set([...MIN_CONTEXT_CHOICES, config.minContextTokens])].sort((a, b) => a - b);
		const warmChoices = [...new Set([...KEEP_WARM_CHOICES, config.keepWarmMinutes])].sort((a, b) => a - b);
		const fullItem: SettingItem = {
			id: "compactAtPercent",
			label: "Compact when the context is",
			currentValue: percentLabel(config.compactAtPercent),
			values: percents.map(percentLabel),
			description: "",
		};
		const describeFull = () => {
			fullItem.description = `After a turn, once the context fills this share of the model's window, compact from the warm cache so the summary still fits beside it. Now ${fullNote(ctx.model)}.`;
		};
		describeFull();
		const warmItem: SettingItem = {
			id: "keepWarmMinutes",
			label: "Keep the cache warm when idle",
			currentValue: keepWarmLabel(config.keepWarmMinutes),
			values: warmChoices.map(keepWarmLabel),
			description: "",
		};
		const describeWarm = () => {
			warmItem.description = `Up to this long after Pi goes idle, re-send the last request with a one-token answer shortly before the cache expires, so your next message still reads it cheaply. Each refresh reads the whole context from the cache (about a tenth of the input price on Anthropic), and warming stops once refreshing has cost as much as one cache miss (writing the context again, less the cached read); a model without prices gets at most ${MAX_UNPRICED_REFRESHES} refreshes. While keep-warm is on, this extension is the only thing that keeps an idle cache warm, and Pi's own idle warming is told to stop; Pi still warms during a run. Sessions this extension cannot refresh itself are left to Pi's own warming: no cache lifetime or one under a minute, or a request that cannot be re-sent (Claude through pi-claude-bridge, Claude's budget-based thinking, or an API other than Anthropic Messages, OpenAI Completions and OpenAI Responses, whose answer the extension cannot cap). When warming ends, compact before expiry takes over. Now: ${keepWarmNote(ctx.model)}.`;
		};
		describeWarm();
		const items: SettingItem[] = [
			fullItem,
			{
				id: "compactAtTokens",
				label: "Or once it holds",
				currentValue: capLabel(config.compactAtTokens),
				values: caps.map(capLabel),
				description:
					"Also compact after a turn once the context holds this many tokens, on any model, whichever comes first. Every request reads the whole context from the cache, so a smaller context makes each request cheaper; older detail is summarized sooner.",
			},
			{
				id: "compactBeforeExpiry",
				label: "Compact before the cache expires",
				currentValue: config.compactBeforeExpiry ? "on" : "off",
				values: ["on", "off"],
				description: "20 s before the prompt cache expires, when Pi is idle, compact from the still-warm cache instead of paying to write the whole session again with your next message.",
			},
			warmItem,
			{
				id: "minContextTokens",
				label: "Before expiry, only from",
				currentValue: formatTokens(config.minContextTokens),
				values: minimums.map(formatTokens),
				description: "The smallest context compacted before the cache expires; smaller sessions are cheap to write again, so they are left to cool. Keeping the cache warm doesn't use it: its budget grows and shrinks with the context.",
			},
			{
				id: "cacheRetention",
				label: "Cache retention",
				currentValue: config.cacheRetention,
				values: ["short", "long"],
				description: "long asks for the longer cache in interactive sessions (2× the write price on Anthropic and Kimi); short keeps Pi's default. Applies from the next request.",
			},
			{
				id: "modelData",
				label: "Model data from providers.dev",
				currentValue: config.modelData ? "on" : "off",
				values: ["on", "off"],
				description: `Once a day, read each model's input window, cache lifetimes and prices from ${DATA_SOURCE} (a public API: no key, and nothing about your sessions is sent) and put them into ~/.pi/agent/models.json: the window replaces Pi's, lifetimes and prices fill what Pi has none for, and values you set there yourself are never touched. The footer shows the current model's values and marks a guess. off takes these values out again.`,
			},
		];
		await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
			const list = new SettingsList(
				items,
				items.length + 2,
				getSettingsListTheme(),
				(id, value) => {
					let patch: Partial<CacheKeeperConfig>;
					if (id === "compactAtPercent") patch = { compactAtPercent: percents.find((p) => percentLabel(p) === value) ?? config.compactAtPercent };
					else if (id === "compactAtTokens") patch = { compactAtTokens: caps.find((n) => capLabel(n) === value) ?? config.compactAtTokens };
					else if (id === "compactBeforeExpiry") patch = { compactBeforeExpiry: value === "on" };
					else if (id === "keepWarmMinutes") patch = { keepWarmMinutes: warmChoices.find((m) => keepWarmLabel(m) === value) ?? config.keepWarmMinutes };
					else if (id === "minContextTokens") patch = { minContextTokens: minimums.find((n) => formatTokens(n) === value) ?? config.minContextTokens };
					else if (id === "modelData") patch = { modelData: value === "on" };
					else patch = { cacheRetention: value === "long" ? "long" : "short" };
					try {
						config = saveConfig(patch);
					} catch (error) {
						ctx.ui.notify(`pi-cache-keeper could not save the setting: ${error instanceof Error ? error.message : String(error)}`, "error");
						return;
					}
					if (id === "cacheRetention") {
						applyRetention(config.cacheRetention === "long", ctx.hasUI);
						showData(ctx);
					}
					if (id === "modelData") {
						// On: fetch and apply. Off: take this extension's values out of models.json again.
						if (config.modelData) void refreshAndReport(ctx, false, true);
						else {
							void applyData(ctx)
								.then(() => ifSessionAlive(() => showData(ctx)))
								.catch((error: unknown) => ifSessionAlive(() => ctx.ui.notify(`pi-cache-keeper could not update models.json: ${error instanceof Error ? error.message : String(error)}`, "error")));
						}
					}
					if (id === "keepWarmMinutes") {
						describeWarm();
						keepWarmSetting(true);
						showData(ctx);
					}
					if (id === "compactAtPercent" || id === "compactAtTokens") {
						fullStuck = false;
						lastFullSkip = undefined;
						describeFull();
					}
					list.invalidate();
				},
				() => done(),
			);
			const container = new Container();
			container.addChild(new Text(`${theme.fg("accent", theme.bold("pi-cache-keeper"))} ${theme.fg("dim", `saved to ${SETTINGS_KEY} in ~/.pi/agent/settings.json`)}`, 0, 0));
			container.addChild(new Text("", 0, 0));
			container.addChild(list);
			return {
				capturesViewportInput: list.capturesViewportInput,
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		});
	};

	pi.registerCommand("cache-keeper-settings", {
		description: "Change pi-cache-keeper's settings: compact when full, compact before expiry, keep the cache warm, cache retention, model data",
		handler: async (_args, ctx) => openSettings(ctx),
	});

	pi.registerCommand("cache-keeper-refresh", {
		description: `Fetch the model data (input window, cache lifetimes, prices) from ${DATA_SOURCE} now and put it into Pi's models.json`,
		handler: async (_args, ctx) => {
			if (!config.modelData) return ctx.ui.notify("Model data from providers.dev is off. Turn it on in /cache-keeper-settings.", "info");
			await refreshAndReport(ctx, true, true);
		},
	});

	pi.registerCommand("cache-keeper-warm", {
		description: "Start keeping the cache warm again for models two missed refreshes in a row left to Pi's own warming",
		handler: async (_args, ctx) => {
			const fellBack = [...misses.fallback.keys()].sort();
			const counted = [...misses.counts.entries()].filter(([model, count]) => count > 0 && !misses.fallback.has(model)).map(([model]) => model).sort();
			misses.fallback.clear();
			misses.counts.clear();
			const off = warmMinutes(true) > 0 ? "" : " Keep-warm itself is off (keepWarmMinutes: 0); /cache-keeper-settings turns it on.";
			let text: string;
			if (fellBack.length > 0) {
				const also = counted.length > 0 ? ` The missed-refresh count of ${counted.join(", ")} is cleared too.` : "";
				text = `pi-cache-keeper keeps ${fellBack.join(", ")} warm again, from your next message: whether it keeps an idle period warm is decided when the period starts.${also}${off}`;
			} else if (counted.length > 0) {
				text = `No model was left to Pi's own warming. The missed-refresh count of ${counted.join(", ")} is cleared.${off}`;
			} else text = `Nothing to clear: no model was left to Pi's own warming, and no refresh had missed the cache.${off}`;
			ctx.ui.notify(text, "info");
			renderFooter(ctx);
		},
	});

	pi.registerCommand("cache-keeper", {
		description: "Show the prompt cache state, the model data in use and this session's compaction log",
		handler: async (_args, ctx) => {
			const entries = ctx.sessionManager.getBranch();
			const model = ctx.model;
			const state = model && stateOf(model, entries);
			let cache = "lifetime unknown, so no countdown";
			if (state?.lifetime) {
				let left = state.replied ? "the last request did not use the prompt cache" : "no request since the session started or compacted";
				if (state.expiresAt !== undefined) left = state.expiresAt > Date.now() ? `${formatRemaining(state.expiresAt - Date.now())} left` : "expired";
				cache = `${left} (lifetime ${formatDuration(state.lifetime.ms)}, ${state.lifetime.source})`;
			}
			const check = checkCachedPath(entries, model);
			const next = "reason" in check
				? `Pi's compaction, because ${check.reason}`
				: `cached path; last request ${formatDuration(Date.now() - check.request.at)} ago with ${check.request.transcript.length} messages, ${check.trailing.length} since. The request prefix is checked when it runs.`;
			let log: string[];
			try {
				const records = readTraces(ctx.sessionManager.getSessionId(), 12);
				const lines = records.flatMap((record) => {
					const versus = record.event === "compact" ? comparison(record) : undefined;
					return versus ? [describeTrace(record), `         ${versus.text}`] : [describeTrace(record)];
				});
				log = records.length > 0 ? ["This session:", ...lines] : ["Nothing logged for this session yet."];
			} catch (error) {
				log = [`Could not read the log: ${error instanceof Error ? error.message : String(error)}`];
			}
			ctx.ui.notify(
				[
					`pi-cache-keeper · ${model ? `${model.provider}/${model.id}` : "no model"}`,
					`cache: ${cache}`,
					`next compaction: ${next}`,
					`when full: ${fullNote(model)}`,
					`keep warm: ${keepWarmNote(model)}`,
					`before expiry: ${expiryNote()} · retention ${model?.api === BRIDGE_API ? "set by Claude Code" : (process.env.PI_CACHE_RETENTION ?? "short")}`,
					`model data: ${dataNote(ctx)}`,
					"settings: /cache-keeper-settings",
					`log: ${TRACE_PATH_LABEL}`,
					"",
					...log,
				].join("\n"),
				"info",
			);
		},
	});
}
