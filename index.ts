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
import { cacheTier, hasExplicitPromptCache, isKimiOnMoonshot, lifetimeFor } from "./cache-state.ts";
import { cacheView, PeriodClock, startFacts, type CacheView, type StartFacts } from "./cache-clock.ts";
import { written } from "./lifetime-evidence.ts";
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
import { answerToPi, end, leave, mayLeave, onAgainst, settle, WAITING, warmer, type Warmer, type WarmPhase } from "./warm-period.ts";
import { formatFooter, lifetimesView, priceAt, sentView, tierInUse, type Countdown, type DataView, type FooterView, type KeepWarmView, type PriceView } from "./footer.ts";

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
 * R9: per model (provider/id), how many refreshes in a row did not show a hit (a miss, or a refresh that settled without
 * reporting what it cost), and the models left to Pi's own warming
 * after two in a row, with when. A hit sets the run back to zero; /cache-keeper-warm clears both. A wrong lifetime
 * costs at most two missed refreshes, then nothing until the user starts warming again. Pi loads the extension again
 * (a new instance, its modules imported afresh) on /new, /resume, /fork and /reload, so the store is kept on
 * `globalThis` under a registered symbol: every instance in the process finds it, and it ends with the process. In
 * memory only.
 */
const WARM_MISSES = Symbol.for("pi-cache-keeper.warm-misses");
const MISSES_IN_A_ROW = 2;
/**
 * A refresh sent by the extension and not yet settled, per model, from any session of the process: while one is open,
 * no other refresh of that model leaves (it could be the second miss, not yet reported). A slow refresh settles when it
 * settles: the extension never cancels it for being slow, nor sends it again. One still open REFRESH_HOLD_MAX_MS after it
 * was sent stops holding the model back, so a stream that never settles cannot keep a model from being kept warm for
 * ever in later periods.
 */
const NO_USAGE = "the refresh reported no usage, so what it cost is unknown";
const NO_USAGE_CANCELLED = "the refresh was cancelled before it reported usage, so what it cost is unknown";
/** Why a refresh does not leave while another of the same period is out (see warm-period.ts). */
const OUT_REASON = "an earlier refresh of this idle period has not settled, and only a hit it reports lets the next one go out";
const SETTLING_REASON = "an earlier refresh of this model has not settled yet, and it may have missed the cache; tried again until the last safe moment";
const REFRESH_HOLD_MAX_MS = 10 * 60_000;
/** A refresh that did not show a hit and counts: a miss, or one that settled successfully without reported usage. */
type WithoutHit = "miss" | "unreported";
interface WarmMisses {
	counts: Map<string, number>;
	/** The kinds of the current run, the last two. */
	kinds: Map<string, WithoutHit[]>;
	fallback: Map<string, number>;
	/** What the two refreshes were that left a model to Pi. */
	fallbackKinds: Map<string, WithoutHit[]>;
	/** Per model: the refreshes on their way, by an id, with when each was sent. */
	inFlight: Map<string, Map<number, number>>;
}
function warmMissStore(): WarmMisses {
	const host = globalThis as Record<symbol, unknown>;
	const found = host[WARM_MISSES] as Partial<WarmMisses> | undefined;
	if (!(found?.counts instanceof Map) || !(found.fallback instanceof Map)) host[WARM_MISSES] = { counts: new Map(), fallback: new Map(), inFlight: new Map() };
	const store = host[WARM_MISSES] as WarmMisses;
	if (!(store.inFlight instanceof Map)) store.inFlight = new Map();
	if (!(store.kinds instanceof Map)) store.kinds = new Map();
	if (!(store.fallbackKinds instanceof Map)) store.fallbackKinds = new Map();
	return store;
}
let refreshIds = 0;

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
 * the extension takes it at its start (`taken`, with a clock of its cache, cache-clock.ts) and keeps its cache warm,
 * telling Pi's own idle warming to stop, or Pi's warming decides alone, for the whole period: `notOwned` says why not.
 * Who warms a taken period is warm-period.ts's (`warmer`). The budget and what the refreshes have spent belong to the
 * period: only a new real answer starts them again, not a run that sent nothing.
 */
interface WarmPeriod {
	answeredAt?: number;
	/** When Pi went idle after the period's answer; the time limit counts from here. */
	idleSince: number;
	notOwned?: string;
	/** What the footer says of `notOwned`, in a few words; none where nothing is worth saying (no answer yet). */
	notOwnedLabel?: string;
	/** The session's model when the period started, as `provider/id`: the footer says nothing of the period for another. */
	model?: string;
	/** The extension took the period at its start: nothing kept it from it, and keep-warm read on then. */
	taken: boolean;
	/** The clock of a taken period's cache: the only thing that says when it expires. */
	clock?: PeriodClock;
	/** What the log says of a taken period: its model and the lifetime it started with. */
	logged?: TimerContext;
	/**
	 * The period was the extension's until the evidence turned against its lifetime or its request was let go (see
	 * `changeHands`): it is Pi's from then on.
	 */
	handedOver?: "evidence" | "let go";
	/** The request of the period's answer; forgotten with the cached request (model switch, compaction, branch move). */
	request?: CapturedRequest;
	budget?: WarmBudget;
	spending: WarmSpending;
	/** Where the period's refreshes stand: waiting, one out, or ended (see warm-period.ts). Only its functions move it. */
	warm: WarmPhase;
	/** Why keeping warm ended for the rest of the period: a read of `warm`. */
	readonly ended?: { stop: WarmStop; reason: string };
	/** Keep-warm read on when the period started; a period started while it read off is never owned. */
	onAtStart: boolean;
	/** The expiry the refresh was decided for (sent, or too late), so it is not tried again for it. */
	doneFor?: number;
	/** The expiry for which "Pi is busy" was logged, so a refresh tried on every tick logs it once. */
	busyFor?: number;
	/** What a taken period's cached request was written with, fixed at the period's start: the model and the cache tier. */
	fixed?: {
		model: string;
		tier: "short" | "long";
		requested: "short" | "long";
	};
}

interface CachedPath {
	request: CapturedRequest;
	prefix?: CachedPrefix;
	trailing: AgentMessage[];
	cache: CacheView;
}

/** The extension's one status in Pi's footer: the countdown, what went wrong, and the values in use (see footer.ts). */
const STATUS_KEY = "cache-keeper";
/** Why a period is Pi's once the extension let go of its request (a model switch, a branch move, a compaction). */
const REQUEST_LET_GO = "the extension no longer holds the period's request (the model, the branch or the conversation changed), so it can't refresh it";
/**
 * The request forms whose cache markers `requestCache` reads: Anthropic Messages (`cache_control`) and OpenAI's Chat
 * Completions and Responses (Codex's and Azure's too). Pi's other adapters write theirs in forms it does not read
 * (Bedrock's `cachePoint`, Gemini's `cachedContent`), so for those the footer says nothing of what was sent.
 */
const MARKERS_READ: ReadonlySet<string> = new Set(["anthropic-messages", "openai-completions", "openai-responses", "openai-codex-responses", "azure-openai-responses"]);
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
	let warming: AbortController | undefined;
	let piWarmAt: number | undefined;
	// The one read of the cache everything reads (cache-clock.ts): the countdown and the footer, the refresh and its last
	// gate, compacting before expiry and its last check, the cached path's check, /cache-keeper and what Pi's warming is
	// told. For a period the extension took at its start, on its model and while the branch in front of the user still
	// holds its answer, the period's clock; otherwise exactly as with keep-warm off. The clock is told what is read now
	// (the route serving the model, the route's lifetime for the request's tier); what it says against the period goes to
	// who warms it (`changeHands`), recorded as a skip unless the caller takes it (`taken`). Its expiry is `sendBy`: where
	// it is unknown, nothing is sent.
	const look = (ctx: ExtensionContext, at: { model?: Model<Api>; entries?: SessionEntry[] } = {}, taken?: (handed: { stop: WarmStop; reason: string }) => void): CacheView => {
		const model = at.model ?? ctx.model;
		if (!model) return { regime: "plain", cached: false, replied: false };
		const entries = at.entries ?? ctx.sessionManager.getBranch();
		const key = `${model.provider}/${model.id}`;
		const served = servedModel(model);
		const p = period;
		// The session's model is not the one the period's cached request was written with.
		if (p?.fixed && key !== p.fixed.model && model === ctx.model) handTo(ctx, p, { reason: `the model is now ${key}, the cached request was written with ${p.fixed.model}`, label: "the model changed" }, taken);
		const clock = p?.taken && p.fixed?.model === key ? p.clock : undefined;
		const view = cacheView(
			served,
			entries,
			clock && p?.fixed ? { clock, on: warmMinutes() > 0, routeKey: routeKeyOf(model), dataMs: lifetimeFor(served, p.fixed.tier)?.ms, requested: p.fixed.requested } : undefined,
		);
		if (p && view.regime === "period" && view.against) handTo(ctx, p, view.against, taken, view);
		return view;
	};
	// The last moment a refresh for a cache counted from `from` may leave: half the warm lead before its expiry.
	const lastSafeMoment = (from: number, lifetimeMs: number) => from + lifetimeMs - Math.floor(warmLeadMs(lifetimeMs, EXPIRY_LEAD_MS) / 2);
	// R9: each model's run of refreshes without a hit, and the models two in a row left to Pi (see WARM_MISSES).
	const misses = warmMissStore();
	// What the two refreshes without a hit were: misses, unreported ones, or one of each.
	const withoutHit = (kinds: readonly WithoutHit[] | undefined): string =>
		kinds?.every((k) => k === "miss") ? "both missed the cache" : kinds?.every((k) => k === "unreported") ? "neither reported what it cost" : "one missed the cache, one did not report what it cost";
	const fallbackLine = (model: string, at: number) =>
		`two refreshes in a row without a hit for ${model} (the last at ${new Date(at).toTimeString().slice(0, 5)}): ${withoutHit(misses.fallbackKinds.get(model))}, so it is left to Pi's own warming; /cache-keeper-warm starts keeping it warm again`;
	const fallbackFor = (model: Model<Api> | undefined): { key: string; at: number } | undefined => {
		const key = model && `${model.provider}/${model.id}`;
		const at = key === undefined ? undefined : misses.fallback.get(key);
		return key !== undefined && at !== undefined ? { key, at } : undefined;
	};
	// A refresh's evidence, counted per model: a miss, or a successful refresh that reported no prompt (what it cost is
	// unknown), adds one; a hit sets the run back to zero. The second in a row leaves the model to Pi (true once, when that
	// happens). Touches no session context.
	const recordRefresh = (model: string, verdict: "hit" | WithoutHit, at: number): boolean => {
		if (verdict === "hit") {
			misses.counts.delete(model);
			misses.kinds.delete(model);
			return false;
		}
		const count = (misses.counts.get(model) ?? 0) + 1;
		misses.counts.set(model, count);
		const kinds = [...(misses.kinds.get(model) ?? []), verdict].slice(-MISSES_IN_A_ROW);
		misses.kinds.set(model, kinds);
		if (count < MISSES_IN_A_ROW || misses.fallback.has(model)) return false;
		misses.fallback.set(model, at);
		misses.fallbackKinds.set(model, kinds);
		return true;
	};
	// Whether a refresh of this model, sent from any session of this process, is still on its way (see REFRESH_HOLD_MAX_MS).
	const unsettled = (model: string): boolean => {
		const open = misses.inFlight.get(model);
		if (!open) return false;
		const now = Date.now();
		for (const [id, sentAt] of open) if (now - sentAt >= REFRESH_HOLD_MAX_MS) open.delete(id);
		if (open.size === 0) misses.inFlight.delete(model);
		return open.size > 0;
	};
	// Why the extension cannot take a period, from facts that last for the period, with what the footer says of it in a
	// few words; else the clock of the period's cache.
	const whyNotOwned = (state: StartFacts | undefined, model: Model<Api> | undefined): { reason: string; label?: string } | { clock: PeriodClock } => {
		const no = (label: string | undefined, reason: string) => ({ reason, ...(label ? { label } : {}) });
		const fellBack = fallbackFor(model);
		// While it lasts the footer says it on its own; after /cache-keeper-warm the period stays Pi's until the next answer.
		if (fellBack) return no("until your next message", fallbackLine(fellBack.key, fellBack.at));
		if (state?.answeredAt === undefined) return no(undefined, "no answer has read or written the prompt cache yet");
		if (!state.lifetime) return no("no cache lifetime", "the cache lifetime is unknown");
		if (state.lifetime.ms < MIN_OWNED_LIFETIME_MS) return no("lifetime under a minute", `the cache lifetime (${formatDuration(state.lifetime.ms)}) is under a minute`);
		// The same state the countdown reads: without a cached answer there is no expiry to keep warm.
		if (!state.cached) return no("last answer used no cache", "the last answer did not use the prompt cache");
		// R7 at the period's start: the period's own expiry (the answer's time, stamped when it started streaming, plus the
		// lifetime) leaves no time for a refresh when Pi goes idle: its last safe moment, the one the refresh timer uses,
		// has passed. A safe re-send can't be proven, so Pi's warming, which may have refreshed during the run, goes on.
		if (state.answeredAt !== undefined && Date.now() > lastSafeMoment(state.answeredAt, state.lifetime.ms)) {
			return no("no time to refresh", "the cache counted from the last answer, which started streaming more than one cache lifetime before its end, reached its last safe refresh moment before Pi went idle");
		}
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
		// The period's lifetime, whether everything seen so far agrees with it, and whether it is the one the start facts
		// count with (cache-clock.ts, lifetime-evidence.ts): the clock of the period's cache, else why not.
		const started = PeriodClock.start({ facts: state, api: request.model.api, cache, dataMs: lifetimeFor(servedModel(request.model), cache.tier)?.ms, routeKey: routeKeyOf(request.model) });
		if ("declined" in started) return started.declined;
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
		return started;
	};
	// Pi is idle. After a run that brought a new real answer (or at a session's start) a new period starts; after one that
	// sent nothing, the period goes on, with its spending and its time limit.
	const goIdle = (ctx: ExtensionContext, fresh = false) => {
		running = false;
		const requested = answerRequest?.cache?.tier ?? answerRequest?.tier ?? "short";
		const model = ctx.model;
		const state = model ? startFacts(servedModel(model), ctx.sessionManager.getBranch(), requested) : undefined;
		const answeredAt = state?.answeredAt;
		if (!fresh && period && (answeredAt === undefined || answeredAt === period.answeredAt)) return;
		const took = whyNotOwned(state, answerRequest?.model ?? ctx.model);
		const why = "reason" in took ? took : undefined;
		const clock = "clock" in took ? took.clock : undefined;
		const request = clock ? answerRequest : undefined;
		const onAtStart = warmMinutes(true) > 0;
		const budget = request && state?.answerPrompt !== undefined ? warmBudget(request.model, state.answerPrompt) : undefined;
		const fixed = request && model && clock ? { model: `${model.provider}/${model.id}`, tier: requested, requested } : undefined;
		period = {
			warm: WAITING,
			get ended() {
				return this.warm.phase === "ended" ? { stop: this.warm.stop, reason: this.warm.reason } : undefined;
			},
			answeredAt,
			idleSince: Date.now(),
			notOwned: why?.reason,
			...(why?.label ? { notOwnedLabel: why.label } : {}),
			...(model ? { model: `${model.provider}/${model.id}` } : {}),
			onAtStart,
			taken: onAtStart && clock !== undefined && budget !== undefined && fixed !== undefined,
			...(clock ? { clock } : {}),
			...(fixed && state?.lifetime ? { logged: { model: fixed.model, lifetimeSeconds: state.lifetime.ms / 1000, lifetimeSource: state.lifetime.source } } : {}),
			request,
			budget,
			spending: { spent: 0, refreshes: 0 },
			fixed,
		};
	};
	// Who warms the period (warm-period.ts): the extension, nobody (warming ended, Pi's stays stopped), or Pi.
	const warmerOf = (p: WarmPeriod | undefined): Warmer =>
		p === undefined
			? "Pi"
			: warmer({
					taken: p.taken,
					on: warmMinutes() > 0,
					// Two misses in a row on the period's model, also one reported after the period started.
					fellBack: p.fixed !== undefined && misses.fallback.has(p.fixed.model),
					handedOver: p.handedOver !== undefined,
					warm: p.warm,
				});
	// The extension keeps this period's cache warm, or kept it until its warming ended (Pi's warming stays stopped).
	const owns = (p: WarmPeriod | undefined): p is WarmPeriod & { budget: WarmBudget; fixed: NonNullable<WarmPeriod["fixed"]>; clock: PeriodClock } => {
		const who = warmerOf(p);
		return who === "the extension" || who === "nobody";
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
	// The lifetime the footer's values were read with: in a taken period they are read again when the clock's changes.
	let shownLifetimeMs: number | undefined;
	let footerText: string | undefined;
	let onResize: (() => void) | undefined;
	// Pi's footer is as wide as the terminal; elsewhere (RPC, tests) nothing is fitted.
	const footerWidth = () => (process.stdout.isTTY && process.stdout.columns > 0 ? process.stdout.columns : Number.POSITIVE_INFINITY);
	// What keep-warm says in the footer, while it is on: two misses in a row left the model to Pi (for as long as that
	// lasts, countdown or not), warming ended for this idle period and why (until your next message), the period is
	// Pi's and why, or keep-warm was switched on during the period.
	const keepWarmView = (model: Model<Api>): KeepWarmView | undefined => {
		const minutes = warmMinutes();
		if (minutes <= 0) return undefined;
		if (fallbackFor(model)) return { fallback: true };
		const p = period;
		// A period that started on another model (switched since) says nothing about this one; the setting still holds.
		if (!p || p.model !== `${model.provider}/${model.id}`) return { goal: { minutes } };
		if (owns(p)) {
			if (running) return { goal: { minutes } };
			if (p.ended) return { ended: { stop: p.ended.stop, limit: keepWarmLabel(minutes), amounts: spendingText(p.budget, p.spending) } };
			// The extension keeps this period warm: until when (the time limit counts from Pi going idle), and its budget.
			const budget = p.budget.priced
				? { spent: formatUsd(p.spending.spent), of: formatUsd(p.budget.missCost) }
				: { spent: String(p.spending.refreshes), of: String(MAX_UNPRICED_REFRESHES), refreshes: true as const };
			return { goal: { minutes, until: p.idleSince + minutes * 60_000, budget } };
		}
		if (!p.onAtStart) return { pending: true };
		return p.notOwnedLabel ? { leftToPi: p.notOwnedLabel } : { goal: { minutes } };
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
		// Nothing to keep warm until the next real answer: a period the extension kept warm is Pi's from now (R7), also
		// when its model comes back (a switch away and back without a message), where the request is not known again.
		// The period's clock stays: its cache is the same cache.
		const p = period;
		if (p) handTo(ctx, p, { reason: REQUEST_LET_GO, label: "request let go" }, undefined, undefined, "let go");
		if (p) p.request = undefined;
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
	// The route serving a model, as one key: what answered where a proxy said so, else the route's configured upstreams,
	// else the model itself (a provider no proxy describes, which never changes). A subscription login and an API key of
	// the same provider are different routes, with caches of their own.
	const routeKeyOf = (model: { provider: string; id: string }, upstreams = answeredFor(model as Model<Api>) ?? data.upstreams[model.provider]?.[model.id]?.upstreams): string =>
		upstreams ? lookupKeys(model as Model<Api>, { upstreams }) : `${model.provider}/${model.id}`;

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
		// The model's own tier in use, once it has made a request in this session (its answer on the branch, or a request
		// the extension saw): as a period the extension took for this model fixed it (whoever warms it now), else the tier
		// its own answers reported, else the one Pi asks for. Claude Code picks the tier for the bridge model.
		const p = period;
		const key = `${model.provider}/${model.id}`;
		// The one read: in a taken period, its clock's lifetime, for the countdown, "(in use)" and "sent" alike.
		const view = look(ctx, { model, entries });
		shownLifetimeMs = view.lifetime?.ms;
		const inPeriod = view.regime === "period" && p?.fixed !== undefined;
		const fixed = inPeriod ? p?.fixed : undefined;
		const request = captured && captured.model.provider === model.provider && captured.model.id === model.id ? captured : undefined;
		const asked = request !== undefined || entries.some((e) => e.type === "message" && e.message.role === "assistant" && e.message.provider === model.provider && e.message.model === model.id);
		// The model's own tier as the answer's write bucket names it (the countdown's, where it is this model's).
		const ownTier = !asked || bridge ? undefined : fixed ? fixed.tier : cacheTier(entries, model);
		// The tier the countdown runs on: with keep-warm off, the latest tier any model's answer reported, which after a
		// model switch can be another model's.
		const countdownTier = fixed ? fixed.tier : cacheTier(entries);
		const counted = view.lifetime;
		const cache = request?.payload && MARKERS_READ.has(model.api) ? (request.cache ?? requestCache(request.payload)) : undefined;
		const retention = process.env.PI_CACHE_RETENTION === "long" ? "long" : "short";
		// The tier marked "(in use)": the one the request asked for where this route's lifetime for it is the countdown's
		// (a route can write its short tier as a one-hour cache), else see tierInUse. Display only.
		const countdownMs = counted?.ms;
		// A period the extension took for this model knows the tier its request asked for, also once the request itself is
		// forgotten (a model switch and back).
		const askedTier = cache?.tier ?? fixed?.requested;
		const tier = ownTier === undefined ? undefined : tierInUse({ asked: askedTier, countdownMs, route: served.promptCache, retention, fallback: ownTier });
		const declared = tier === undefined ? undefined : served.promptCache?.[tier];
		// Where the model declares none for the tier, the countdown's own (the provider's report, a family's documented
		// one), when the countdown runs on that tier.
		const inUse = fixed ? counted && counted.ms / 1000 : (declared ?? (tier === countdownTier && counted && counted.source !== "declared by the model" ? counted.ms / 1000 : undefined));
		const lifetimes = lifetimesView(served.promptCache, { tier, seconds: inUse }, found);
		const sent = cache && tier ? sentView(cache, { tier, ms: inUse === undefined ? undefined : inUse * 1000 }, served.promptCache, retention) : undefined;
		const rates = hasPrices(model) ? priceAt(model.cost, ctx.getContextUsage()?.tokens ?? undefined) : undefined;
		const priceState = found && found.refs.length > 0 ? fieldStates(found).price : undefined;
		const price: PriceView = {
			...(via ? { via } : {}),
			// Billed by a subscription: a subscription login (its prices, where it has some, are what the extension counts
			// with), and Claude Code through the bridge, which Pi prices at $0.
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
		// The countdown on another tier than the model's own, or counted from another model's answer (also where this model
		// has made no request yet, as after a switch and /reload, /resume or /fork): said beside it, so the two are not
		// read as one.
		const otherTier = !fixed && ((ownTier !== undefined && countdownTier !== ownTier) || latestAnswerIsOthers(entries, key)) ? countdownTier : undefined;
		return { lifetimes, ...(sent ? { sent } : {}), ...(otherTier ? { countdownTier: otherTier } : {}), price, data: dataView };
	};
	// Whether the answer the countdown counts from is another model's. Read as `cacheState` reads it where the extension
	// does not keep the period warm (the only case this is asked for): the latest answer that did not fail or get
	// aborted, where it read or wrote the cache; a failed or aborted one is skipped, whatever it read.
	const latestAnswerIsOthers = (entries: SessionEntry[], key: string): boolean => {
		let latest: string | undefined;
		for (const entry of entries) {
			if (entry.type === "compaction") latest = undefined;
			else if (entry.type === "message" && entry.message.role === "assistant") {
				const { stopReason, usage, provider, model } = entry.message;
				if (stopReason === "error" || stopReason === "aborted") continue;
				latest = usage.cacheRead + usage.cacheWrite > 0 ? `${provider}/${model}` : undefined;
			}
		}
		return latest !== undefined && latest !== key;
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
				// After an await: the session may be gone.
				ifSessionAlive(() => startTimer(ctx));
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
		const check = checkCachedPath(ctx, ctx.sessionManager.getBranch(), ctx.model);
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
		p.warm = end(p.warm, stop, reason);
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

	// Evidence against a taken period's lifetime, or its request let go (warm-period.ts's `onAgainst`): the extension's
	// period ends its warming ("unable") and is Pi's from then on; one whose warming ended on its time limit or as
	// "unable" is Pi's; one ended for good (budget, a miss, an unreported or failed refresh) stays as it is. Returns the
	// fields of the record that says warming ended, once.
	const changeHands = (p: WarmPeriod, against: { reason: string; label: string }, why: "evidence" | "let go"): { stop: WarmStop; reason: string } | Record<string, never> => {
		const what = onAgainst(warmerOf(p), p.warm);
		if (what === "stays") return {};
		const ended = what === "end and hand over" ? endWarm(p, "unable", against.reason) : {};
		p.notOwned = against.reason;
		p.notOwnedLabel = against.label;
		p.handedOver = why;
		return ended;
	};
	// The same, with the record of the end (a skip, at the expiry read), unless the caller takes it (`taken`).
	const handTo = (
		ctx: ExtensionContext,
		p: WarmPeriod,
		against: { reason: string; label: string },
		taken?: (handed: { stop: WarmStop; reason: string }) => void,
		view?: CacheView,
		why: "evidence" | "let go" = "evidence",
	) => {
		const ended = changeHands(p, against, why);
		if (!("stop" in ended)) return;
		const handed = ended as { stop: WarmStop; reason: string };
		if (taken) return taken(handed);
		trace(ctx, { ...warmBase(ctx, p, view?.sendBy ?? Date.now(), p.logged ?? {}), action: "skip", ...handed, budget: budgetRecord(p as WarmPeriod & { budget: WarmBudget }) });
	};

	// The time limit takes effect: the expiry the cache's clock gives already lasts to `idleSince + keepWarmMinutes` or
	// beyond (the answer's own lifetime covers the window), so no refresh goes out in this period. Recorded when it
	// happens, from the expiry just read; without one, no limit is declared. A refresh of the extension's that carries the
	// cache there says so itself.
	const noteLimit = (ctx: ExtensionContext, expiresAt: number, timer: TimerContext) => {
		const p = period;
		if (!owns(p) || p.ended || running || wantsWarm(expiresAt, p.idleSince, warmMinutes())) return;
		trace(ctx, { ...warmBase(ctx, p, expiresAt, timer), action: "skip", ...endWarm(p, "limit", limitReason()), budget: budgetRecord(p) });
	};

	// The last gate: the only way a refresh payload leaves. Called as the last thing in the payload hook, after which only
	// the reservation and the return follow. It checks, in this order, on a fresh read: the refresh was not cancelled;
	// keep-warm is still on in the current settings; the period is the one the refresh was started for and has not
	// ended; the model is the period's, and the cache's clock, read here, says nothing against the period and gives an
	// expiry; Pi is idle and nothing is queued; the last safe moment, from that expiry, has not passed; the payload's output limit is within the API's proven refresh limit. "hold": a
	// passing reason, tried again per R2 (a cancelled refresh, by the run that cancelled it); "refuse": withheld for good,
	// and warming ends for the period where it has not ended yet.
	type GateVerdict = { pass: true } | { hold: "cancelled" | "busy" | "late" | "settling" | "out"; reason: string } | { refuse: string; ended?: { stop: WarmStop; reason: string } };
	const lastGate = (
		ctx: ExtensionContext,
		p: WarmPeriod & { fixed: NonNullable<WarmPeriod["fixed"]> },
		signal: AbortSignal,
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
		// One of this period's refreshes is out: nothing else leaves for the period until it settles.
		if (!mayLeave(p.warm)) return { hold: "out", reason: OUT_REASON };
		// Two misses in a row on this model since the period started (another period's refresh): it is Pi's now.
		const fellBackAt = misses.fallback.get(p.fixed.model);
		if (fellBackAt !== undefined) return { refuse: fallbackLine(p.fixed.model, fellBackAt) };
		// An earlier refresh of this model has not settled: it may be the second miss. Held, and tried again.
		// An earlier refresh of this model from another period or session has not settled: it may be the second miss.
		if (unsettled(p.fixed.model)) return { hold: "settling", reason: SETTLING_REASON };
		// The model the period's cached request was written with, and the cache's clock read at the door: evidence against
		// the period refuses it, and the period is Pi's from now (warming ends, said where the refresh settles).
		let ended: { stop: WarmStop; reason: string } | undefined;
		const model = ctx.model;
		const now = model && `${model.provider}/${model.id}`;
		if (now !== p.fixed.model) {
			const drift = { reason: now ? `the model is now ${now}, the cached request was written with ${p.fixed.model}` : `there is no model now, the cached request was written with ${p.fixed.model}`, label: "the model changed" };
			handTo(ctx, p, drift, (handed) => (ended = handed));
			return { refuse: drift.reason, ...(ended ? { ended } : {}) };
		}
		const view = look(ctx, {}, (handed) => (ended = handed));
		if (view.against) return { refuse: view.against.reason, ...(ended ? { ended } : {}) };
		if (view.sendBy === undefined || !view.lifetime) return { refuse: "the cache's expiry is unknown" };
		if (running || !ctx.isIdle() || ctx.hasPendingMessages()) return { hold: "busy", reason: "Pi is busy or has queued messages" };
		// The last safe moment, from the expiry read here: half the warm lead before it.
		const lastSafe = view.sendBy - Math.floor(warmLeadMs(view.lifetime.ms, EXPIRY_LEAD_MS) / 2);
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
		if (!p || !p.taken || p.handedOver || !p.budget || p.ended || running) return;
		const budget = p.budget;
		const reason = keepWarmSetting() ? "keep-warm was turned off" : "the settings could not be read";
		trace(ctx, { ...warmBase(ctx, p, expiresAt, timer), action: "skip", ...endWarm(p, "unable", reason), budget: budgetRecord({ ...p, budget }) });
	};

	// Shortly before the cache expires, while Pi is idle in a period the extension owns, inside the keep-warm window and
	// the budget, re-sends the period's request exactly as it was sent with a one-token answer, so the cache entry is
	// read and its lifetime starts again. Called on every tick from `warmLead` before expiry: a refresh held back for a
	// passing reason (Pi busy, a message queued, Pi's own refresh from the run just ended still in flight) is tried again
	// until the last safe moment, half the lead before expiry; a lasting reason ends warming for the period.
	const keepWarm = (ctx: ExtensionContext, timer: TimerContext) => {
		const p = period;
		// Only while waiting: with one of the period's refreshes out, or warming ended, nothing leaves.
		if (!owns(p) || !mayLeave(p.warm) || running) return;
		// The cache's clock, read here: evidence against the period ends its warming; without an expiry nothing is sent.
		const view = look(ctx);
		if (p.ended || view.sendBy === undefined || !view.lifetime) return;
		const expiresAt: number = view.sendBy;
		if (p.doneFor === expiresAt || !wantsWarm(expiresAt, p.idleSince, warmMinutes())) return;
		const base = warmBase(ctx, p, expiresAt, timer);
		const lastSafe = expiresAt - Math.floor(warmLeadMs(view.lifetime.ms, EXPIRY_LEAD_MS) / 2); // as lastSafeMoment
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
		// An earlier refresh of this model, from any session of this process, is still on its way: held (the last gate
		// checks it again just before sending).
		if (unsettled(p.fixed.model)) {
			if (p.busyFor !== expiresAt) trace(ctx, { ...base, action: "skip", reason: SETTLING_REASON });
			p.busyFor = expiresAt;
			return;
		}
		const check = checkRequestPath(ctx, ctx.sessionManager.getBranch(), ctx.model, p.request);
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
		let settling = false;
		// Held because another refresh of this period was out (two prepared at once): it never left.
		let waitingOut = false;
		let refused: string | undefined;
		// Warming ended at the last gate, on evidence against the period: said where the refresh settles.
		let refusedEnded: { stop: WarmStop; reason: string } | undefined;

		const controller = new AbortController();
		warming = controller;
		// Its entry among the model's refreshes on their way, once it goes out (see REFRESH_HOLD_MAX_MS).
		const refreshId = ++refreshIds;
		const open = misses.inFlight.get(p.fixed.model) ?? new Map<number, number>();
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
								verdict = lastGate(ctx, p, controller.signal, request.model.api, payload, "reason" in built ? built.reason : undefined);
							} catch {
								// The session's context is gone (/new, /reload, Pi exiting): nothing leaves.
								verdict = { refuse: "the session ended before the refresh went out" };
							}
							if ("hold" in verdict) {
								if (verdict.hold === "busy") held = true;
								if (verdict.hold === "settling") settling = true;
								if (verdict.hold === "out") waitingOut = true;
								if (verdict.hold === "late") late = true;
								throw new Error(verdict.reason);
							}
							if ("refuse" in verdict) {
								refused = verdict.refuse;
								refusedEnded = verdict.ended;
								throw new Error(verdict.refuse);
							}
							// It goes out: reserved at the larger of its expected cost and what the last refresh really cost.
							out = true;
							// The moment it leaves is the one its hit, if it reports one, counts the period's expiry from.
							p.warm = leave(p.warm, refreshId, Date.now());
							open.set(refreshId, Date.now());
							misses.inFlight.set(p.fixed.model, open);
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
			// Settled: no longer holds this model's other refreshes back.
			open.delete(refreshId);
			if (open.size === 0 && misses.inFlight.get(p.fixed.model) === open) misses.inFlight.delete(p.fixed.model);
			if (warming === controller) warming = undefined;
			// What the refresh reported it cost replaces the reserve, where its usage shows a prompt; without that (an error or
			// abort before any usage, usage omitted or output only, a model without prices) what it cost is unknown and the
			// reserve stays.
			const reportedPrompt = response?.usage ? response.usage.input + response.usage.cacheRead + response.usage.cacheWrite : 0;
			const reported = out && budget.priced && reportedPrompt > 0 ? (response?.usage?.cost?.total ?? 0) : 0;
			if (reported > 0) {
				spending.spent += reported - reserved;
				spending.last = reported;
			}
			const used = response?.usage;
			const usage = out && used && used.input + used.cacheRead + used.cacheWrite + used.output > 0 ? traceUsage(used) : undefined;
			const seconds = (Date.now() - started) / 1000;
			const aborted = controller.signal.aborted || response?.stopReason === "aborted";
			const failed = !aborted && !held && !settling && !waitingOut && !refused && !late && (!response || response.stopReason === "error");
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
			// A refresh that settled successfully without a prompt in its usage counts too; one cancelled or failed before it
			// reported any does not.
			const unreported = out && verdict === undefined && !aborted && !failed;
			const fellBack = verdict ? recordRefresh(p.fixed.model, verdict, started) : unreported ? recordRefresh(p.fixed.model, "unreported", started) : false;
			let ended: ReturnType<typeof endWarm> | undefined;
			// The refresh's own report goes to the period's clock first, whatever else follows and whether or not the session
			// is still there: what it wrote, and, below, the hit it reported, counted from when it left.
			if (out && used) p.clock.wrote(written(used));
			// Inside a period the next refresh goes out only after the one before it reported a hit (see warm-period.ts): a hit,
			// however the refresh ended afterwards, moves the period back to waiting, and the cache counts from its send time;
			// one that settled any other way (a miss, a failure or a cancellation before it reported, no prompt in its usage)
			// ends it.
			if (out) {
				ended = reached();
				const why: [WarmStop, string] | undefined =
					verdict === "hit"
						? undefined
						: verdict === "miss"
							? ["missed", failed ? `${missReason} before it failed: ${failure}` : missReason]
							: failed
								? ["failed", failure]
								: ["unknown", aborted ? NO_USAGE_CANCELLED : NO_USAGE];
				const before = p.warm;
				const settled = settle(p.warm, refreshId, why ? { hit: false, stop: why[0], reason: why[1] } : { hit: true });
				p.warm = settled.state;
				if (settled.hitSentAt !== undefined) p.clock.hit(settled.hitSentAt);
				if (!ended && why && p.warm !== before) ended = { stop: why[0], reason: why[1] };
			} else if (refused) ended = refusedEnded ?? endWarm(p, "unable", refused);
			else if (failed) ended = endWarm(p, "failed", failure);
			// Then the cache's clock is read, where the session is alive: a refresh that read 95% and wrote the rest into a cache
			// of another lifetime is a hit for the budget and still evidence against the period's lifetime. Against it, the
			// period changes hands as warm-period.ts says (said in this refresh's record).
			let after: CacheView | undefined;
			ifSessionAlive(() => {
				after = look(ctx, {}, (handed) => (ended = { ...ended, ...handed }));
			});
			// Tried again for the same expiry only when it never left; a refresh that left is never sent again.
			if (!out && (aborted || held || settling || waitingOut) && p.doneFor === expiresAt) p.doneFor = undefined;
			const fallback = fellBack ? { leftToPi: fallbackLine(p.fixed.model, started) } : {};
			// What is said and shown, only while the session is alive.
			ifSessionAlive(() => {
				if (fellBack && ctx.hasUI) {
					ctx.ui.notify(
						`Two refreshes in a row without a hit for ${p.fixed.model} (${withoutHit(misses.fallbackKinds.get(p.fixed.model))}), so pi-cache-keeper stopped keeping it warm; Pi's own warming takes over. /cache-keeper-warm starts it again.`,
						"warning",
					);
				}
			});
			// A real request started (or the session moved on); it refreshes the cache itself. What went out stays counted.
			// If that run sent nothing, the refresh for this expiry is tried again, as for any passing hold-up.
			if (aborted) {
				if (!out) return;
				ifSessionAlive(() => {
					trace(ctx, { ...base, action: "cancelled", seconds, ...ended, reason: "a new request or a change of session cancelled it", usage, budget: budgetRecord(p), ...fallback });
					// A hit reported before the cancellation: the period waits for the next expiry, counted from it.
					if (verdict === "hit" && period === p && !running && ctx.isIdle()) startTimer(ctx);
				});
				return;
			}
			ifSessionAlive(() => {
				if (waitingOut) {
					// It settles first; a hit lets the next one go out.
				} else if (settling) {
					// Tried again on the next ticks, until the last safe moment.
					if (p.busyFor !== expiresAt) trace(ctx, { ...base, action: "skip", seconds, reason: SETTLING_REASON });
					p.busyFor = expiresAt;
				} else if (held) {
					// Tried again on the next ticks, as any passing hold-up.
					if (p.busyFor !== expiresAt) trace(ctx, { ...base, action: "skip", seconds, reason: "Pi got busy or a message was queued while the refresh was being prepared, so it was withheld; tried again until the last safe moment" });
					p.busyFor = expiresAt;
				} else if (refused) {
					// Withheld for good; warming ends with the reason where it has not ended yet.
					trace(ctx, { ...base, action: "skip", seconds, ...ended, reason: refused, budget: budgetRecord(p) });
				} else if (late) {
					trace(ctx, { ...base, action: "skip", seconds, reason: "too late: the cache was about to expire before the refresh went out, so it was not sent" });
				} else if (failed) {
					// A hit reported before the failure kept the cache warm: nothing to warn of.
					if (ctx.hasUI && verdict !== "hit") ctx.ui.notify(`pi-cache-keeper could not keep the cache warm: ${failure}`, "warning");
					trace(ctx, { ...base, action: "failed", seconds, ...ended, reason: failure, usage, budget: budgetRecord(p), ...fallback });
				} else {
					// The time limit, from the expiry just read.
					const until = after?.sendBy;
					const limit = !ended && until !== undefined && !wantsWarm(until, p.idleSince, warmMinutes()) ? endWarm(p, "limit", limitReason()) : undefined;
					trace(ctx, { ...base, action: verdict === "miss" ? "missed" : "warm", seconds, ...(ended ?? limit), usage, budget: budgetRecord(p), ...fallback });
					if (verdict === "miss" && !fellBack && ctx.hasUI) {
						ctx.ui.notify(`Keeping the cache warm read only ${Math.floor(100 * (share ?? 0))}% from the cache, so it wrote the context again. Stopped until your next message.`, "warning");
					}
				}
				if (ctx.isIdle()) startTimer(ctx);
			});
		})();
	};

	// The countdown. It takes the cache's reading as it is: where the expiry is unknown (a taken period whose route
	// changed, or whose lifetime can't be read any more), the cache counts as cold and nothing is refreshed or compacted.
	// A taken period's reading picks the branch (`regime`): the period's, whoever warms it; otherwise exactly as with
	// keep-warm off.
	const startTimer = (ctx: ExtensionContext, compactAtExpiry = true) => {
		stopTimer(ctx, false);
		const first = look(ctx);
		if (first.regime === "period" && first.lifetime?.ms !== shownLifetimeMs) {
			modelView = ctx.hasUI && ctx.model ? modelViewOf(ctx, ctx.model) : modelView;
		}
		if (first.sendBy === undefined) {
			if (first.unknown) countdown = { state: "cold" };
			return renderFooter(ctx);
		}
		let view = first;
		let expiresAt: number = first.sendBy;
		let warmLead = first.lifetime ? warmLeadMs(first.lifetime.ms, EXPIRY_LEAD_MS) : 0;
		const timer: TimerContext = {
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			lifetimeSeconds: first.lifetime && first.lifetime.ms / 1000,
			lifetimeSource: first.lifetime?.source,
		};
		let ticks = 0;
		let attempted = !compactAtExpiry;
		let warmChecked = false;
		const tick = () => {
			if (++ticks % 15 === 0 || expiresAt - Date.now() <= Math.max(EXPIRY_LEAD_MS, warmLead)) {
				view = look(ctx);
				if (view.unknown) {
					// Unknown for the rest of the period: cold, and the countdown stops.
					countdown = { state: "cold" };
					if (view.lifetime?.ms !== shownLifetimeMs) showData(ctx);
					renderFooter(ctx);
					clearInterval(ticker);
					ticker = undefined;
					return;
				}
				expiresAt = view.sendBy ?? expiresAt;
				// A taken period's lead follows the lifetime read now, and so does the lifetime the footer marks in use.
				if (view.regime === "period" && view.lifetime) warmLead = warmLeadMs(view.lifetime.ms, EXPIRY_LEAD_MS);
				if (view.regime === "period" && view.lifetime?.ms !== shownLifetimeMs) showData(ctx);
			}
			const remaining = expiresAt - Date.now();
			const keepWarmOn = warmMinutes() > 0;
			if (keepWarmOn && remaining > 0 && !warming) noteLimit(ctx, expiresAt, timer);
			// One of the period's refreshes is out (also after a run that sent nothing cancelled it): wait for it to settle.
			const out = period?.warm.phase === "out";
			if (!keepWarmOn) noteSwitchOff(ctx, expiresAt, timer);
			countdown = warming ? { state: "refreshing" } : remaining > 0 ? { state: "warm", ms: remaining } : { state: "cold" };
			renderFooter(ctx);
			if (remaining <= 0) {
				// Expired (or the timer ran this late): nothing is refreshed or compacted from a cache that is gone.
				clearInterval(ticker);
				ticker = undefined;
			} else if (warming) {
				// Wait for the refresh; it restarts the countdown when it lands.
			} else if (!keepWarmOn || view.regime !== "period") {
				// Keep-warm off, or a period the extension did not take: as with keep-warm off.
				if (remaining <= warmLead && !warmChecked) {
					warmChecked = true;
				} else if (remaining <= EXPIRY_LEAD_MS && !attempted) {
					// Pi's own refresh may still be in flight; its usage entry moves the expiry when it lands.
					if (piWarmAt !== undefined && Date.now() - piWarmAt < 30_000) return;
					attempted = true;
					compactBeforeExpiry(ctx, remaining);
				}
			} else {
				// A taken period, whoever warms it: its refresh where the extension warms it, and compacting before the expiry
				// its own facts give (Pi's refreshes do not move it, so nothing waits for them).
				if (remaining <= warmLead) keepWarm(ctx, timer);
				if (!warming && !out && remaining <= EXPIRY_LEAD_MS && !attempted) {
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
	// One warmer per idle period. What a decision of Pi's own warming that arrives while the window is idle (between
	// agent_settled and agent_start, and Pi idle) is told is warm-period.ts's (`answerToPi`): stopped where the extension
	// keeps the period warm itself, or kept it until its warming ended; for a period handed over to Pi, stopped only once
	// nothing seen says its cache is alive. In any other state, and with keep-warm off, nothing: Pi's decision stands.
	pi.on("cache_warming_decision", (event, ctx) => {
		const p = period;
		// A fresh read of the saved setting: a switch-off in any window holds from this decision on.
		keepWarmSetting(true);
		// The cache's clock read afresh first (Pi's refreshes since the answer, the route now): evidence against the period
		// changes its hands before Pi is answered.
		const idle = !running && ctx.isIdle();
		const view = idle && p?.taken ? look(ctx) : undefined;
		const who = warmerOf(period);
		const action = answerToPi({ warmer: who, idle, goneBy: view?.goneBy, now: Date.now() });
		if (action && p?.budget) {
			trace(ctx, {
				...warmBase(ctx, p, view?.sendBy ?? Date.now(), {
					model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
					lifetimeSeconds: view?.lifetime && view.lifetime.ms / 1000,
					lifetimeSource: view?.lifetime?.source,
				}),
				action: "pi-stopped",
				reason:
					who === "Pi, handed over"
						? `this idle period's cache is gone by everything seen, Pi's own refreshes included, so a refresh would write it again (Pi would have ${event.action === "warm" ? "refreshed" : "stopped"})`
						: `this extension keeps this idle period's cache warm (Pi would have ${event.action === "warm" ? "refreshed" : "stopped"})`,
				budget: budgetRecord({ ...p, budget: p.budget }),
			});
			return { action };
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
		if (ctx.hasUI && ctx.model && look(ctx).lifetime) countdown = { state: "running" };
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
		// The period's clock is told the route that served its model, also where nothing reads it before it changes again.
		const p = period;
		if (p?.clock && p.fixed?.model === `${event.provider}/${event.model}`) p.clock.served(routeKeyOf({ provider: event.provider, id: event.model }, event.upstreams));
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

	const checkCachedPath = (ctx: ExtensionContext, entries: SessionEntry[], model: Model<Api> | undefined): CachedPath | { reason: string } => checkRequestPath(ctx, entries, model, captured);
	// The same check for a given request: a keep-warm period checks the request of its own answer.
	const checkRequestPath = (ctx: ExtensionContext, entries: SessionEntry[], model: Model<Api> | undefined, request: CapturedRequest | undefined): CachedPath | { reason: string } => {
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
		const cache = look(ctx, { model: request.model, entries });
		if (!cache.cached) return { reason: "the last request did not use the prompt cache" };
		// A taken period's cache whose expiry is unknown: nothing is sent on it.
		if (cache.unknown) return { reason: `the prompt cache's expiry is unknown: ${cache.unknown}` };
		if (cache.sendBy !== undefined && Date.now() >= cache.sendBy) return { reason: "the prompt cache has expired" };
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
		const check = checkCachedPath(ctx, event.branchEntries, ctx.model);
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
			expiresInSeconds: cache.sendBy === undefined ? undefined : Math.round((cache.sendBy - Date.now()) / 1000),
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
		// Compacting before expiry has a last gate, as a refresh does: the summary is only worth sending while the cache is
		// warm, so the cache's clock is read again just before the request leaves (after its preparation, a credential
		// lookup say), and once the cache has expired, or its expiry became unknown, the request does not leave and the
		// compaction is cancelled.
		let expiredAtGate: string | undefined;
		const gate = () => {
			if (!fromExpiry) return;
			let view: CacheView | undefined;
			try {
				view = look(ctx, { model: request.model, entries: event.branchEntries });
			} catch {
				view = undefined;
			}
			if (view?.sendBy !== undefined && Date.now() < view.sendBy) return;
			expiredAtGate = view?.unknown ? `the prompt cache's expiry became unknown before the summary request left: ${view.unknown}` : "the prompt cache expired before the summary request left";
			throw new Error(expiredAtGate);
		};
		const thinkingLevel = pi.getThinkingLevel();
		const controller = new AbortController();
		const disableTools = prefix !== undefined && isOpenAiResponses(request.model);
		const cacheNeutral = new Set(disableTools ? ["tool_choice"] : []);
		const sharedKey = prefix ? sharedPrefixKey(request.model, ctx.cwd) : undefined;
		const requestInfo = { thinking: thinkingLevel, bridgeFork: prefix === undefined, toolChoiceNone: disableTools, sharedPrefix: false };
		record.request = requestInfo;
		// Through pi-claude-bridge there is no payload hook: the last check is just before the request is handed to it.
		if (!prefix) {
			try {
				gate();
			} catch {
				return fallBack(expiredAtGate ?? "the prompt cache expired before the summary request left");
			}
		}
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
							gate();
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
			if (expiredAtGate) return fallBack(expiredAtGate);
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

		if (expiredAtGate) return fallBack(expiredAtGate);
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
		description: "Start keeping the cache warm again for models two refreshes in a row without a hit left to Pi's own warming",
		handler: async (_args, ctx) => {
			const fellBack = [...misses.fallback.keys()].sort();
			const counted = [...misses.counts.entries()].filter(([model, count]) => count > 0 && !misses.fallback.has(model)).map(([model]) => model).sort();
			misses.fallback.clear();
			misses.fallbackKinds.clear();
			misses.counts.clear();
			misses.kinds.clear();
			const off = warmMinutes(true) > 0 ? "" : " Keep-warm itself is off (keepWarmMinutes: 0); /cache-keeper-settings turns it on.";
			let text: string;
			if (fellBack.length > 0) {
				const also = counted.length > 0 ? ` The count of refreshes without a hit of ${counted.join(", ")} is cleared too.` : "";
				text = `pi-cache-keeper keeps ${fellBack.join(", ")} warm again, at the latest from your next message: an idle period already running whose own warming had not ended is kept warm again at once.${also}${off}`;
			} else if (counted.length > 0) {
				text = `No model was left to Pi's own warming. The count of refreshes without a hit of ${counted.join(", ")} is cleared.${off}`;
			} else text = `Nothing to clear: no model was left to Pi's own warming, and no refresh was counted without a hit.${off}`;
			ctx.ui.notify(text, "info");
			renderFooter(ctx);
		},
	});

	pi.registerCommand("cache-keeper", {
		description: "Show the prompt cache state, the model data in use and this session's compaction log",
		handler: async (_args, ctx) => {
			const entries = ctx.sessionManager.getBranch();
			const model = ctx.model;
			const state = model && look(ctx, { model, entries });
			let cache = "lifetime unknown, so no countdown";
			if (state?.lifetime) {
				let left = state.replied ? "the last request did not use the prompt cache" : "no request since the session started or compacted";
				if (state.sendBy !== undefined) left = state.sendBy > Date.now() ? `${formatRemaining(state.sendBy - Date.now())} left` : "expired";
				// Where the expiry is unknown, the cache counts as expired, and why.
				else if (state.unknown) left = "expired";
				cache = `${left} (lifetime ${formatDuration(state.lifetime.ms)}, ${state.lifetime.source})${state.unknown ? `, counted as expired: ${state.unknown}` : ""}`;
			}
			const check = checkCachedPath(ctx, entries, model);
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
