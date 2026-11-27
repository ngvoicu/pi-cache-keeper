import { createHash } from "node:crypto";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { calculateCost, contentText, type Api, type AssistantMessage, type Model, type Usage } from "@earendil-works/pi-ai";
import {
	compact,
	convertToLlm,
	getLastAssistantUsage,
	getLatestCompactionEntry,
	getSelectListTheme,
	getSettingsListTheme,
	keyHint,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, getKeybindings, Input, SettingsList, Text, type Component, type SettingItem } from "@earendil-works/pi-tui";
import { cacheTier, hasExplicitPromptCache, isKimiOnMoonshot, lifetimeFor } from "./cache-state.ts";
import {
	fallbackChoiceParts,
	fallbackModelFit,
	fallbackModelLabel,
	fallbackModelParts,
	fallbackNeedTokens,
	fallbackRequestTokens,
	fallbackRowLines,
	fallbackUnusable,
	formatModelRef,
	modelSearchText,
	orderFallbackChoices,
	parseModelRef,
	summaryBody,
	type FallbackChoice,
	type FallbackRow,
	type LinePart,
} from "./fallback-compaction.ts";
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
	readSessionSettings,
	sameSessionSettings,
	saveConfig,
	SESSION_KEYS,
	SESSION_SETTINGS_TYPE,
	sessionSettingsOn,
	SETTINGS_KEY,
	settingsInEffect,
	summaryBudget,
	withSessionValue,
	type CacheKeeperConfig,
	type SessionKey,
	type SessionSettings,
} from "./config.ts";
import {
	appendTrace,
	comparison,
	describeTrace,
	formatDuration,
	formatRemaining,
	formatTokens,
	noticeOf,
	readTraces,
	SWITCHED_OFF,
	TRACE_PATH_LABEL,
	stopLabel,
	traceDetails,
	type ColdTrace,
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
	DATA_READING,
	DATA_SOURCE,
	describeFound,
	desiredOverride,
	fetchDataset,
	findFacts,
	fieldStates,
	accessVia,
	allNamed,
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
	type GatewayFigures,
	type Lookup,
} from "./model-data.ts";
import { agentDirLabel, covers, firstSaid, noteMessage, readStop, rememberLoad, seenFor, stopPathLabel, writeStop, type StopRead } from "./stop-record.ts";
import { answerToPi, end, leave, mayLeave, onAgainst, settle, WAITING, warmer, type Warmer, type WarmPhase } from "./warm-period.ts";
import { formatFooter, lifetimesView, lookupsText, NOTE_ID_COLUMNS, priceAt, sentView, servedText, servedView, tierInUse, type Countdown, type DataView, type FooterView, type KeepWarmView, type PriceView } from "./footer.ts";

/** A session's own value of a setting. */
type SessionValue = number | boolean | string;
/** The settings whose menu row steps through its values on Enter (the fallback compaction model opens a list instead). */
type CycledKey = Exclude<SessionKey, "fallbackCompactionModel">;

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
	/** When it was sent and when its answer ended, as places in the order of events (see `order`). */
	sentSeq?: number;
	answeredSeq?: number;
	/** Its answer says Pi re-sent the request in another form after the provider rejected it (RESENT_DIAGNOSTICS): the
	 * request captured here is not the one whose answer wrote the cache. */
	resent?: boolean;
}

/** What a proxy reported served a request of a model (ANSWERED_EVENT): the report whole, as one text, and when it came. */
interface RouteReport {
	at: number;
	/** Its place among the events that order a period's route: requests sent, answers ended, reports (see `order`). */
	seq: number;
	/** The model it is for, as `provider/id`. */
	key: string;
	/**
	 * The whole report, every field the proxy sent, keys in a fixed order: two reports are one route only when equal. A
	 * report that names no route (`upstreams: []`) is one of its own, equal to no other, an unnamed one included.
	 */
	identity: string;
	upstreams: Upstream[];
}
/** A value as JSON with its object keys sorted, so that equal reports read as equal text. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (isPlainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
	return JSON.stringify(value) ?? "null";
}

/** A cache lifetime under this cannot carry a refresh: Pi's own warming keeps such a session, if anything does. */
const MIN_OWNED_LIFETIME_MS = 60_000;
// What Pi 1.5.2's Anthropic adapter adds to an answer whose request the provider rejected for its strict tools (a 400 over
// the provider's limits), after it re-sent the request without them: the answer's cache was written by the second form,
// not the request the extension saw first. Such a period is left to Pi. Later requests of the session are built without
// strict tools from the start, so they carry no such note and are captured as sent.
const RESENT_DIAGNOSTICS = new Set(["anthropic_strict_tools_fallback"]);

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
	/** When the period's request was sent, as a place in the order of events: reports of its model since then are about
	 * its route. */
	since: number;
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
	/**
	 * The id of the /cache-keeper-stop record the window had seen at the user's latest message when the period started
	 * (none: no record), set once (stop-record.ts). The period obeys a record that is not this one.
	 */
	seen: string | null;
	/** The stop the period obeys, set once (`obeyStop`): nothing warms it, the extension or Pi, for the rest of it. */
	stopped?: { id: string; at: number };
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
const REQUEST_LET_GO = "you switched the model or the branch, or the conversation was compacted, so the extension no longer has the request to re-send";
/** What the footer says of it, in a few words. */
const REQUEST_LET_GO_LABEL = "you switched model or branch, or compacted";
/**
 * The request forms whose cache markers `requestCache` reads: Anthropic Messages (`cache_control`) and OpenAI's Chat
 * Completions and Responses (Codex's and Azure's too). Pi's other adapters write theirs in forms it does not read
 * (Bedrock's `cachePoint`, Gemini's `cachedContent`), so for those the footer says nothing of what was sent.
 */
const MARKERS_READ: ReadonlySet<string> = new Set(["anthropic-messages", "openai-completions", "openai-responses", "openai-codex-responses", "azure-openai-responses"]);
const httpFetch: Fetch = (url, init) => fetch(url, init);
const CARD_TYPE = "cache-keeper";
/** The saved entry of one refresh the extension sent: its line in the transcript, kept in the session (`{ level, text }`). */
const REFRESH_LINE_TYPE = "cache-keeper-refresh";
const PREFIX_MISMATCH = "pi-cache-keeper: request prefix differs from the cached request";
const BRIDGE_API = "claude-bridge";
const COMPACTION_ABORTED = "the compaction was aborted";
/** The cached path's reason where a taken period's expiry is unknown: Pi's own compaction runs, never the fallback model. */
const EXPIRY_UNKNOWN = "the prompt cache's expiry is unknown";
/** The model data was downloaded and is in use in this window, but could not be saved, or put into models.json. */
/**
 * How far new model data got before a step failed: not saved in cache-keeper-models.json; saved, with models.json as it
 * was; written into models.json, with Pi's models not reloaded; reloaded, with the model in use not selected again.
 */
type DataStage = "not saved" | "models.json unchanged" | "written, not loaded" | "loaded, not reselected";
class DataNotApplied extends Error {
	readonly stage: DataStage;
	constructor(stage: DataStage, cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		this.stage = cause instanceof DataNotApplied ? cause.stage : stage;
	}
}
const FALLBACK_ROW_LABEL = "When the cache can't be used, compact with";
/** The fallback model list's first line, editing a session: drop its own value. Never a model reference (it has no slash). */
const FALLBACK_DEFAULT_PICK = "default";
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

/**
 * Per session id, how a refresh's line is saved in that session now: through the instance that runs it. Pi loads the
 * extension again on /reload, so a refresh sent by one instance can settle after the next took over the same session;
 * its line is saved through this, whichever instance sent it. Kept on `globalThis` for the process.
 */
const LINE_WRITERS = Symbol.for("pi-cache-keeper.line-writers");
interface LineWriter {
	hasUI: boolean;
	append: (line: { level: "info" | "warning"; text: string }) => void;
}
function lineWriters(): Map<string, LineWriter> {
	const host = globalThis as Record<symbol, unknown>;
	if (!(host[LINE_WRITERS] instanceof Map)) host[LINE_WRITERS] = new Map<string, LineWriter>();
	return host[LINE_WRITERS] as Map<string, LineWriter>;
}

/** A period changing hands: why, the end of its warming where it ended then, and the reason. */
type Handed = { stop?: WarmStop; reason: string; handedOver: "evidence" | "let go" };

/** A clock time for what the user reads: "14:02". */
const hhmm = (at: number) => new Date(at).toTimeString().slice(0, 5);

/** A row of the fallback compaction model's list: the value it picks, how it is drawn, and the text it is searched by. */
interface FallbackEntry {
	value: string;
	row: FallbackRow;
	search: string;
}

/**
 * The fallback compaction model's list, drawn as Pi's /model picker draws its models (Pi 1.6.0, model-selector.js
 * updateList): "→ " on the selected row and its id in the accent colour, "✓ " on the value in effect, the distinct name
 * and the `[provider]` badge muted; then the window, access and fit, muted. Its keys and its `maxVisible` rows around
 * the selection are Pi's select list's. Each row is laid out by fallbackRowLines: the id, name and badge whole, over a
 * second line where they need it; the window, access and fit cut first.
 */
function fallbackModelList(
	items: FallbackEntry[],
	current: string | undefined,
	searched: boolean,
	maxVisible: number,
	done: (value?: string) => void,
): Component & { handleInput: (data: string) => void } {
	// As Pi's picker: the list opens on the value in effect; a search selects its best match, the first.
	let selected = searched ? 0 : Math.max(0, items.findIndex((entry) => entry.value === current));
	let cached: { width: number; rows: LinePart[][][] } | undefined;
	const rowsAt = (width: number) => {
		if (cached?.width !== width) cached = { width, rows: fallbackRowLines(items.map((item) => item.row), width) };
		return cached.rows;
	};
	return {
		render: (width: number) => {
			const theme = getSelectListTheme();
			if (items.length === 0) return [theme.noMatch("  No matching models")];
			// As Pi's picker: the selection marker and the mark of the current model, 2 columns each; and, as Pi's select
			// list, 2 columns kept free at the right.
			const rows = rowsAt(Math.max(1, width - 6));
			const start = Math.max(0, Math.min(selected - Math.floor(maxVisible / 2), items.length - maxVisible));
			const end = Math.min(start + maxVisible, items.length);
			const lines: string[] = [];
			for (let i = start; i < end; i++) {
				const isSelected = i === selected;
				const draw = (part: LinePart) =>
					part.kind === "gap" ? part.text : part.kind === "id" || part.kind === "label" ? (isSelected ? theme.selectedText(part.text) : part.text) : theme.description(part.text);
				rows[i].forEach((parts, at) => {
					const marks = at > 0 ? "    " : `${isSelected ? theme.selectedPrefix("→ ") : "  "}${items[i].value === current ? theme.selectedPrefix("✓ ") : "  "}`;
					lines.push(`${marks}${parts.map(draw).join("")}`);
				});
			}
			if (start > 0 || end < items.length) lines.push(theme.scrollInfo(`  (${selected + 1}/${items.length})`.slice(0, Math.max(0, width - 2))));
			return lines;
		},
		invalidate: () => {
			cached = undefined;
		},
		handleInput: (data: string) => {
			const keys = getKeybindings();
			const last = items.length - 1;
			if (keys.matches(data, "tui.select.up")) selected = selected === 0 ? last : selected - 1;
			else if (keys.matches(data, "tui.select.down")) selected = selected === last ? 0 : selected + 1;
			else if (keys.matches(data, "tui.select.pageUp")) selected = Math.max(0, selected - maxVisible);
			else if (keys.matches(data, "tui.select.pageDown")) selected = Math.max(0, Math.min(last, selected + maxVisible));
			else if (keys.matches(data, "tui.select.confirm")) {
				const item = items[selected];
				if (item) done(item.value);
			} else if (keys.matches(data, "tui.select.cancel")) done();
		},
	};
}

export default function cacheKeeper(pi: ExtensionAPI) {
	// The /cache-keeper-stop record in place when the process first loaded the extension stops nothing (stop-record.ts).
	rememberLoad();
	// The defaults (cacheKeeper in the global settings), and this session's own values over them (the latest settings entry
	// on the current branch, read at session_start and after /tree; the menu changes it and saves it when it closes).
	let config = loadConfig();
	let own: SessionSettings = {};
	// The defaults as saved now: settings.json is read and parsed again at every decision that uses one (another window, or
	// another session of this process, may have saved them), in the menu and in /cache-keeper. A file that can't be read
	// or parsed leaves the last defaults that parsed. cacheRetention and modelData keep their own path (`config`): a change
	// of them is applied where it is made.
	let latest = config;
	const defaultsNow = (): CacheKeeperConfig => {
		try {
			latest = loadConfig();
		} catch {
			// The last defaults that parsed; read again at the next decision.
		}
		return latest;
	};
	const inEffect = (): CacheKeeperConfig => {
		const now = defaultsNow();
		const defaults = { ...config };
		for (const name of SESSION_KEYS) (defaults as Record<string, unknown>)[name] = now[name];
		return settingsInEffect(defaults, own);
	};

	let pendingTranscript: AgentMessage[] | undefined;
	let captured: CapturedRequest | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;
	// Set while a compaction the extension started itself is running.
	let ownTrigger: "expiry" | "full" | undefined;
	// The last "full" skip reason logged, so a context that stays past the mark logs each reason once.
	let lastFullSkip: string | undefined;
	// Set when compacting "when full" left the context past the mark, so it is not retried after every turn.
	let fullStuck: string | undefined;
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
		// This session's own value wins; without one, the defaults as saved now.
		if (own.keepWarmMinutes !== undefined) value = { minutes: own.keepWarmMinutes };
		else {
			try {
				value = { minutes: loadConfig().keepWarmMinutes };
			} catch {
				value = undefined;
			}
		}
		keepWarmRead = { at: now, value };
		return value;
	};
	const warmMinutes = (fresh = false) => keepWarmSetting(fresh)?.minutes ?? 0;
	// This session's own values change (read from the branch, or set in the menu): keep-warm is read again at once.
	// Compacting when full tries again once the mark in effect changed, whichever layer changed it (see `fullStuck`).
	const setOwn = (next: SessionSettings) => {
		own = next;
		keepWarmRead = undefined;
	};
	// The values saved on the current branch: what the menu compares with when it closes.
	let ownSaved: SessionSettings = {};
	const readOwn = (ctx: ExtensionContext) => {
		ownSaved = sessionSettingsOn(ctx.sessionManager.getBranch());
		setOwn(ownSaved);
	};
	// The /cache-keeper-stop record, read as the settings are: once per millisecond, `fresh` reads again.
	let stopRead: { at: number; value: StopRead } | undefined;
	const stopRecord = (fresh = false): StopRead => {
		const now = Date.now();
		if (!fresh && stopRead?.at === now) return stopRead.value;
		const value = readStop();
		stopRead = { at: now, value };
		return value;
	};
	// The request whose answer was the latest to read or write the cache: a later request that failed before using the
	// cache does not replace it.
	let answerRequest: CapturedRequest | undefined;
	let running = false;
	let warming: AbortController | undefined;
	let piWarmAt: number | undefined;
	// The session this instance runs (from its session_start), for what settles after its context went stale.
	let sessionId: string | undefined;
	// The expiries whose try to compact before them was spent, for the answer the countdown read them from: one try per
	// expiry, for every expiry that answer has had (a retention switched back returns to an expiry already tried), across
	// every start of the countdown. A new answer starts with none.
	const spent: { answer: number | undefined; expiries: Set<number> } = { answer: undefined, expiries: new Set() };
	const spentFor = (answer: number | undefined): Set<number> => {
		if (spent.answer !== answer) {
			spent.answer = answer;
			spent.expiries = new Set();
		}
		return spent.expiries;
	};
	// The one read of the cache everything reads (cache-clock.ts): the countdown and the footer, the refresh and its last
	// gate, compacting before expiry and its last check, the cached path's check, /cache-keeper and what Pi's warming is
	// told. For a period the extension took at its start, on its model and while the branch in front of the user still
	// holds its answer, the period's clock; otherwise exactly as with keep-warm off. The clock is told what is read now
	// (the route serving the model, the route's lifetime for the request's tier); what it says against the period goes to
	// who warms it (`changeHands`), recorded as a skip unless the caller takes it (`taken`). Its expiry is `sendBy`: where
	// it is unknown, nothing is sent.
	const look = (ctx: ExtensionContext, at: { model?: Model<Api>; entries?: SessionEntry[] } = {}, taken?: (handed: Handed) => void): CacheView => {
		const model = at.model ?? ctx.model;
		if (!model) return { regime: "plain", cached: false, replied: false };
		const entries = at.entries ?? ctx.sessionManager.getBranch();
		const key = `${model.provider}/${model.id}`;
		const p = period;
		// A taken period's model is read with what served it since its run started (its own report), else as configured.
		const mine = p?.taken === true && p.fixed?.model === key;
		const own = mine && p ? reportSince(model, p.since) : undefined;
		const served = servedModel(model);
		const routed = own ? servedModel(model, own.upstreams) : model;
		// The session's model is not the one the period's cached request was written with.
		if (p?.fixed && key !== p.fixed.model && model === ctx.model) handTo(ctx, p, { reason: `the model is now ${key}, the cached request was written with ${p.fixed.model}`, label: "the model changed" }, taken);
		const clock = p?.taken && p.fixed?.model === key ? p.clock : undefined;
		const view = cacheView(
			served,
			entries,
			clock && p?.fixed ? { clock, on: warmMinutes() > 0, served: routed, routeKey: own?.identity ?? standIn(model), dataMs: lifetimeFor(routed, p.fixed.tier)?.ms, requested: p.fixed.requested } : undefined,
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
	const whyNotOwned = (
		state: StartFacts | undefined,
		model: Model<Api> | undefined,
		route: { identity: string; changed?: "while out" | "after the answer" | "unnamed"; upstreams?: Upstream[] },
	): { reason: string; label?: string } | { clock: PeriodClock } => {
		const no = (label: string | undefined, reason: string) => ({ reason, ...(label ? { label } : {}) });
		const fellBack = fallbackFor(model);
		// While it lasts the footer says it on its own; after /cache-keeper-warm the period stays Pi's until the next answer.
		if (fellBack) return no("until your next message", fallbackLine(fellBack.key, fellBack.at));
		if (state?.answeredAt === undefined) return no(undefined, "no answer has read or written the prompt cache yet");
		// Before the lifetime: an unnamed route has no data of its own, and that is not why the period is Pi's.
		if (route.changed === "unnamed") return no("the route is unknown", "the proxy did not name the route that served the last answer, so which route's cache it wrote is not known");
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
		if (request.resent) {
			return no("request re-sent", "Pi re-sent the last answer's request in another form after the provider rejected it (strict tools over the provider's limits), so the request the extension saw is not the one whose cache the answer wrote");
		}
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
		// The proxy reported different routes for the model during the answer's run (also between the answer and Pi going
		// idle): which cache the answer wrote is not known.
		if (route.changed === "while out") return no("the route changed", "the proxy reported different routes for this model while the last answer's request was out, so which route's cache it wrote is not known");
		if (route.changed === "after the answer") {
			return no("the route changed", "the proxy reported a route for this model after the last answer ended that is not the answer's own (or none for the answer itself), so which route's cache the answer wrote is not known");
		}
		// The period's lifetime, whether everything seen so far agrees with it, and whether it is the one the start facts
		// count with (cache-clock.ts, lifetime-evidence.ts): the clock of the period's cache, else why not.
		const routed = route.upstreams ? servedModel(request.model, route.upstreams) : request.model;
		const started = PeriodClock.start({ facts: state, api: request.model.api, cache, dataMs: lifetimeFor(routed, cache.tier)?.ms, routeKey: route.identity });
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
		// At the prices of what served the answer, where the gateway named it (`routed`); otherwise the model's own.
		if (state.answerPrompt !== undefined && !refreshCanPay(warmBudget(routed, state.answerPrompt))) return no("a refresh costs a miss", "at this model's prices a refresh costs as much as a miss");
		return started;
	};
	// Pi is idle. After a run that brought a new real answer (or at a session's start) a new period starts; after one that
	// sent nothing, the period goes on, with its spending and its time limit.
	const goIdle = (ctx: ExtensionContext, fresh = false) => {
		running = false;
		const requested = answerRequest?.cache?.tier ?? answerRequest?.tier ?? "short";
		const model = ctx.model;
		// The route of the period's answer: the report of its model that came while the answer's request was out, between
		// its sending and the answer's end (none reported: the configured upstreams stand in). Reports in that window that
		// differ leave it unknown; so does a report of the model after the answer's end, before Pi went idle, that is not
		// the answer's own (or any, where none came for the answer): it may be another request's, on another route.
		const key = model ? `${model.provider}/${model.id}` : "";
		const asked = answerRequest && `${answerRequest.model.provider}/${answerRequest.model.id}` === key ? answerRequest : undefined;
		const sentSeq = asked?.sentSeq ?? order;
		const answeredSeq = asked?.answeredSeq ?? order;
		const ofModel = runLog.filter((r) => r.key === key);
		const inWindow = ofModel.filter((r) => r.seq > sentSeq && r.seq < answeredSeq);
		const reported = inWindow[0];
		const later = ofModel.filter((r) => r.seq > answeredSeq);
		const route = {
			identity: reported?.identity ?? (model ? standIn(model) : "none reported"),
			// An answer whose report names no route (`upstreams: []`) has an unknown route: nothing is warmed on a guess.
			changed: reported?.upstreams.length === 0
				? ("unnamed" as const)
				: inWindow.some((r) => r.identity !== reported?.identity)
				? ("while out" as const)
				: later.some((r) => reported === undefined || r.identity !== reported.identity)
					? ("after the answer" as const)
					: undefined,
			...(reported ? { upstreams: reported.upstreams } : {}),
		};
		const state = model ? startFacts(reported ? servedModel(model, reported.upstreams) : model, ctx.sessionManager.getBranch(), requested) : undefined;
		const answeredAt = state?.answeredAt;
		if (!fresh && period && (answeredAt === undefined || answeredAt === period.answeredAt)) return;
		const took = whyNotOwned(state, answerRequest?.model ?? ctx.model, route);
		const why = "reason" in took ? took : undefined;
		const clock = "clock" in took ? took.clock : undefined;
		const request = clock ? answerRequest : undefined;
		const onAtStart = warmMinutes(true) > 0;
		// Priced as what served the answer, where the gateway named it; otherwise at the model's own prices, as before.
		const budget = request && state?.answerPrompt !== undefined ? warmBudget(route.upstreams ? servedModel(request.model, route.upstreams) : request.model, state.answerPrompt) : undefined;
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
			seen: seenFor(ctx.sessionManager.getSessionId()),
			since: sentSeq,
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
					stopped: p.stopped !== undefined,
					taken: p.taken,
					on: warmMinutes() > 0,
					// Two misses in a row on the period's model, also one reported after the period started.
					fellBack: p.fixed !== undefined && misses.fallback.has(p.fixed.model),
					handedOver: p.handedOver !== undefined,
					warm: p.warm,
				});
	// The extension keeps this period's cache warm, or kept it until its warming ended (Pi's warming stays stopped).
	// A stopped period the extension had taken is still its own here: it has the budget, the fixed values and the clock,
	// and `obeyStop` has ended its warming, so nothing is sent on it.
	const owns = (p: WarmPeriod | undefined): p is WarmPeriod & { budget: WarmBudget; fixed: NonNullable<WarmPeriod["fixed"]>; clock: PeriodClock } => {
		const who = warmerOf(p);
		return who === "the extension" || who === "nobody" || (who === "nobody, stopped" && p?.taken === true);
	};
	const abortWarm = () => {
		warming?.abort();
		warming = undefined;
	};

	// Every record goes to the log; each `warm` record is said too (what is logged is said): the line of a refresh that was
	// sent is kept in the session as a saved entry, so every refresh keeps its own line, also after a reload; every
	// other one is a notice.
	// It never throws: where the context is stale (a refresh settling after /reload), the record is for the session this
	// instance last ran, and a refresh's line is saved through the instance that runs that session now.
	const trace = <E extends TraceEvent>(ctx: ExtensionContext, event: E) => {
		let session: string;
		let live = true;
		try {
			session = ctx.sessionManager.getSessionId();
		} catch {
			live = false;
			session = sessionId ?? "";
		}
		const record = { ...event, at: new Date().toISOString(), session };
		try {
			appendTrace(record);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ifSessionAlive(() => {
				if (ctx.hasUI && message !== traceError) ctx.ui.notify(`pi-cache-keeper could not write ${TRACE_PATH_LABEL}: ${message}`, "warning");
			});
			traceError = message;
		}
		if (record.event === "warm") {
			const warm = record as WarmTrace;
			const notice = noticeOf(warm, keepWarmLabel(warmMinutes()));
			if (notice && warm.refresh !== undefined) {
				// A live context writes through this instance, which runs the session; a stale one through the instance that
				// runs it now.
				if (live) {
					ownWriter.hasUI = ctx.hasUI;
					lineWriters().set(session, ownWriter);
				}
				keepLine(session, notice);
			}
			else if (notice) say(ctx, notice);
		}
		return record;
	};
	// A refresh's line, saved in the session (Pi's custom entry, drawn by the renderer below and again on reload), through
	// whichever instance runs that session now. Only where the session has an interface; never thrown out of.
	const keepLine = (session: string, notice: { level: "info" | "warning"; text: string }) => {
		const writer = lineWriters().get(session);
		if (!writer?.hasUI) return;
		try {
			writer.append({ level: notice.level, text: notice.text });
		} catch {
			// The session is gone: nothing to save it in.
		}
	};
	// This instance's writer, while it runs its session.
	const ownWriter: LineWriter = { hasUI: false, append: (line) => pi.appendEntry<{ level: "info" | "warning"; text: string }>(REFRESH_LINE_TYPE, line) };
	pi.registerEntryRenderer<{ level?: string; text?: string }>(REFRESH_LINE_TYPE, (entry, _options, theme) => {
		const text = entry.data?.text;
		if (typeof text !== "string" || !text) return undefined;
		return new Text(theme.fg(entry.data?.level === "warning" ? "warning" : "dim", text), 1, 0);
	});

	// The one door of the extension's notices about keeping warm and a stop: said where the session has an interface, and
	// never thrown out of (a session that is gone says nothing).
	const say = (ctx: ExtensionContext, notice: { level: "info" | "warning" | "error"; text: string }) => {
		if (!ctx.hasUI) return;
		ifSessionAlive(() => ctx.ui.notify(notice.text, notice.level));
	};

	const renderCard: Parameters<typeof pi.registerEntryRenderer<{ records: TraceRecord[] }>>[1] = (entry, { expanded }, theme) => {
		const records = entry.data?.records;
		if (!records?.length) return undefined;
		const byFallbackModel = records.some((record) => record.event === "compact" && record.outcome === "cold");
		const lines = [`${theme.fg("accent", byFallbackModel ? "fallback model compaction" : "cached compaction")}${expanded ? "" : `  ${theme.fg("muted", "(")}${keyHint("app.tools.expand", "for details")}${theme.fg("muted", ")")}`}`];
		for (const record of records) {
			const line = describeTrace(record);
			// A summary the fallback model wrote is not a warning: nothing went wrong.
			const missed = record.event === "failed" || (record.event === "compact" && record.outcome !== "cold" && (record.outcome !== "cached" || record.response?.usage.cacheRead === 0));
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
	const showCard = (records: TraceRecord[]) => pi.appendEntry<{ records: TraceRecord[] }>(CARD_TYPE, { records });

	// The footer (see footer.ts): the countdown as the timer last set it, the model's values as showData last read them,
	// and what keep-warm says now, fitted to the terminal's width. Pi is told only when the text changes.
	let countdown: Countdown | undefined;
	let modelView: Omit<FooterView, "countdown" | "keepWarm"> | undefined;
	// The regime of the countdown's reading when it started.
	let timerRegime: CacheView["regime"] | undefined;
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
		const text = model ? formatFooter({ countdown, keepWarm: keepWarmView(model), stopped: period?.stopped !== undefined && !running, ...modelView }, footerWidth(), (piece, tone) => ctx.ui.theme.fg(tone, piece)) : undefined;
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
		if (p) handTo(ctx, p, { reason: REQUEST_LET_GO, label: REQUEST_LET_GO_LABEL }, undefined, undefined, "let go");
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
	// Behind a gateway that names the providers.dev entry of what answers (Provimux), the figures it gave: an upstream
	// that names an entry takes its values from them alone. With model data off, none.
	const figuresOf = (provider: string): GatewayFigures | undefined => (config.modelData ? data.gateway?.[provider] : undefined);
	const factsOf = (model: { provider: string }, lookups: Lookup[]): Found => findFacts(lookups, data.providers, figuresOf(model.provider));
	const foundFor = (ctx: ExtensionContext, model: Model<Api>, accessOf = accessReader(ctx)): Found => factsOf(model, lookupsFor(model, accessOf(model)));

	// What served the last request to a proxy model, as its extension said. The values in models.json are those of
	// what may serve it; when something else answered (that failed or is cooling down, or several take turns), the
	// lifetime of what answered is the one that holds.
	let answered: { provider: string; id: string; upstreams: Upstream[] } | undefined;
	const answeredFor = (model: Model<Api> | undefined): Upstream[] | undefined =>
		model && answered && answered.provider === model.provider && answered.id === model.id ? answered.upstreams : undefined;
	const lookupKeys = (model: Model<Api>, access: Access) =>
		lookupsFor(model, access)
			.map((one) => (one.entry !== undefined ? `entry:${one.entry ?? ""}` : `${one.provider}/${one.model}`))
			.sort()
			.join(" ");
	// What answered (`upstreams`, by default the last answer reported for any model), when it is not what the values
	// are for.
	const servedOtherwise = (model: Model<Api> | undefined, upstreams = answeredFor(model)): Upstream[] | undefined => {
		const route = model ? data.upstreams[model.provider]?.[model.id] : undefined;
		if (!model || !upstreams || !route) return undefined;
		return lookupKeys(model, { upstreams }) === lookupKeys(model, { upstreams: route.upstreams }) ? undefined : upstreams;
	};
	// The model with the lifetimes of what served it: `upstreams` where given (a taken period's own report), else the last
	// answer reported for any model, as with keep-warm off.
	const servedModel = (model: Model<Api>, served?: Upstream[]): Model<Api> => {
		const reported = served ?? answeredFor(model);
		// Where the gateway named what answered (Provimux), that entry's values hold for the answer, also where the route
		// names the same entry: models.json reaches the session's model only once Pi is idle again.
		const named = reported && reported.length > 0 && allNamed(lookupsFor(model, { upstreams: reported })) ? reported : undefined;
		const upstreams = named ?? servedOtherwise(model, reported);
		if (!upstreams) return model;
		const lookups = lookupsFor(model, { upstreams });
		const found = factsOf(model, lookups);
		const short = usableLifetime(found.facts.short);
		const long = usableLifetime(found.facts.long);
		const promptCache = short === undefined && long === undefined ? undefined : { ...(short === undefined ? {} : { short }), ...(long === undefined ? {} : { long }) };
		// Where the gateway named what answered, its price too: the entry's, or none (no price is guessed). Otherwise Pi's
		// price stays, as before.
		if (!allNamed(lookups)) return { ...model, promptCache };
		return { ...model, promptCache, cost: found.facts.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	};
	// What served a request of each model (`provider/id`), as a proxy reported it (ANSWERED_EVENT): the latest report,
	// whole, with when it arrived. A report for one model never stands for another, and a model switch keeps them. The
	// route's identity a taken period compares is the whole report (every field the proxy sent), not the model-data lookup
	// it leads to: a subscription login and an API key of one upstream are different routes, with caches of their own.
	const reports = new Map<string, RouteReport>();
	// The order of the events that place a report with a request: a request sent, its answer ended, a report arrived. A
	// report carries no request id, so whether it is a request's own goes by where it falls in this order.
	let order = 0;
	// The reports of the current run (since its agent_start, or since the extension loaded), in order. The period a run's
	// answer starts takes its route from here.
	let runLog: RouteReport[] = [];
	// Where no report of the model arrived in the period's run: "none reported", and the route's configured upstreams
	// stand in, read now.
	const standIn = (model: { provider: string; id: string }): string => {
		const upstreams = data.upstreams[model.provider]?.[model.id]?.upstreams;
		return upstreams ? canonical({ provider: model.provider, model: model.id, upstreams }) : "none reported";
	};
	// What serves a taken period's model now: the latest report of it since the period's request was sent, else the
	// stand-in.
	const reportSince = (model: { provider: string; id: string }, since: number): RouteReport | undefined => {
		const report = reports.get(`${model.provider}/${model.id}`);
		return report && report.seq > since ? report : undefined;
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
		// Entries a gateway named need no download: their values came with the routes.
		const lookups = lookupsFor(model, otherwise ? { upstreams: otherwise } : access);
		const named = lookups.some((one) => one.entry !== undefined);
		const found = config.modelData && (fetched || named) ? factsOf(model, lookups) : undefined;
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
		// The price of what answered where the gateway named it (`served`), else Pi's own.
		const rates = hasPrices(served) ? priceAt(served.cost, ctx.getContextUsage()?.tokens ?? undefined) : undefined;
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
			if (found && found.refs.length === 0) {
				if (found.named) dataView.noData = found.named.entries;
				else dataView.noEntry = true;
			}
			if (otherwise) dataView.served = servedView(otherwise);
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
		// From here models.json has the new values (where any changed): a failure says how far they got.
		const after = (stage: DataStage, step: () => Promise<void> | void) =>
			Promise.resolve()
				.then(step)
				.catch((error: unknown) => {
					throw new DataNotApplied(plan.changed.length > 0 ? stage : "models.json unchanged", error);
				});
		await after("written, not loaded", async () => {
			data = { ...data, written: plan.written };
			saveStore(data);
			if (plan.changed.length > 0) await registry.refresh({ providers: [...new Set(plan.changed.map((one) => one.provider))], allowNetwork: false });
		});
		if (plan.changed.length === 0) return 0;
		// The session holds the model as it was; selecting it again picks up the new values. setModel resets the
		// thinking level and makes the extension forget the last request, so it waits for an idle moment.
		await after("loaded, not reselected", async () => {
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
		});
		return plan.changed.length;
	};

	// Which providers.dev providers describe the models pi can use right now.
	const neededProviders = (ctx: ExtensionContext): string[] => {
		const needed = new Set<string>();
		const accessOf = accessReader(ctx);
		// An entry a gateway named is not fetched: its values came with the routes.
		const add = (lookups: Lookup[]) => {
			for (const lookup of lookups) if (lookup.entry === undefined) needed.add(lookup.provider);
		};
		for (const model of ctx.modelRegistry.getAvailable()) {
			const access = accessOf(model);
			add(lookupsFor(model, access));
			// Whatever a proxy may fall back to, so its values are at hand when it answers.
			for (const upstream of data.upstreams[model.provider]?.[model.id]?.fallbacks ?? []) add(lookupsFor(model, { upstreams: [upstream] }));
		}
		return [...needed].sort();
	};

	const refreshData = (ctx: ExtensionContext, force: boolean): Promise<DataSummary> =>
		(dataRefresh ??= (async () => {
			const dataset = await fetchDataset(neededProviders(ctx), data, httpFetch, { force });
			data = { ...data, providers: dataset.providers, datasetVersion: dataset.datasetVersion, reading: DATA_READING, checkedAt: Date.now() };
			// From here the new data is in use in this window: a failure says what became of it.
			try {
				saveStore(data);
			} catch (error) {
				throw new DataNotApplied("not saved", error);
			}
			try {
				return { models: await applyData(ctx), downloaded: dataset.downloaded };
			} catch (error) {
				throw new DataNotApplied("models.json unchanged", error);
			}
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
				const changed = summary.models > 0 ? `${summary.models} model${summary.models === 1 ? "" : "s"} updated in ${modelsPathLabel()}` : `no model's values changed in ${modelsPathLabel()}`;
				const found = ctx.model ? foundFor(ctx, ctx.model) : undefined;
				const current = found ? `\nThis model: ${found.refs.length === 0 ? `no providers.dev entry found for it, so Pi's own values stay in use` : describeFound(found)}` : "";
				ctx.ui.notify(`Model data from ${DATA_SOURCE}: ${changed}${announce ? current : ""}`, "info");
			});
		} catch (error) {
			dataError = error instanceof Error ? error.message : String(error);
			const text =
				!(error instanceof DataNotApplied)
					? `pi-cache-keeper could not fetch the model data from providers.dev: ${dataError}. The data fetched before stays in use; /cache-keeper-refresh tries again.`
					: error.stage === "not saved"
						? `pi-cache-keeper fetched the model data from providers.dev but could not save it: ${dataError}. This window's footer and /cache-keeper use the new data until it ends; ${modelsPathLabel()} was not changed. /cache-keeper-refresh tries again.`
						: error.stage === "models.json unchanged"
							? `pi-cache-keeper fetched and saved the model data from providers.dev but could not put it into ${modelsPathLabel()}: ${dataError}. ${modelsPathLabel()} keeps the values it had; the footer and /cache-keeper use the new data. /cache-keeper-refresh tries again.`
							: error.stage === "written, not loaded"
								? `pi-cache-keeper wrote the new model data into ${modelsPathLabel()}, but Pi has not loaded it: ${dataError}. Pi uses the new values when it next reloads its models (at the latest at its next start); the footer and /cache-keeper use the new data now.`
								: `pi-cache-keeper wrote the new model data into ${modelsPathLabel()} and Pi loaded it, but selecting the model in use again failed: ${dataError}. It takes the new values when you select it again, or at Pi's next start; the footer and /cache-keeper use the new data now.`;
			ifSessionAlive(() => {
				trace(ctx, { event: "data", action: "failed", reason: dataError });
				showData(ctx);
				if (ctx.hasUI && announce) ctx.ui.notify(text, "warning");
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
			else if (data.checkedAt !== undefined || data.gateway !== undefined) void applyData(ctx).then(() => ifSessionAlive(() => showData(ctx)), () => {});
		});
	};

	// At the start of an interactive session: ask providers.dev again when the saved data is a day old, was read by an
	// earlier version (DATA_READING), or when pi can now use a provider it has no data for. Never waited for, and never
	// in PI_OFFLINE mode.
	const refreshDataIfDue = (ctx: ExtensionContext) => {
		// Turned off by hand in settings.json: take this extension's values out of models.json, as the menu does.
		// The footer then shows Pi's own values again.
		if (!config.modelData && Object.keys(data.written).length > 0) void applyData(ctx).then(() => ifSessionAlive(() => showData(ctx)), () => {});
		if (!config.modelData || !ctx.hasUI || process.env.PI_OFFLINE) return;
		const due = data.checkedAt === undefined || Date.now() - data.checkedAt > DATA_MAX_AGE_MS || data.reading !== DATA_READING || neededProviders(ctx).some((provider) => data.providers[provider] === undefined);
		if (due) void refreshAndReport(ctx, false, false);
	};

	// `timer` (the model and lifetime) is logged with keep-warm on; with it off the records are as they were.
	// "postponed" when only a passing reason stood in the way (Pi busy or a message queued), so the countdown tries again
	// on its next tick; "skipped" when a lasting one did, which spends the try for this expiry. `traced` holds the reasons
	// this countdown has already written to the trace, each written once. `expiresAt` is the expiry tried for: a failed
	// compaction starts the countdown again with that expiry spent, not whatever expiry is read by then.
	const compactBeforeExpiry = (
		ctx: ExtensionContext,
		remainingMs: number,
		expiresAt: number,
		traced: Set<string>,
		timer: TimerContext = {},
	): "compacting" | "postponed" | "skipped" => {
		if (!inEffect().compactBeforeExpiry) return "skipped";
		const secondsLeft = Math.ceil(remainingMs / 1000);
		const contextTokens = ctx.getContextUsage()?.tokens ?? undefined;
		const skip = (reason: string, outcome: "postponed" | "skipped" = "skipped") => {
			if (!traced.has(reason)) trace(ctx, { event: "expiry", action: "skip", reason, secondsLeft, contextTokens, ...timer });
			traced.add(reason);
			return outcome;
		};
		let compactionOn: boolean;
		try {
			compactionOn = autoCompactionEnabled(ctx.isProjectTrusted() ? ctx.cwd : undefined);
		} catch (error) {
			return skip(`Pi's settings could not be read: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!compactionOn) return skip("automatic compaction is off in Pi's settings");
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return skip("Pi is busy or has queued messages", "postponed");
		if (contextTokens === undefined) return skip("the context size is unknown");
		const { minContextTokens } = inEffect();
		if (contextTokens < minContextTokens) {
			return skip(`the context holds ${formatTokens(contextTokens)} tokens, under minContextTokens (${formatTokens(minContextTokens)})`);
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
					if (ctx.isIdle()) startTimer(ctx, expiresAt);
				});
			},
		});
		return "compacting";
	};

	// After a turn, compacts once the context passes compactAtPercent of the window or the compactAtTokens cap,
	// whichever comes first, so a summary still fits beside it
	// and the cache the turn just wrote is warm. Returns whether a compaction started.
	const compactWhenFull = (ctx: ExtensionContext): boolean => {
		// In print and JSON mode nothing follows a settled run: the process is exiting, so a compaction started here is
		// cut off before its request is sent. There, Pi's own between-turn check (compaction.reserveTokens) starts
		// compaction during the run, and session_before_compact still writes that summary from the cache.
		if (!ctx.hasUI) return false;
		const { compactAtPercent, compactAtTokens } = inEffect();
		// The mark in effect: a compaction that left the context past it is not tried again until it changes.
		const mark = `${compactAtPercent}:${compactAtTokens}`;
		const threshold = ctx.model ? fullThreshold(ctx.model, compactAtPercent, compactAtTokens) : undefined;
		const contextTokens = ctx.getContextUsage()?.tokens ?? undefined;
		if (threshold === undefined || contextTokens === undefined || contextTokens < threshold) {
			lastFullSkip = undefined;
			fullStuck = undefined;
			return false;
		}
		const cap = compactAtTokens > 0 && threshold === compactAtTokens ? compactAtTokens : undefined;
		const base = { contextTokens, threshold, percent: compactAtPercent, ...(cap === undefined ? {} : { tokens: cap }) };
		const skip = (reason: string) => {
			if (reason !== lastFullSkip) trace(ctx, { event: "full", action: "skip", reason, ...base });
			lastFullSkip = reason;
			return false;
		};
		if (fullStuck === mark) return skip("the last compaction left the context past the mark (raise compactAtPercent or compactAtTokens, or keep fewer recent tokens)");
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
			const past = cap === undefined ? `${compactAtPercent}% of the model's window` : `your ${formatTokens(cap)}-token cap`;
			ctx.ui.notify(`The context holds ${formatTokens(contextTokens)} tokens, past ${past}. Compacting now, while the cache is warm.`, "info");
		}
		ctx.compact({
			onComplete: () => {
				ownTrigger = undefined;
				ifSessionAlive(() => {
					const after = ctx.getContextUsage()?.tokens;
					fullStuck = after !== undefined && after !== null && after >= threshold ? mark : undefined;
				});
			},
			onError: () => {
				ownTrigger = undefined;
				fullStuck = mark;
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
			: `refreshing has cost ${formatUsd(spending.spent)} since the last answer, ${formatUsd(spending.spent) === formatUsd(budget.missCost) ? "as much as" : "more than"} the ${formatUsd(budget.missCost)} one cache miss costs`;
	};
	const limitReason = () => `the cache lasts to the end of the ${keepWarmLabel(warmMinutes())} limit after Pi went idle`;

	// Evidence against a taken period's lifetime, or its request let go (warm-period.ts's `onAgainst`): the extension's
	// period ends its warming ("unable") and is Pi's from then on; one whose warming ended on its time limit or as
	// "unable" is Pi's; one ended for good (budget, a miss, an unreported or failed refresh) stays as it is. Returns the
	// fields of the record that says warming ended, once.
	const changeHands = (p: WarmPeriod, against: { reason: string; label: string }, why: "evidence" | "let go"): Handed | Record<string, never> => {
		const what = onAgainst(warmerOf(p), p.warm);
		if (what === "stays") return {};
		const ended = what === "end and hand over" ? endWarm(p, "unable", against.reason) : {};
		p.notOwned = against.reason;
		p.notOwnedLabel = against.label;
		p.handedOver = why;
		return { ...ended, reason: against.reason, handedOver: why };
	};
	// The same, with the record of the end (a skip, at the expiry read), unless the caller takes it (`taken`).
	const handTo = (
		ctx: ExtensionContext,
		p: WarmPeriod,
		against: { reason: string; label: string },
		taken?: (handed: Handed) => void,
		view?: CacheView,
		why: "evidence" | "let go" = "evidence",
	) => {
		const changed = changeHands(p, against, why);
		if (!("handedOver" in changed)) return;
		const handed = changed as Handed;
		if (taken) return taken(handed);
		trace(ctx, { ...warmBase(ctx, p, view?.sendBy ?? Date.now(), p.logged ?? {}), action: "skip", ...handed, budget: budgetRecord(p as WarmPeriod & { budget: WarmBudget }) });
	};

	// The only place a period becomes stopped: where the /cache-keeper-stop record in place is not the one the period's
	// window had seen when it started (stop-record.ts). Nothing while there is no period, a run is going on, or it is
	// already stopped; an unreadable record stops nothing here (the last gate refuses on it). A period the extension took
	// ends its warming, logged once; then the footer.
	// `reading`: a reading the caller has just made (the last gate), so one reading decides both whether the record can be
	// read and whether it stops the period.
	const obeyStop = (ctx: ExtensionContext, fresh = false, reading?: StopRead) => {
		const p = period;
		if (!p || running || p.stopped) return;
		const record = reading !== undefined ? reading : stopRecord(fresh);
		if (!record || "unreadable" in record || !covers(record, p.seen)) return;
		p.stopped = { id: record.id, at: record.at };
		let amounts: string | undefined;
		if (p.taken && p.budget) {
			const ended = endWarm(p, "stopped", `given at ${hhmm(record.at)}`);
			if ("stop" in ended) {
				const sendBy = look(ctx).sendBy;
				trace(ctx, { ...warmBase(ctx, p, sendBy ?? Date.now(), p.fixed ? { model: p.fixed.model } : {}), action: "skip", ...ended, budget: budgetRecord({ ...p, budget: p.budget }) });
			}
			amounts = spendingText(p.budget, p.spending);
		}
		renderFooter(ctx);
		// Said once per stop and session, when the window learns of it: not again after /reload, nor for a later period that
		// starts stopped. The window that gave the command has said it already.
		if (ctx.hasUI && firstSaid(ctx.sessionManager.getSessionId(), record.id)) {
			say(ctx, { level: "info", text: `Warming is stopped in this window until your next message: /cache-keeper-stop was given at ${hhmm(record.at)}.${amounts ? ` This idle period's refreshes: ${amounts}.` : ""}` });
		}
	};

	// A period left to Pi's own warming from its start, with keep-warm on: said when its reason is not the one this instance
	// last said for the model, so once for a session that stays as it is; again after a period the extension took. Not
	// where the footer says nothing either (no label: no answer has used the cache yet), nor for a stopped period.
	let lastLeft: string | undefined;
	const noteLeft = (ctx: ExtensionContext) => {
		const p = period;
		if (!p) return;
		if (p.taken) {
			lastLeft = undefined;
			return;
		}
		if (p.stopped || !p.onAtStart || !p.notOwnedLabel || p.notOwned === undefined) return;
		const key = `${p.model} ${p.notOwnedLabel}`;
		if (key === lastLeft) return;
		lastLeft = key;
		const sendBy = look(ctx).sendBy;
		trace(ctx, { event: "warm", action: "left", reason: p.notOwned, secondsLeft: sendBy === undefined ? 0 : Math.ceil((sendBy - Date.now()) / 1000), ...(p.model ? { model: p.model } : {}) });
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
	type GateVerdict = { pass: true; sendBy: number } | { hold: "cancelled" | "busy" | "late" | "settling" | "out"; reason: string } | { refuse: string; ended?: Handed; stop?: WarmStop };
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
		// A /cache-keeper-stop, read afresh once: that one reading decides both conditions. Unreadable never lets a refresh
		// out; a stop it shows stops the period, which the next line refuses.
		const stop = stopRecord(true);
		if (stop && "unreadable" in stop) return { refuse: "the stop record could not be read" };
		obeyStop(ctx, false, stop);
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
		let ended: Handed | undefined;
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
		// The time limit in effect now (the session's own, or the default as saved now): a cache that lasts to its end is not
		// refreshed, also when the limit was shortened while this refresh was being prepared.
		if (!wantsWarm(view.sendBy, p.idleSince, setting.minutes)) return { refuse: limitReason(), stop: "limit" };
		if (running || !ctx.isIdle() || ctx.hasPendingMessages()) return { hold: "busy", reason: "Pi is busy or has queued messages" };
		// The last safe moment, from the expiry read here: half the warm lead before it.
		const lastSafe = view.sendBy - Math.floor(warmLeadMs(view.lifetime.ms, EXPIRY_LEAD_MS) / 2);
		if (Date.now() > lastSafe) return { hold: "late", reason: "the cache was about to expire before the refresh went out" };
		if (!payload) return { refuse: unbuilt ?? "the refresh payload could not be built" };
		const cap = limitWithinCap(api, payload);
		if ("reason" in cap) return { refuse: cap.reason };
		return { pass: true, sendBy: view.sendBy };
	};
	// The check at the send itself: called by the refresh's transport (`fetch`) right before it hands the request on, with
	// no wait between. Keep-warm still on, and the expiry the last gate read still under the time limit in effect, both
	// read afresh (the session's own value, else the default as saved now). A change saved at the very instant the
	// request leaves applies from the next refresh.
	const sendCheck = (p: WarmPeriod, sendBy: number): { refuse: string; stop?: WarmStop } | undefined => {
		const setting = keepWarmSetting(true);
		if (!setting) return { refuse: "the settings could not be read" };
		if (setting.minutes <= 0) return { refuse: "keep-warm was turned off" };
		if (!wantsWarm(sendBy, p.idleSince, setting.minutes)) return { refuse: limitReason(), stop: "limit" };
		return undefined;
	};

	// Keep-warm now reads off (in this window or another) in a period that started while it read on and was kept warm by
	// the extension: warming ends there, said once. Pi's own warming may already have been stopped for the period.
	const noteSwitchOff = (ctx: ExtensionContext, expiresAt: number, timer: TimerContext) => {
		const p = period;
		if (!p || !p.taken || p.handedOver || !p.budget || p.ended || running) return;
		const budget = p.budget;
		const reason = keepWarmSetting() ? SWITCHED_OFF : "the settings could not be read";
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
			trace(ctx, { ...base, action: "skip", hold: "late", reason: "too late: less than half the warm lead is left before the cache expires, so a refresh would likely arrive after it" });
			return;
		}
		if (!ctx.isIdle() || ctx.hasPendingMessages()) {
			if (p.busyFor !== expiresAt) trace(ctx, { ...base, action: "skip", hold: "busy", reason: "Pi is busy or has queued messages; tried again until the last safe moment" });
			p.busyFor = expiresAt;
			return;
		}
		// An earlier refresh of this model, from any session of this process, is still on its way: held (the last gate
		// checks it again just before sending).
		if (unsettled(p.fixed.model)) {
			if (p.busyFor !== expiresAt) trace(ctx, { ...base, action: "skip", hold: "settling", reason: SETTLING_REASON });
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
		let refusedEnded: Handed | undefined;
		// How warming ends where it was refused for a reason of its own (the time limit).
		let refusedStop: WarmStop | undefined;
		// Its number in the period, once it leaves.
		let refreshNo = 0;

		// Set once the last gate passed: the expiry it read, for the check at the send, made once.
		let passedFor: number | undefined;
		let checkedAtSend = false;
		const controller = new AbortController();
		warming = controller;
		// Its entry among the model's refreshes on their way, once it goes out (see REFRESH_HOLD_MAX_MS).
		const refreshId = ++refreshIds;
		const open = misses.inFlight.get(p.fixed.model) ?? new Map<number, number>();
		const started = Date.now();
		// The level the cached request was sent with, as its payload shows it.
		const thinkingLevel = payloadThinking(request.model.api, sent);
		// It goes out once the last gate passed: reserved at the larger of its expected cost and what the last refresh really
		// cost. `takeBack` undoes it where the check at the send stops it.
		let leftFrom: { before: WarmPeriod["warm"]; after: WarmPeriod["warm"] } | undefined;
		const goesOut = () => {
			out = true;
			// The moment it leaves is the one its hit, if it reports one, counts the period's expiry from.
			const before = p.warm;
			p.warm = leave(p.warm, refreshId, Date.now());
			leftFrom = { before, after: p.warm };
			open.set(refreshId, Date.now());
			misses.inFlight.set(p.fixed.model, open);
			reserved = reserveFor(budget, spending);
			spending.spent += reserved;
			spending.refreshes += 1;
			refreshNo = spending.refreshes;
		};
		const takeBack = () => {
			out = false;
			if (leftFrom && p.warm === leftFrom.after) p.warm = leftFrom.before;
			open.delete(refreshId);
			if (open.size === 0 && misses.inFlight.get(p.fixed.model) === open) misses.inFlight.delete(p.fixed.model);
			spending.spent -= reserved;
			spending.refreshes -= 1;
			reserved = 0;
			refreshNo = 0;
		};
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
								refusedStop = verdict.stop;
								throw new Error(verdict.refuse);
							}
							// The adapter sends the request after this returns: the check at the send is in `fetch`.
							passedFor = verdict.sendBy;
							goesOut();
							return payload;
						},
						// The refresh's transport: the check at the send, then, with nothing awaited in between, the request leaves.
						fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
							if (passedFor !== undefined && out && !checkedAtSend) {
								checkedAtSend = true;
								let last: ReturnType<typeof sendCheck>;
								try {
									last = sendCheck(p, passedFor);
								} catch {
									last = { refuse: "the session ended before the refresh went out" };
								}
								if (last) {
									takeBack();
									refused = last.refuse;
									refusedStop = last.stop;
									return Promise.reject(new Error(last.refuse));
								}
							}
							return globalThis.fetch(input, init);
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
			let ended: ReturnType<typeof endWarm> | Partial<Handed> | undefined;
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
			} else if (refused) ended = refusedEnded ?? endWarm(p, refusedStop ?? "unable", refused);
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
			// What the refresh's records carry of it: its number, and what its usage showed.
			const sentAs = out ? { refresh: refreshNo, ...(verdict ? { verdict } : {}) } : {};
			// The model left to Pi after two refreshes in a row without a hit: said after the refresh's own line.
			const sayFellBack = () => {
				if (fellBack) {
					say(ctx, {
						level: "warning",
						text: `Two refreshes in a row without a hit for ${p.fixed.model} (${withoutHit(misses.fallbackKinds.get(p.fixed.model))}), so pi-cache-keeper stopped keeping it warm; Pi's own warming takes over. /cache-keeper-warm starts it again.`,
					});
				}
			};
			// A real request started (or the session moved on); it refreshes the cache itself. What went out stays counted.
			// If that run sent nothing, the refresh for this expiry is tried again, as for any passing hold-up.
			if (aborted) {
				if (!out) return;
				ifSessionAlive(() => {
					trace(ctx, { ...base, action: "cancelled", seconds, ...ended, reason: "a new request or a change of session cancelled it", usage, budget: budgetRecord(p), ...fallback, ...sentAs });
					sayFellBack();
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
					if (p.busyFor !== expiresAt) trace(ctx, { ...base, action: "skip", seconds, hold: "settling", reason: SETTLING_REASON });
					p.busyFor = expiresAt;
				} else if (held) {
					// Tried again on the next ticks, as any passing hold-up.
					if (p.busyFor !== expiresAt) trace(ctx, { ...base, action: "skip", seconds, hold: "busy", reason: "Pi got busy or a message was queued while the refresh was being prepared, so it was withheld; tried again until the last safe moment" });
					p.busyFor = expiresAt;
				} else if (refused) {
					// Withheld for good; warming ends with the reason where it has not ended yet.
					trace(ctx, { ...base, action: "skip", seconds, ...ended, reason: refused, budget: budgetRecord(p) });
				} else if (late) {
					trace(ctx, { ...base, action: "skip", seconds, hold: "late", reason: "too late: the cache was about to expire before the refresh went out, so it was not sent" });
				} else if (failed) {
					// Said by its record: a hit reported before the failure kept the cache warm, and says so.
					trace(ctx, { ...base, action: "failed", seconds, ...ended, reason: failure, usage, budget: budgetRecord(p), ...fallback, ...sentAs });
					sayFellBack();
				} else {
					// The time limit, from the expiry just read.
					const until = after?.sendBy;
					const limit = !ended && until !== undefined && !wantsWarm(until, p.idleSince, warmMinutes()) ? endWarm(p, "limit", limitReason()) : undefined;
					trace(ctx, { ...base, action: verdict === "miss" ? "missed" : "warm", seconds, ...(ended ?? limit), usage, budget: budgetRecord(p), ...fallback, ...sentAs });
					sayFellBack();
				}
				if (ctx.isIdle()) startTimer(ctx);
			});
		})();
	};

	// The countdown. It takes the cache's reading as it is. A taken period's reading picks the branch (`regime`): the
	// period's, whoever warms it; otherwise exactly as with keep-warm off. Where a taken period's expiry has passed or is
	// unknown (its route changed, or its lifetime can't be read any more), nothing is refreshed or compacted, and the timer
	// goes on reading the cache, so that a change of regime (keep-warm switched off or on, here or in another window) is
	// seen: the countdown then starts again from that reading. Where Pi warms such a period and nothing seen says its
	// cache is gone yet (`goneBy`), the countdown shows that, for display only: nothing is sent on it.
	// `triedFor`: the expiry whose try to compact before it is already spent (a failed compaction's); any other expiry the
	// countdown reads gets its own try. The spent expiries are the window's (`spent`, per answer), so every start of the
	// countdown carries them, whatever starts it (a run that sent nothing, a refresh landing, a change of regime).
	const startTimer = (ctx: ExtensionContext, triedFor?: number) => {
		stopTimer(ctx, false);
		const first = look(ctx);
		if (triedFor !== undefined) spentFor(first.answeredAt).add(triedFor);
		timerRegime = first.regime;
		if (first.regime === "period" && first.lifetime?.ms !== shownLifetimeMs) {
			modelView = ctx.hasUI && ctx.model ? modelViewOf(ctx, ctx.model) : modelView;
		}
		// As with keep-warm off: no expiry, no countdown.
		if (first.regime !== "period" && first.sendBy === undefined) return renderFooter(ctx);
		let view = first;
		let expiresAt: number | undefined = first.sendBy;
		let warmLead = first.lifetime ? warmLeadMs(first.lifetime.ms, EXPIRY_LEAD_MS) : 0;
		const timer: TimerContext = {
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			lifetimeSeconds: first.lifetime && first.lifetime.ms / 1000,
			lifetimeSource: first.lifetime?.source,
		};
		let ticks = 0;
		// One try per expiry, from the expiry read now: when it moves (Pi's own refresh, the period's facts), the new one
		// gets its own. A try postponed by a passing reason is made again on the next tick, while the cache lives.
		const skipsTraced = new Set<string>();
		let warmChecked = false;
		// What the countdown shows: the expiry anything may be sent on, or, where Pi warms the period on a route that has not
		// been seen to change and that has passed, the moment nothing seen says the cache is alive any more.
		const shown = (now: number): number | undefined => {
			const who = warmerOf(period);
			// A stopped period is read as Pi's are: its cache lasts as long as anything seen says, Pi's refreshes before the
			// stop included.
			const pis = who === "Pi" || who === "Pi, handed over" || who === "nobody, stopped";
			if (view.regime === "period" && pis && view.unknown !== "the route changed" && (expiresAt === undefined || expiresAt <= now) && view.goneBy !== undefined && view.goneBy > now) return view.goneBy;
			return expiresAt;
		};
		// Read the cache again; false where the regime changed and the countdown started again.
		const read = (): boolean => {
			view = look(ctx);
			if (view.regime !== timerRegime) {
				startTimer(ctx);
				return false;
			}
			if (view.regime === "period") {
				expiresAt = view.sendBy;
				// A taken period's lead follows the lifetime read now, and so does the lifetime the footer marks in use.
				if (view.lifetime) warmLead = warmLeadMs(view.lifetime.ms, EXPIRY_LEAD_MS);
				if (view.lifetime?.ms !== shownLifetimeMs) showData(ctx);
			} else expiresAt = view.sendBy ?? expiresAt;
			return true;
		};
		const tick = () => {
			obeyStop(ctx);
			const near = (at: number | undefined) => at !== undefined && at - Date.now() <= Math.max(EXPIRY_LEAD_MS, warmLead);
			if ((++ticks % 15 === 0 || near(expiresAt) || near(shown(Date.now()))) && !read()) return;
			const now = Date.now();
			const remaining = expiresAt === undefined ? 0 : expiresAt - now;
			const showing = shown(now);
			const keepWarmOn = warmMinutes() > 0;
			if (keepWarmOn && expiresAt !== undefined && remaining > 0 && !warming) noteLimit(ctx, expiresAt, timer);
			// One of the period's refreshes is out (also after a run that sent nothing cancelled it): wait for it to settle.
			const out = period?.warm.phase === "out";
			if (!keepWarmOn) noteSwitchOff(ctx, expiresAt ?? now, timer);
			countdown = warming ? { state: "refreshing" } : showing !== undefined && showing > now ? { state: "warm", ms: showing - now } : { state: "cold" };
			renderFooter(ctx);
			if (remaining <= 0) {
				// Expired, unknown, or the timer ran this late: nothing is refreshed or compacted from a cache that is gone. As
				// with keep-warm off the countdown stops; a taken period's goes on reading (above).
				if (view.regime !== "period") {
					clearInterval(ticker);
					ticker = undefined;
				}
			} else if (warming) {
				// Wait for the refresh; it restarts the countdown when it lands.
			} else if (!keepWarmOn || view.regime !== "period") {
				// Keep-warm off, or a period the extension did not take: as with keep-warm off.
				if (remaining <= warmLead && !warmChecked) {
					warmChecked = true;
				} else if (expiresAt !== undefined && remaining <= EXPIRY_LEAD_MS && !spentFor(view.answeredAt).has(expiresAt)) {
					// Pi's own refresh may still be in flight; its usage entry moves the expiry when it lands.
					if (piWarmAt !== undefined && Date.now() - piWarmAt < 30_000) return;
					if (compactBeforeExpiry(ctx, remaining, expiresAt, skipsTraced) !== "postponed") spentFor(view.answeredAt).add(expiresAt);
				}
			} else {
				// A taken period, whoever warms it: its refresh where the extension warms it, and compacting before the expiry
				// its own facts give (Pi's refreshes do not move it, so nothing waits for them).
				if (remaining <= warmLead) keepWarm(ctx, timer);
				if (!warming && !out && expiresAt !== undefined && remaining <= EXPIRY_LEAD_MS && !spentFor(view.answeredAt).has(expiresAt)) {
					if (compactBeforeExpiry(ctx, remaining, expiresAt, skipsTraced, timer) !== "postponed") spentFor(view.answeredAt).add(expiresAt);
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
			captured = { transcript, payload, model: ctx.model, at: Date.now(), tier, cache: requestCache(payload), sharedPrefix, sentSeq: ++order };
		}
		return payload === event.payload ? undefined : payload;
	});
	pi.on("message_start", (event, ctx) => {
		const transcript = pendingTranscript;
		pendingTranscript = undefined;
		if (transcript && event.message.role === "assistant" && ctx.model?.api === BRIDGE_API) {
			captured = { transcript, model: ctx.model, at: Date.now(), tier: process.env.PI_CACHE_RETENTION === "long" ? "long" : "short", sentSeq: ++order };
		}
	});
	// Which answer the captured request got, so a keep-warm period knows the request of its real answer.
	pi.on("message_end", (event) => {
		const message = event.message;
		if (message.role !== "assistant" || !captured || captured.answeredAt !== undefined) return;
		if (message.usage.cacheRead + message.usage.cacheWrite <= 0) return;
		captured.answeredAt = message.timestamp;
		captured.answeredSeq = ++order;
		if (message.diagnostics?.some((d) => RESENT_DIAGNOSTICS.has(d.type))) captured.resent = true;
		answerRequest = captured;
	});
	pi.on("session_start", (_event, ctx) => {
		sessionCtx = ctx;
		sessionId = ctx.sessionManager.getSessionId();
		// This session's own settings (a resumed or forked session's latest entry on its branch), before anything reads them.
		readOwn(ctx);
		ownWriter.hasUI = ctx.hasUI;
		lineWriters().set(sessionId, ownWriter);
		// A new session, a reload or a restart starts a new idle period (its state is in memory).
		goIdle(ctx, true);
		obeyStop(ctx, true);
		noteLeft(ctx);
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
		// And of the stop record, before the cache is read, so a stopped period is not handed over at this decision.
		obeyStop(ctx, true);
		// The cache's clock read afresh first (Pi's refreshes since the answer, the route now): evidence against the period
		// changes its hands before Pi is answered.
		const idle = !running && ctx.isIdle();
		const view = idle && p?.taken ? look(ctx) : undefined;
		const who = warmerOf(period);
		const action = answerToPi({ warmer: who, idle, goneBy: view?.goneBy, now: Date.now() });
		if (action && p) {
			const given = p.stopped && `/cache-keeper-stop (given at ${hhmm(p.stopped.at)}) holds until your next message`;
			trace(ctx, {
				...warmBase(ctx, p, view?.sendBy ?? Date.now(), {
					model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
					lifetimeSeconds: view?.lifetime && view.lifetime.ms / 1000,
					lifetimeSource: view?.lifetime?.source,
				}),
				action: "pi-stopped",
				reason: `${
					who === "nobody, stopped" && given
						? given
						: who === "Pi, handed over"
							? "this idle period's cache is gone by everything seen, Pi's own refreshes included, so a refresh would write it again"
							: "this extension keeps this idle period's cache warm"
				} (Pi would have ${event.action === "warm" ? "refreshed" : "stopped"})`,
				// A budget only where the extension took the period.
				...(p.taken && p.budget ? { budget: budgetRecord({ ...p, budget: p.budget }) } : {}),
			});
			return { action };
		}
		if (event.action === "warm") piWarmAt = Date.now();
		return undefined;
	});
	// The user's message (Pi's `input`: typed, over RPC, or sent in the user's name by another extension; idle, steering or
	// a follow-up): the stop record in place now is the one this session has seen. An unreadable one samples nothing. The
	// input goes on unchanged.
	pi.on("input", (_event, ctx) => {
		const record = stopRecord(true);
		if (record === null || !("unreadable" in record)) noteMessage(ctx.sessionManager.getSessionId(), record?.id ?? null);
		return undefined;
	});
	pi.on("agent_start", (_event, ctx) => {
		// A run starts: the reports that come from now on are about its requests.
		runLog = [];
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
		obeyStop(ctx, true);
		noteLeft(ctx);
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
		if (!event) return;
		// With the routes, the figures of a gateway that gives them (told again whenever its list is read again).
		const sameFigures = JSON.stringify(data.gateway?.[event.provider]) === JSON.stringify(event.figures);
		if (sameFigures && JSON.stringify(data.upstreams[event.provider]) === JSON.stringify(event.models)) return;
		const gateway = { ...data.gateway };
		if (event.figures) gateway[event.provider] = event.figures;
		else delete gateway[event.provider];
		data = { ...data, upstreams: { ...data.upstreams, [event.provider]: event.models }, ...(event.figures || data.gateway ? { gateway } : {}) };
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
		// An answer whose route the proxy did not name: the values in the footer are again those of what may serve the model,
		// as before any report; for a period it is a route of its own, unlike any other (below).
		const unnamed = event.upstreams.length === 0;
		answered = unnamed ? undefined : { provider: event.provider, id: event.model, upstreams: event.upstreams };
		// Kept per model, whole, with when it came; and among the current run's reports.
		const key = `${event.provider}/${event.model}`;
		const seq = ++order;
		const report: RouteReport = { at: Date.now(), seq, key, identity: unnamed ? `a route the proxy did not name (#${seq})` : canonical(payload), upstreams: event.upstreams };
		reports.set(key, report);
		runLog.push(report);
		// The period's clock is told the route that served its model, also where nothing reads it before it changes again;
		// a report about another model never touches it.
		const p = period;
		if (p?.clock && p.taken && p.fixed?.model === key) p.clock.served(report.identity);
		if (ctx) ifSessionAlive(() => showData(ctx));
	});
	pi.on("model_select", (_event, ctx) => {
		answered = undefined;
		forget(ctx);
		showData(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		// Another branch may hold other settings of the session's own: the latest entry on the branch now decides, from here
		// on as a change made in the menu would.
		readOwn(ctx);
		forget(ctx);
		startTimer(ctx);
		// The request the footer says was sent is forgotten with the branch.
		showData(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		sessionCtx = undefined;
		if (sessionId !== undefined && lineWriters().get(sessionId) === ownWriter) lineWriters().delete(sessionId);
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
		if (cache.unknown) return { reason: `${EXPIRY_UNKNOWN}: ${cache.unknown}` };
		if (cache.sendBy !== undefined && Date.now() >= cache.sendBy) return { reason: "the prompt cache has expired" };
		return { request, prefix, trailing: trailing.messages, cache };
	};

	// The fallback compaction model named by `ref`, if this session can hand it a summary now (before anything is measured):
	// not the session's own model, listed by Pi, of an API that can take the request, and with credentials.
	const fallbackCandidate = (ctx: ExtensionContext, ref: string): { model: Model<Api> } | { why: string } => {
		const parsed = parseModelRef(ref);
		if (!parsed) return { why: "it is not a model reference" };
		if (ctx.model?.provider === parsed.provider && ctx.model.id === parsed.id) return { why: "it is the session's own model" };
		const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
		if (!model) return { why: "Pi no longer lists it" };
		const unusable = fallbackUnusable(model);
		if (unusable) return { why: unusable };
		if (!ctx.modelRegistry.hasConfiguredAuth(model)) return { why: `Pi has no credentials for ${model.provider}` };
		return { model };
	};

	// What this session would send a fallback model now, in tokens: the context as it stands, as text the way Pi's summarizer
	// writes it (an upper bound: a compaction sends only the part before the messages it keeps). Undefined where the
	// session can't be read.
	const fallbackSessionNeed = (ctx: ExtensionContext): number | undefined => {
		try {
			const messages = ctx.sessionManager.buildSessionProjection().messages;
			return fallbackNeedTokens(fallbackRequestTokens({ messagesToSummarize: messages, turnPrefixMessages: [], isSplitTurn: false, previousSummary: undefined }));
		} catch {
			return undefined;
		}
	};
	// One model as the menu and /cache-keeper show it: its window, its price at the size needed or that it is a
	// subscription, and whether it holds this session now.
	const fallbackChoiceOf = (model: Model<Api>, need: number | undefined, accessOf: (model: Model<Api>) => Access): FallbackChoice => {
		const unusable = fallbackUnusable(model);
		return {
			ref: formatModelRef(model),
			...(model.name ? { name: model.name } : {}),
			...(model.contextWindow > 0 ? { window: model.contextWindow } : {}),
			...(hasPrices(model) ? { price: priceAt(model.cost, need) } : {}),
			subscription: accessVia(accessOf(model)) === "sub",
			// The fit the compaction itself uses (fallbackModelFit), so the two can't disagree.
			...(unusable ? { unusable } : need === undefined ? {} : { fit: fallbackModelFit(model, need).fit }),
		};
	};
	// A pick Pi can't use now: the model is gone, or its credentials are (the setting is kept).
	const fallbackUnavailable = (ctx: ExtensionContext, ref: string): boolean => {
		const parsed = parseModelRef(ref);
		const model = parsed && ctx.modelRegistry.find(parsed.provider, parsed.id);
		return !model || !ctx.modelRegistry.hasConfiguredAuth(model);
	};
	const fallbackNote = (ctx: ExtensionContext): string => {
		const ref = inEffect().fallbackCompactionModel;
		const mark = ownMark("fallbackCompactionModel");
		if (!ref) return `off${mark}: when the cache can't be read, Pi's own compaction writes the summary on this session's model`;
		const candidate = fallbackCandidate(ctx, ref);
		// As Pi's picker names it: "devin/claude-opus-5-5 [provimux]".
		const shown = fallbackModelLabel(ref);
		if ("why" in candidate) return `${shown}${mark} · ${fallbackUnavailable(ctx, ref) ? "not available now" : "can't be used"}: ${candidate.why}`;
		const { model } = candidate;
		// No prediction: whether it writes a summary depends on the part Pi cuts off at that compaction.
		const parts = fallbackModelParts(fallbackChoiceOf(model, undefined, accessReader(ctx)));
		if (!(model.contextWindow > 0)) return `${shown}${mark} · ${parts.join(" · ")} · can't be used: it declares no context window`;
		const never = fallbackModelFit(model, 0).fit;
		if (!never.fits && never.never) return `${shown}${mark} · ${parts.join(" · ")} · can't be used: ${never.why}`;
		return `${shown}${mark} · ${parts.join(" · ")} · whether it writes a summary is decided at each compaction, from the part Pi cuts off`;
	};

	// Why a reply of the fallback compaction model is no summary, or undefined: anything but a normal stop (an error, an abort,
	// the output limit, a tool call, whatever text came before it), or no text once the file lists are taken out.
	const replyFailure = (reply: AssistantMessage): string | undefined => {
		if (reply.stopReason === "toolUse" || reply.content.some((block) => block.type === "toolCall")) return "the model called a tool instead of writing the summary";
		if (reply.stopReason === "length") return "the summary hit the output limit";
		if (reply.stopReason === "aborted") return `its request ended early (aborted)${reply.errorMessage ? `: ${reply.errorMessage}` : ""}`;
		if (reply.stopReason === "error") return `its request failed: ${reply.errorMessage ?? "unknown error"}`;
		if (reply.stopReason !== "stop") return `its request ended with ${reply.stopReason}`;
		if (!summaryBody(contentText(reply.content))) return "it returned no summary text";
		return undefined;
	};

	// The summary by the fallback compaction model, where the cached path can't write it: Pi's own compact() with the picked
	// model, beside the session (its model and thinking level are not touched). Nothing returned is Pi's own compaction; a
	// cancel is only for the user's abort. `base` is the compaction's record with the cached path's reason.
	const fallbackSummary = async (ctx: ExtensionContext, event: SessionBeforeCompactEvent, base: CompactTrace) => {
		const ref = inEffect().fallbackCompactionModel;
		if (!ref) {
			decision = trace(ctx, { ...base, outcome: "fallback" });
			return undefined;
		}
		const cold: ColdTrace = { model: ref };
		const skip = (why: string) => {
			cold.skipped = why;
			decision = trace(ctx, { ...base, outcome: "fallback", cold });
			return undefined;
		};
		const cancel = () => {
			cold.skipped = COMPACTION_ABORTED;
			decision = trace(ctx, { ...base, outcome: "cancelled", reason: COMPACTION_ABORTED, cold });
			return { cancel: true };
		};
		const { preparation, signal } = event;
		if (signal.aborted) return cancel();
		const candidate = fallbackCandidate(ctx, ref);
		if ("why" in candidate) return skip(candidate.why);
		const { model } = candidate;
		cold.via = accessVia(accessReader(ctx)(model));
		cold.needTokens = fallbackNeedTokens(fallbackRequestTokens(preparation, event.customInstructions));
		if (model.contextWindow > 0) cold.window = model.contextWindow;
		// The fit the menu shows (fallbackModelFit): the output cap is the one the fit assumed, passed with every request, less
		// what the lowest thinking level adds.
		const { fit, thinking } = fallbackModelFit(model, cold.needTokens);
		cold.thinking = thinking;
		if (!fit.fits) return skip(fit.why);
		cold.maxTokens = fit.maxTokens;
		// Pi's credentials at request time, through the registry. Each reply is checked before Pi's summarizer sees it: one
		// that doesn't end in a normal stop, or holds no summary once the file lists are taken out, is a failure, and nothing
		// more is sent (a split turn's prefix included).
		let failure: string | undefined;
		cold.requests = 0;
		const transport: StreamFn = (target, context, options) => {
			if (signal.aborted) throw new Error(COMPACTION_ABORTED);
			if (failure) throw new Error(failure);
			// Counted once it is really dispatched: its body was built (every adapter of Pi's hands it to onPayload just before
			// sending), or a reply came that a provider wrote (a normal end, or tokens counted). A request that failed before
			// leaving (no credentials at request time, say) is not counted.
			let dispatched = false;
			const sent = () => {
				if (dispatched) return;
				dispatched = true;
				cold.requests = (cold.requests ?? 0) + 1;
			};
			const onPayload = options?.onPayload;
			const stream = ctx.modelRegistry.streamSimple(target, context, {
				...options,
				maxTokens: Math.min(options?.maxTokens ?? Infinity, fit.maxTokens),
				onPayload: (payload, model) => {
					sent();
					return onPayload?.(payload, model);
				},
			});
			const checked = stream.result().then((reply) => {
				const tokens = reply.usage ? reply.usage.input + reply.usage.output + reply.usage.cacheRead + reply.usage.cacheWrite : 0;
				if ((reply.stopReason !== "error" && reply.stopReason !== "aborted") || tokens > 0) sent();
				failure = replyFailure(reply);
				if (failure) throw new Error(failure);
				return reply;
			});
			checked.catch(() => {});
			return { result: () => checked } as unknown as ReturnType<StreamFn>;
		};
		const started = Date.now();
		let result: Awaited<ReturnType<typeof compact>>;
		try {
			// No API key of the extension's own, no headers, no retry policy (one attempt), and no session id: Pi's summarizer
			// gives the request a routing id of its own and asks for no cache.
			result = await compact(preparation, model, undefined, undefined, event.customInstructions, signal, thinking, transport);
		} catch (error) {
			if (signal.aborted) return cancel();
			return skip(failure ?? `its request failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (signal.aborted) return cancel();
		// Checked again on the whole: no summary once the file lists are taken out is no summary.
		const body = summaryBody(result.summary);
		if (!body) return skip("it returned no summary text");
		const checkpoint = checkpointSummary(result.summary, preparation.fileOps, getLatestCompactionEntry(event.branchEntries)?.details);
		const usage: Usage = result.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		cold.response = { seconds: (Date.now() - started) / 1000, usage: traceUsage(usage), summaryChars: body.length };
		decision = trace(ctx, { ...base, outcome: "cold", cold });
		return {
			compaction: {
				summary: checkpoint.summary,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				usage,
				details: { readFiles: checkpoint.readFiles, modifiedFiles: checkpoint.modifiedFiles },
			},
		};
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
		// Where the cached path can't write the summary: before expiry, the compaction is cancelled; else the fallback compaction
		// model writes it where one is set and can, and Pi's own compaction runs where it can't.
		const fallBack = async (reason: string, mismatch?: PrefixMismatch) => {
			const diff = mismatch?.captured === undefined ? undefined : { captured: mismatch.captured, rebuilt: mismatch.rebuilt };
			if (fromExpiry) {
				decision = trace(ctx, { ...record, outcome: "cancelled", reason, mismatch: diff });
				return { cancel: true };
			}
			// An unknown lifetime or expiry is never a reason to use the fallback compaction model: Pi's own compaction runs.
			if (reason.startsWith(EXPIRY_UNKNOWN)) {
				decision = trace(ctx, { ...record, outcome: "fallback", reason, mismatch: diff });
				return undefined;
			}
			return fallbackSummary(ctx, event, { ...record, reason, mismatch: diff });
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
				// A taken period's cache is read on the branch as it is now (a refresh of Pi's recorded during the preparation
				// counts); otherwise on the entries the compaction started with, as with keep-warm off.
				const live = look(ctx, { model: request.model, entries: ctx.sessionManager.getBranch() });
				view = live.regime === "period" ? live : look(ctx, { model: request.model, entries: event.branchEntries });
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
			decision = trace(ctx, { ...record, outcome: "cancelled", reason: COMPACTION_ABORTED });
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
	// `marked`: each value shown says where it comes from, " (this session)" after one of the session's own (/cache-keeper).
	// `blocked`: why this extension's own compactions can't run now (Pi's automatic compaction off), where that is known.
	const fullNote = (model: Model<Api> | undefined, marked = false, blocked?: string): string => {
		const { compactAtPercent: percent, compactAtTokens: cap } = inEffect();
		const m = (name: SessionKey) => (marked ? ownMark(name) : "");
		if (percent === 0 && cap === 0) {
			const mine = marked ? (["compactAtPercent", "compactAtTokens"] as const).filter((name) => own[name] !== undefined) : [];
			const from = mine.length === 2 ? " (this session)" : mine.length === 1 ? ` (${mine[0]} this session's, ${mine[0] === "compactAtPercent" ? "compactAtTokens" : "compactAtPercent"} the default)` : "";
			return `off${from}: this extension doesn't compact as the context fills; Pi's own automatic compaction, where it is on in Pi's settings, starts at its threshold (by default when the window is nearly full), often with too little room left to summarize from the cache`;
		}
		const piOff = blocked ? `; but ${blocked}, so this extension doesn't compact as the context fills either` : "";
		const at = model ? fullThreshold(model, percent, cap) : undefined;
		if (!model) {
			const marks = [percent > 0 ? `at ${percent}%${m("compactAtPercent")} of the window` : "", cap > 0 ? `at the ${formatTokens(cap)}-token cap from your settings${m("compactAtTokens")}` : ""];
			return `${marks.filter(Boolean).join(" or ")}; no model is selected${piOff}`;
		}
		if (at === undefined) return `at ${percent}%${m("compactAtPercent")} of the window, but the current model declares no window, so not on this model${piOff}`;
		const byCap = cap > 0 && at === cap;
		const budget = summaryBudget(model, at);
		const room = budget === undefined ? "" : `, leaving ${formatTokens(budget)} for the summary`;
		const tight = budget !== undefined && budget < MIN_SUMMARY_TOKENS ? `, too little to summarize from the cache: pick a lower ${byCap ? "token cap" : "percentage"} in /cache-keeper-settings` : "";
		const mark = byCap ? `at the ${formatTokens(cap)}-token cap from your settings${m("compactAtTokens")}` : `at ${percent}%${m("compactAtPercent")} of the window: ${formatTokens(at)} of ${formatTokens(model.contextWindow)} tokens`;
		return `${mark} on ${model.provider}/${model.id}${room}${tight}${piOff}`;
	};
	const expiryNote = (marked = false, blocked?: string) => {
		const { compactBeforeExpiry, minContextTokens } = inEffect();
		const m = (name: SessionKey) => (marked ? ownMark(name) : "");
		if (!compactBeforeExpiry) return `off${m("compactBeforeExpiry")}: this extension does not compact an idle session before its cache expires`;
		if (blocked) return `on${m("compactBeforeExpiry")}, but ${blocked}, so this extension does not compact before the cache expires either`;
		return `on${m("compactBeforeExpiry")}, from ${formatTokens(minContextTokens)} tokens of context${m("minContextTokens")}: in the last ${EXPIRY_LEAD_MS / 1000} s before the cache expires, while Pi is idle with no message queued and the cache can be read, it starts a compaction from the still-warm cache; when that succeeds, your next message writes a summary and the recent messages again, not the whole session`;
	};
	// Why this extension's own compactions (when full, before expiry) can't run now: they run only where Pi's automatic
	// compaction is on, read from Pi's settings as the compactions read them.
	const compactionBlocked = (ctx: ExtensionContext): string | undefined => {
		try {
			return autoCompactionEnabled(ctx.isProjectTrusted() ? ctx.cwd : undefined) ? undefined : "Pi's automatic compaction is off in its settings";
		} catch {
			return "Pi's settings could not be read";
		}
	};
	// The retention in force, and what it asks the provider for.
	const retentionNote = (model: Model<Api> | undefined): string => {
		if (model?.api === BRIDGE_API) return "set by Claude Code";
		const retention = process.env.PI_CACHE_RETENTION ?? "short";
		if (retention === "long") return "long: Pi asks for the longer cache where its adapter for the provider can (on Anthropic's API 1 h instead of 5 min; writing it costs more)";
		if (retention === "short") return "short: Pi asks for its default cache (5 min on Anthropic's API)";
		return retention;
	};
	const keepWarmNote = (model: Model<Api> | undefined) => {
		const minutes = warmMinutes(true);
		if (minutes <= 0) return "off: this extension sends no refresh while you are away; Pi's own warming works as usual";
		const p = period;
		const rule = keepWarmRule(minutes, p?.budget ? p.budget.priced : !model || hasPrices(model));
		if (!p || running) return rule;
		const fellBack = fallbackFor(model);
		const line = fellBack && fallbackLine(fellBack.key, fellBack.at);
		// While a stop holds, the rule alone (the `stopped:` line says the rest), unless warming had ended for another reason
		// before it, which is still true.
		if (p.stopped && (!p.ended || p.ended.stop === "stopped")) return line ? `${rule}; ${line}` : rule;
		if (p.notOwned !== undefined) return `${rule}; ${line && p.notOwned === line ? line : `this session is left to Pi's own warming: ${p.notOwned}`}`;
		if (!owns(p)) return line ? `${rule}; ${line}` : rule;
		const window = line ? `; ${line}` : "";
		if (p.ended) return `${rule}; ${endedStatus(p)}, until your next message (${p.ended.reason})${window}`;
		return `${rule}; so far ${spendingText(p.budget, p.spending)}`;
	};

	// What /cache-keeper says of a stop, only where there is something to say: the stop this window obeys, or a record that
	// can't be read.
	const stopNote = (): string | undefined => {
		const read = stopRecord(true);
		if (read && "unreadable" in read) {
			return `the stop record (${stopPathLabel()}) can't be read: ${read.unreadable}; the extension sends no refresh while that lasts, and /cache-keeper-stop writes it again`;
		}
		const p = period;
		if (!p?.stopped || running) return undefined;
		const expiry = inEffect().compactBeforeExpiry ? "; compacting before expiry still runs" : "";
		const amounts = p.taken && p.budget ? `; this idle period's refreshes: ${spendingText(p.budget, p.spending)}` : "";
		return `by /cache-keeper-stop at ${hhmm(p.stopped.at)}, until your next message: nothing is sent to keep this window's cache warm, and Pi's own warming is told to stop when it asks${expiry}${amounts}`;
	};

	const dataNote = (ctx: ExtensionContext): string => {
		if (!config.modelData) return "off";
		const failed = dataError ? `; the last refresh failed: ${dataError}` : "";
		const model = ctx.model;
		const otherwise = servedOtherwise(model);
		// Entries a gateway named (Provimux) have their values from it: nothing to download for them.
		// Values from the gateway: entries it named, one of them at least an entry (null alone gives nothing).
		const fromIt = (lookups: Lookup[]) => allNamed(lookups) && lookups.some((one) => typeof one.entry === "string");
		const ownLookups = model ? lookupsFor(model, accessReader(ctx)(model)) : [];
		const otherLookups = model && otherwise ? lookupsFor(model, { upstreams: otherwise }) : [];
		const ownNamed = fromIt(ownLookups);
		const otherNamed = fromIt(otherLookups);
		const named = allNamed(otherwise ? otherLookups : ownLookups);
		if (data.checkedAt === undefined && !named) return `not fetched yet${failed}; /cache-keeper-refresh fetches it`;
		const own = model ? foundFor(ctx, model) : undefined;
		// "Pi's own values" only where no other route answered: then the footer may show that route's values.
		let found = own ? `${describeFound(own)}${own.refs.length === 0 && !otherwise ? ", so Pi's own values are used" : ""}` : "no model";
		const lastAnswer = answeredFor(model);
		if (model && otherwise) {
			// What answered, and the entries looked up for it where not all of them were found.
			const lookups = lookupsFor(model, { upstreams: otherwise });
			const facts = factsOf(model, lookups);
			// An entry the gateway named is said as it is, not as a lookup.
			const lookedUp = facts.refs.length < lookups.length && !allNamed(lookups) ? `, looked up as ${lookupsText(lookups)}` : "";
			found += `; the last answer came from ${servedText(servedView(otherwise, NOTE_ID_COLUMNS))}${lookedUp}: ${describeFound(facts)}`;
		} else if (model && lastAnswer && lastAnswer.length > 0) {
			// The expected route answered: what it was, each upstream the report names (several: not known which).
			found += `; answered by: ${lastAnswer.map((upstream) => servedText(servedView([upstream], NOTE_ID_COLUMNS))).join(" or ")}`;
		}
		// The gateway's figures are read by the proxy's extension with its model list: its own refresh reads them again, not
		// this extension's. Where both are in the line, each part says which refreshes it.
		const fromGateway = "from Provimux; /provimux-refresh reads them again";
		if (data.checkedAt === undefined) return ownNamed || otherNamed ? `${found} (${fromGateway})` : found;
		if (ownNamed && (!otherwise || otherNamed)) return `${found} (${fromGateway})`;
		const checked = `checked ${formatDuration(Date.now() - data.checkedAt)} ago${failed}; /cache-keeper-refresh fetches it again`;
		if (otherNamed && !ownNamed) return `${found} (the values in use: ${checked}; the last answer's: ${fromGateway})`;
		if (ownNamed && otherwise && !otherNamed) return `${found} (the values in use: ${fromGateway}; the last answer's: ${checked})`;
		return `${found} (${checked})`;
	};

	// A session's own value, as the menu and the transcript say it.
	const valueLabel = (name: SessionKey, value: SessionValue): string => {
		// A model as Pi's picker names it, "devin/claude-opus-5-5 [provimux]"; the value saved stays "provimux/devin/claude-opus-5-5".
		if (name === "fallbackCompactionModel") return value === "" ? "off" : fallbackModelLabel(String(value));
		if (name === "compactAtPercent") return percentLabel(value as number);
		if (name === "compactAtTokens") return capLabel(value as number);
		if (name === "compactBeforeExpiry") return value ? "on" : "off";
		if (name === "minContextTokens") return formatTokens(value as number);
		return keepWarmLabel(value as number);
	};
	// The default as saved now: keep-warm is read afresh (a change in another window holds here too), the others as loaded.
	const defaultOf = (name: SessionKey): SessionValue => defaultsNow()[name];
	const ownKeys = (values: SessionSettings = own) => SESSION_KEYS.filter((name) => values[name] !== undefined);
	// "keepWarmMinutes 4 h (default off), compactAtPercent 80% (default 90%)".
	const describeOwn = (values: SessionSettings, withDefaults: boolean) =>
		ownKeys(values)
			.map((name) => `${name} ${valueLabel(name, values[name] as SessionValue)}${withDefaults ? ` (default ${valueLabel(name, defaultOf(name))})` : ""}`)
			.join(", ");
	// " (this session)" after what one of the session's own values decides.
	const ownMark = (name: SessionKey) => (own[name] !== undefined ? " (this session)" : "");

	// A change of the session's own settings, shown where it was made and again on resume (never sent to the model).
	pi.registerEntryRenderer<{ settings?: unknown }>(SESSION_SETTINGS_TYPE, (entry, _options, theme) => {
		const values = readSessionSettings(entry.data).settings;
		const text = ownKeys(values).length > 0
			? `pi-cache-keeper · this session's own settings: ${describeOwn(values, false)}; every other setting follows the defaults`
			: "pi-cache-keeper · this session follows the defaults again";
		return new Text(theme.fg("dim", text), 1, 0);
	});

	// Outside the TUI: both layers, and what is in effect.
	const settingsListing = (ctx: ExtensionContext): string => {
		const layer = (name: SessionKey) => {
			const mine = own[name];
			const shown = (value: SessionValue) => (value === "" ? '""' : String(value));
			return mine === undefined ? `${shown(defaultOf(name))} [default]` : `${shown(mine)} [this session; default ${shown(defaultOf(name))}]`;
		};
		return [
			`pi-cache-keeper settings: the defaults for all sessions (${SETTINGS_KEY} in ~/.pi/agent/settings.json), and over them this session's own values (saved in the session); /cache-keeper-settings in the TUI changes either`,
			`compactAtPercent: ${layer("compactAtPercent")} · compactAtTokens: ${layer("compactAtTokens")} (${fullNote(ctx.model)})`,
			`compactBeforeExpiry: ${layer("compactBeforeExpiry")} · minContextTokens: ${layer("minContextTokens")}`,
			`keepWarmMinutes: ${layer("keepWarmMinutes")} (${keepWarmNote(ctx.model)})`,
			`fallbackCompactionModel: ${layer("fallbackCompactionModel")} (${fallbackNote(ctx)})`,
			`cacheRetention: ${config.cacheRetention} (all sessions)`,
			`modelData: ${config.modelData} (all sessions) (${config.modelData ? `from providers.dev: ${dataNote(ctx)}` : "off"})`,
			ownKeys().length > 0 ? `This session's own: ${describeOwn(own, true)}; every other setting follows the defaults.` : "This session has no settings of its own: every setting follows the defaults.",
		].join("\n");
	};

	// What follows a change of a setting in effect, whichever layer it was made in.
	const afterChange = (ctx: ExtensionCommandContext, names: string[]) => {
		if (names.includes("keepWarmMinutes")) {
			keepWarmSetting(true);
			showData(ctx);
			// Keep-warm switched on or off changes how a taken period's cache is read: the countdown starts again from
			// that reading (from another window, the countdown sees it when it reads next).
			if (!running && ctx.isIdle() && ctx.model && timerRegime !== undefined && look(ctx).regime !== timerRegime) startTimer(ctx);
		}
	};

	const DEFAULT_SUFFIX = " · default";
	const OWN_SUFFIX = " · this session";
	const SESSION_SCOPE = "this session";
	const DEFAULTS_SCOPE = "defaults for all sessions";

	const openSettings = async (ctx: ExtensionCommandContext) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify(settingsListing(ctx), "info");
			return;
		}
		// The menu opens on this session; the defaults are one Enter away, on the first row.
		let scope: "session" | "defaults" = "session";
		const choicesOf = (name: CycledKey, current: SessionValue): (number | boolean)[] => {
			if (name === "compactBeforeExpiry") return [true, false];
			const offered = { compactAtPercent: COMPACT_AT_PERCENTS, compactAtTokens: COMPACT_AT_TOKEN_CHOICES, minContextTokens: MIN_CONTEXT_CHOICES, keepWarmMinutes: KEEP_WARM_CHOICES }[name];
			return [...new Set([...offered, current as number])].sort((a, b) => a - b);
		};
		const ROWS: { name: CycledKey; label: string; describe: () => string }[] = [
			{
				name: "compactAtPercent",
				label: "Compact when the context is",
				describe: () => `After a turn, once the context fills this share of the model's window, compact from the warm cache so the summary still fits beside it. Now ${fullNote(ctx.model)}.`,
			},
			{
				name: "compactAtTokens",
				label: "Or once it holds",
				describe: () =>
					"Also compact after a turn once the context holds this many tokens, on any model, whichever comes first. Every request reads the whole context from the cache, so a smaller context makes each request cheaper; older detail is summarized sooner.",
			},
			{
				name: "compactBeforeExpiry",
				label: "Compact before the cache expires",
				describe: () => "In the last 20 s before the prompt cache expires, when Pi is idle and its automatic compaction is on, compact from the still-warm cache instead of paying to write the whole session again with your next message.",
			},
			{
				name: "keepWarmMinutes",
				label: "Keep the cache warm when idle",
				describe: () =>
					`Up to this long after Pi goes idle, re-send the last request with a one-token answer shortly before the cache expires, so your next message still reads it cheaply. A refresh that hits reads at least 90% of its prompt from the cache (at about a tenth of the input price on Anthropic). A refresh goes out only while what refreshing has cost so far plus its expected cost stays within one cache miss (writing the context again, less the cached read), so the last one can take the total past it; a model without prices gets at most ${MAX_UNPRICED_REFRESHES} refreshes. While keep-warm is on, this extension is the only thing that keeps an idle cache warm, and Pi's own idle warming is told to stop; Pi still warms during a run. Sessions this extension cannot refresh itself are left to Pi's own warming: no cache lifetime or one under a minute, or a request that cannot be re-sent (Claude through pi-claude-bridge, Claude's budget-based thinking, or an API other than Anthropic Messages, OpenAI Completions and OpenAI Responses, whose answer the extension cannot cap). When warming ends, compact before expiry, where it is on, can compact before the cache expires. /cache-keeper-stop stops it in every window. Now: ${keepWarmNote(ctx.model)}.`,
			},
			{
				name: "minContextTokens",
				label: "Before expiry, only from",
				describe: () => "The smallest context compacted before the cache expires; smaller sessions are cheap to write again, so they are left to cool. Keeping the cache warm doesn't use it: its budget grows and shrinks with the context.",
			},
		];
		// The fallback compaction model's row: Enter opens a list of the models instead of stepping through values.
		const FALLBACK = "fallbackCompactionModel";
		const fallbackText =
			"When the cached path can't write a compaction's summary (the cache is cold, this session's model refuses the summary, or the conversation no longer fits it), this model writes it with Pi's own summarizer, and the session goes on with its own model; where it can't either, Pi's own compaction runs as before. What goes to that model's provider is the part of the conversation being summarized, as Pi's summarizer writes it out: your messages in full, with the full output of shell commands you ran with !; the assistant's answers and its tool calls with their arguments; the first 2,000 characters of each tool result; the previous summary; any /compact instructions.";
		const fallbackValue = (ref: string) => `${valueLabel(FALLBACK, ref)}${ref && fallbackUnavailable(ctx, ref) ? " · not available now" : ""}`;
		const fallbackList = (_current: string, done: (value?: string) => void): Component => {
			// "This session now" is measured once, when the list opens.
			const need = fallbackSessionNeed(ctx);
			const accessOf = accessReader(ctx);
			let models: Model<Api>[] = [];
			try {
				models = ctx.modelRegistry.getAvailable();
			} catch {
				// No models to offer: default and off stay.
			}
			// The session's own model is refused by the compaction (fallbackCandidate), so the list says so too.
			const ownModel = (model: Model<Api>) => ctx.model?.provider === model.provider && ctx.model.id === model.id;
			const choices = orderFallbackChoices(
				models
					.filter((model) => !fallbackUnusable(model))
					.map((model): FallbackChoice => {
						const choice = fallbackChoiceOf(model, need, accessOf);
						if (!ownModel(model)) return choice;
						const { fit: _fit, ...rest } = choice;
						return { ...rest, unusable: "it is the session's own model" };
					}),
			);
			const ownRow = (label: string, value: string): FallbackEntry => ({ value, row: { label }, search: label });
			const entries: FallbackEntry[] = [
				...(scope === "session" ? [ownRow(`default (${valueLabel(FALLBACK, defaultOf(FALLBACK))})`, FALLBACK_DEFAULT_PICK)] : []),
				ownRow("off", ""),
				...choices.map((choice): FallbackEntry => {
					const parsed = parseModelRef(choice.ref) ?? { provider: "", id: choice.ref };
					// Searched as Pi's picker searches: the provider, the id and the name.
					return { value: choice.ref, row: { ref: choice.ref, name: choice.name, rest: fallbackChoiceParts(choice) }, search: modelSearchText({ ...parsed, name: choice.name }) };
				}),
			];
			// The value in effect at this level, marked as Pi marks the current model, and selected when the list opens.
			const current = scope === "session" ? (own[FALLBACK] ?? FALLBACK_DEFAULT_PICK) : (defaultOf(FALLBACK) as string);
			const input = new Input();
			input.focused = true;
			let list: Component & { handleInput: (data: string) => void };
			const filter = () => {
				const query = input.getValue().trim();
				list = fallbackModelList(query ? fuzzyFilter(entries, query, (entry) => entry.search) : entries, current, query !== "", 12, done);
			};
			filter();
			const size = need === undefined ? "its size is unknown" : `about ${formatTokens(need)} tokens as text`;
			const header =
				scope === "session"
					? `When the cache can't be used, compact with, in this session · "holds this session" speaks of this session now (${size})`
					: `When the cache can't be used, compact with, by default · "holds this session" speaks of the session this menu was opened in (${size})`;
			const keys = ["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown", "tui.select.confirm", "tui.select.cancel"] as const;
			return {
				render: (width: number) => [...new Text(header, 0, 0).render(width), ...input.render(width), ...list.render(width), ...new Text("Type to search · Enter picks · Esc goes back", 0, 0).render(width)],
				invalidate: () => {
					input.invalidate();
					list.invalidate();
				},
				handleInput: (data: string) => {
					const bindings = getKeybindings();
					if (keys.some((key) => bindings.matches(data, key))) list.handleInput(data);
					else {
						input.handleInput(data);
						filter();
					}
				},
			};
		};
		const fallbackRow = (): SettingItem => {
			const fallback = defaultOf(FALLBACK) as string;
			const mine = own[FALLBACK];
			if (scope === "defaults") {
				return {
					id: FALLBACK,
					label: FALLBACK_ROW_LABEL,
					currentValue: fallbackValue(fallback),
					description: `${fallbackText}${mine === undefined ? "" : ` This session has its own value (${valueLabel(FALLBACK, mine)}), which wins in it.`}`,
					submenu: fallbackList,
				};
			}
			return {
				id: FALLBACK,
				label: FALLBACK_ROW_LABEL,
				currentValue: mine === undefined ? `${fallbackValue(fallback)}${DEFAULT_SUFFIX}` : `${fallbackValue(mine)}${OWN_SUFFIX}`,
				description: `${fallbackText} ${mine === undefined ? `This session follows the default (${valueLabel(FALLBACK, fallback)}).` : `This session's own value; the default is ${valueLabel(FALLBACK, fallback)}.`}`,
				submenu: fallbackList,
			};
		};
		// After "Or once it holds".
		const withFallbackRow = (rows: SettingItem[]) => {
			const at = rows.findIndex((row) => row.id === "compactAtTokens") + 1;
			return [...rows.slice(0, at), fallbackRow(), ...rows.slice(at)];
		};
		const retentionText = "long asks for the longer cache in interactive sessions (2× the write price on Anthropic and Kimi); short keeps Pi's default. Applies from the next request.";
		const dataText = `Once a day, read each model's input window, cache lifetimes and prices from ${DATA_SOURCE} (a public API: no key, and nothing about your sessions is sent) and put them into ~/.pi/agent/models.json: the window replaces Pi's, lifetimes and prices fill what Pi has none for, and values you set there yourself are never touched. The footer shows the current model's values and marks a guess. off takes these values out again.`;
		const ALL_SESSIONS = "The same for every session (a session can't set its own): a change here changes the default.";
		const globalItems = (marked: boolean): SettingItem[] => [
			{
				id: "cacheRetention",
				label: marked ? "Cache retention · all sessions" : "Cache retention",
				currentValue: config.cacheRetention,
				values: ["short", "long"],
				description: `${retentionText} ${ALL_SESSIONS} It works through the process-wide PI_CACHE_RETENTION.`,
			},
			{
				id: "modelData",
				label: marked ? "Model data · all sessions" : "Model data from providers.dev",
				currentValue: config.modelData ? "on" : "off",
				values: ["on", "off"],
				description: `${dataText} ${ALL_SESSIONS} It writes Pi's models.json, which every session reads.`,
			},
		];
		const scopeItem = (): SettingItem => ({
			id: "scope",
			label: "Editing",
			currentValue: scope === "session" ? SESSION_SCOPE : DEFAULTS_SCOPE,
			values: [SESSION_SCOPE, DEFAULTS_SCOPE],
			description:
				scope === "session"
					? "The warming and compaction values you pick below hold for this session only, saved in it: after a resume, and in a fork made after them. Every value marked default follows the defaults, also when they change later. Enter edits the defaults for all sessions instead."
					: "The defaults every session uses, except where a session set its own value. Saved to cacheKeeper in ~/.pi/agent/settings.json. Enter goes back to editing this session.",
		});
		const sessionItems = (): SettingItem[] => {
			const rows = ROWS.map(({ name, label, describe }): SettingItem => {
				const fallback = defaultOf(name);
				const mine = own[name];
				// Enter steps from the default as it would from that value in the defaults: to the next one up (the other one, for
				// on and off), so raising a value never passes through off on its way.
				const all = choicesOf(name, mine ?? fallback);
				const choices = typeof fallback === "boolean" ? [!fallback, fallback] : [...all.filter((value) => (value as number) > (fallback as number)), ...all.filter((value) => (value as number) <= (fallback as number))];
				const defaultValue = `${valueLabel(name, fallback)}${DEFAULT_SUFFIX}`;
				return {
					id: name,
					label,
					currentValue: mine === undefined ? defaultValue : `${valueLabel(name, mine)}${OWN_SUFFIX}`,
					values: [defaultValue, ...choices.map((value) => `${valueLabel(name, value)}${OWN_SUFFIX}`)],
					description: `${describe()} ${mine === undefined ? `This session follows the default (${valueLabel(name, fallback)}).` : `This session's own value; the default is ${valueLabel(name, fallback)}.`}`,
				};
			});
			const count = ownKeys().length;
			const drop = count > 0 ? `drop ${count} own value${count === 1 ? "" : "s"}` : "nothing to drop";
			return [
				scopeItem(),
				...withFallbackRow(rows),
				{ id: "reset", label: "Back to the defaults", currentValue: drop, values: [drop], description: "Drops this session's own values: every setting follows the defaults again, here and in what you resume or fork from here on." },
				...globalItems(true),
			];
		};
		const defaultItems = (): SettingItem[] => {
			const rows = ROWS.map(({ name, label, describe }): SettingItem => {
				const value = defaultOf(name);
				const mine = own[name];
				return {
					id: name,
					label,
					currentValue: valueLabel(name, value),
					values: choicesOf(name, value).map((choice) => valueLabel(name, choice)),
					description: `${describe()}${mine === undefined ? "" : ` This session has its own value (${valueLabel(name, mine)}), which wins in it.`}`,
				};
			});
			return [scopeItem(), ...withFallbackRow(rows), ...globalItems(false)];
		};
		// The value a row's label stands for.
		const parse = (name: CycledKey, label: string, current: SessionValue) => choicesOf(name, current).find((value) => valueLabel(name, value) === label);

		await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
			const container = new Container();
			let list: SettingsList;
			const header = () =>
				scope === "session"
					? `${theme.fg("accent", theme.bold("pi-cache-keeper"))} ${theme.bold("· editing this session")} ${theme.fg("dim", "· its own values are saved in the session; every other follows the defaults")}`
					: `${theme.fg("accent", theme.bold("pi-cache-keeper"))} ${theme.bold("· editing the defaults for all sessions")} ${theme.fg("dim", `· saved to ${SETTINGS_KEY} in ~/.pi/agent/settings.json`)}`;
			// The session's own values are saved once, when the menu closes, if they changed.
			const close = () => {
				if (!sameSessionSettings(own, ownSaved)) {
					try {
						pi.appendEntry<{ settings: SessionSettings }>(SESSION_SETTINGS_TYPE, { settings: { ...own } });
						ownSaved = { ...own };
					} catch (error) {
						ctx.ui.notify(`pi-cache-keeper could not save this session's settings: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
				}
				done();
			};
			const onChange = (id: string, value: string) => {
				if (id === "scope") {
					scope = value === SESSION_SCOPE ? "session" : "defaults";
					return build(id);
				}
				if (id === "reset") {
					const dropped = ownKeys();
					setOwn({});
					afterChange(ctx, dropped);
					return build(id);
				}
				if (id === FALLBACK) {
					// The list's pick: a model, off (""), or the default (this session drops its own value).
					const picked = value === FALLBACK_DEFAULT_PICK ? undefined : value;
					try {
						if (scope === "session") setOwn(withSessionValue(own, FALLBACK, picked));
						else if (picked !== undefined) {
							config = saveConfig({ fallbackCompactionModel: picked });
							latest = config;
						}
					} catch (error) {
						ctx.ui.notify(`pi-cache-keeper could not set it: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
					return build(id);
				}
				const name = ROWS.find((row) => row.name === id)?.name;
				if (scope === "session" && name) {
					const mine = own[name];
					const picked = value.endsWith(OWN_SUFFIX) ? parse(name, value.slice(0, -OWN_SUFFIX.length), mine ?? defaultOf(name)) : undefined;
					try {
						setOwn(withSessionValue(own, name, picked));
					} catch (error) {
						ctx.ui.notify(`pi-cache-keeper could not set it for this session: ${error instanceof Error ? error.message : String(error)}`, "error");
						return build(id);
					}
					afterChange(ctx, [name]);
					return build(id);
				}
				let patch: Partial<CacheKeeperConfig>;
				if (name === "compactBeforeExpiry") patch = { compactBeforeExpiry: value === "on" };
				else if (name) patch = { [name]: parse(name, value, defaultOf(name)) ?? defaultOf(name) };
				else if (id === "modelData") patch = { modelData: value === "on" };
				else patch = { cacheRetention: value === "long" ? "long" : "short" };
				try {
					config = saveConfig(patch);
					latest = config;
				} catch (error) {
					ctx.ui.notify(`pi-cache-keeper could not save the setting: ${error instanceof Error ? error.message : String(error)}`, "error");
					return build(id);
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
				// A default this session has its own value for changes nothing in effect here.
				if (name && own[name] === undefined) afterChange(ctx, [name]);
				build(id);
			};
			const build = (select?: string) => {
				const items = scope === "session" ? sessionItems() : defaultItems();
				list = new SettingsList(items, items.length + 2, getSettingsListTheme(), onChange, close);
				if (select) list.selectItem(select);
				container.clear();
				container.addChild(new Text(header(), 0, 0));
				container.addChild(new Text("", 0, 0));
				container.addChild(list);
				container.invalidate();
			};
			build();
			return {
				get capturesViewportInput() {
					return list.capturesViewportInput;
				},
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		});
	};

	// The commands take no arguments: one given is said to be ignored, and the command runs as without it.
	const ignoredArgs = (name: string, args: string, ctx: ExtensionContext) => {
		if (args.trim()) ctx.ui.notify(`/${name} takes no arguments, so "${args.trim()}" was ignored.`, "warning");
	};

	pi.registerCommand("cache-keeper-settings", {
		description: "Change when sessions compact, which model summarizes when the cache can't be used, and how long the cache is kept warm, for this session or all",
		handler: async (args, ctx) => {
			ignoredArgs("cache-keeper-settings", args, ctx);
			await openSettings(ctx);
		},
	});

	pi.registerCommand("cache-keeper-refresh", {
		description: "Fetch the prices, input windows and cache lifetimes of your models from providers.dev again, now",
		handler: async (args, ctx) => {
			ignoredArgs("cache-keeper-refresh", args, ctx);
			if (!config.modelData) return ctx.ui.notify("Nothing was fetched: model data from providers.dev is off. Turn it on in /cache-keeper-settings, on the row Model data.", "info");
			await refreshAndReport(ctx, true, true);
		},
	});

	pi.registerCommand("cache-keeper-stop", {
		description: "Stop idle cache warming in every open Pi window that shares this agent folder and runs this version, before a long break; each window warms again after your next message there",
		handler: async (args, ctx) => {
			ignoredArgs("cache-keeper-stop", args, ctx);
			// The window as it was before the command.
			const p = period;
			const busy = running;
			const already = p?.stopped;
			const keeping = p !== undefined && warmerOf(p) === "the extension";
			let record: ReturnType<typeof writeStop>;
			try {
				record = writeStop(Date.now());
			} catch (error) {
				say(ctx, { level: "error", text: `pi-cache-keeper could not write ${stopPathLabel()}: ${error instanceof Error ? error.message : String(error)}. Nothing was stopped.` });
				return;
			}
			// This window says the command's text, not the notice of a stop.
			firstSaid(ctx.sessionManager.getSessionId(), record.id);
			obeyStop(ctx, true);
			const here = busy
				? "This window: a run is going on; the idle period it ends in is stopped too, unless you send it a message first."
				: already
					? `This window: already stopped, since ${hhmm(already.at)}.`
					: keeping && p?.budget
						? `This window: the extension was keeping this idle period warm, and that has ended (${spendingText(p.budget, p.spending)}).`
						: "This window: the extension was not keeping anything warm; Pi's own warming is told to stop the next time it asks.";
			say(ctx, {
				level: "info",
				text: [
					`Warming is stopped in every Pi window that uses ${agentDirLabel()}, until each window's next message.`,
					here,
					'Other windows: each reads the stop before it sends a cache refresh, and its footer says "warming stopped" within about a second where it shows a countdown. How many there are can\'t be known from here, and a window that has not loaded this version (no /reload since the update) doesn\'t read it.',
					"A refresh already on its way is not called back. A stop can't be taken back: a window warms again as usual after the answer to the next message you send it.",
					...(inEffect().compactBeforeExpiry ? ["Compacting before the cache expires still runs where it is on (compactBeforeExpiry); it starts no warming again."] : []),
				].join("\n"),
			});
		},
	});

	pi.registerCommand("cache-keeper-warm", {
		description: "Let pi-cache-keeper warm a model's cache again after it left the model to Pi, when two refreshes in a row did not hit the cache",
		handler: async (args, ctx) => {
			ignoredArgs("cache-keeper-warm", args, ctx);
			obeyStop(ctx, true);
			const fellBack = [...misses.fallback.keys()].sort();
			const counted = [...misses.counts.entries()].filter(([model, count]) => count > 0 && !misses.fallback.has(model)).map(([model]) => model).sort();
			misses.fallback.clear();
			misses.fallbackKinds.clear();
			misses.counts.clear();
			misses.kinds.clear();
			const off = warmMinutes(true) > 0 ? "" : " Keep-warm itself is off (keepWarmMinutes: 0), so this extension keeps nothing warm until you turn it on in /cache-keeper-settings (Keep the cache warm when idle); Pi's own warming is not affected.";
			let text: string;
			if (fellBack.length > 0) {
				const also = counted.length > 0 ? ` The count of refreshes in a row without a hit is set back to zero for ${counted.join(", ")} too.` : "";
				text = `pi-cache-keeper no longer leaves ${fellBack.join(", ")} to Pi's own warming: it can keep it warm again after your next answer, or in this break if its warming had not ended, where the usual conditions allow.${also}${off}`;
			} else if (counted.length > 0) {
				text = `No model had been left to Pi's own warming. The count of refreshes in a row without a hit is set back to zero for ${counted.join(", ")}.${off}`;
			} else text = `Nothing to do: no model had been left to Pi's own warming, and no refresh without a hit was counted.${off}`;
			if (period?.stopped && !running) text += " A /cache-keeper-stop holds in this window until your next message; this command does not lift it.";
			ctx.ui.notify(text, "info");
			renderFooter(ctx);
		},
	});

	pi.registerCommand("cache-keeper", {
		description: "See how long the prompt cache has left where that is known, whether the next compaction can read it, the settings and model data in use, and this session's latest log entries",
		handler: async (args, ctx) => {
			ignoredArgs("cache-keeper", args, ctx);
			obeyStop(ctx, true);
			const entries = ctx.sessionManager.getBranch();
			const model = ctx.model;
			const state = model && look(ctx, { model, entries });
			let cache = "lifetime unknown, so no countdown; this extension neither compacts before expiry nor keeps it warm";
			if (state?.lifetime) {
				let left = state.replied ? "the last request did not use the prompt cache" : "no request since the session started or compacted";
				const now = Date.now();
				const who = warmerOf(period);
				// Where Pi warms a taken period whose route has not been seen to change and whose expiry has passed, its cache lasts
				// as long as anything seen (Pi's own refreshes included) says; nothing is sent on that.
				const piKeeps = state.regime === "period" && (who === "Pi" || who === "Pi, handed over" || who === "nobody, stopped") && state.unknown !== "the route changed" && (state.sendBy === undefined || state.sendBy <= now) && state.goneBy !== undefined && state.goneBy > now;
				if (piKeeps && state.goneBy !== undefined) left = `${formatRemaining(state.goneBy - now)} left by Pi's own warming`;
				else if (state.sendBy !== undefined) left = state.sendBy > now ? `${formatRemaining(state.sendBy - now)} left` : "expired";
				// Where the expiry is unknown, the cache counts as expired, and why.
				else if (state.unknown) left = "expiry not known";
				// The reason in plain words: a route is the account or key that answered.
				const unknown = state.unknown === "the route changed" ? "the route changed (the proxy's report of what answered differs from its report for the answer that wrote this cache, so the next request may not read this cache)" : state.unknown;
				const why = unknown
					? piKeeps
						? `; this extension sends no refresh or summary on it: ${unknown}`
						: `: ${unknown}; this extension counts it as expired and sends no refresh or summary on it`
					: piKeeps
						? "; this extension sends no refresh or summary on it"
						: "";
				// Only where the expiry is known and has passed.
				const cost = !piKeeps && !state.unknown && state.sendBy !== undefined && state.sendBy <= now ? "; your next message pays full price to write it again" : "";
				cache = `${left} (lifetime ${formatDuration(state.lifetime.ms)}, ${state.lifetime.source})${why}${cost}`;
			}
			const check = checkCachedPath(ctx, entries, model);
			const next = "reason" in check
				? inEffect().fallbackCompactionModel && !check.reason.startsWith(EXPIRY_UNKNOWN)
					? `not from the cache, because ${check.reason}; the fallback compaction model (below) is asked to write the summary, else Pi's own compaction runs`
					: `Pi's own compaction, because ${check.reason}`
				: `from the cache, as far as can be told now; last request ${formatDuration(Date.now() - check.request.at)} ago with ${check.request.transcript.length} messages, ${check.trailing.length} since. ${model?.api === BRIDGE_API ? "When it runs, it goes through pi-claude-bridge, where its request can't be checked against your last one." : "When it runs, it checks that its request begins with the same prefix as your last request, so the cache can be read."}`;
			const stopped = stopNote();
			let log: string[];
			try {
				const records = readTraces(ctx.sessionManager.getSessionId(), 12);
				const lines = records.flatMap((record) => {
					const versus = record.event === "compact" ? comparison(record) : undefined;
					return versus ? [describeTrace(record), `         ${versus.text}`] : [describeTrace(record)];
				});
				log = records.length > 0 ? ["This session (its latest 12 entries in the log, at most):", ...lines] : ["Nothing logged for this session yet."];
			} catch (error) {
				log = [`Could not read the log: ${error instanceof Error ? error.message : String(error)}`];
			}
			ctx.ui.notify(
				[
					`pi-cache-keeper · ${model ? `${model.provider}/${model.id}` : "no model"}`,
					`cache: ${cache}`,
					`next compaction: ${next}`,
					`compact when full: ${fullNote(model, true, compactionBlocked(ctx))}`,
					`fallback compaction model (asked to write the summary when the cache can't be used): ${fallbackNote(ctx)}`,
					`keep warm while you are away${ownMark("keepWarmMinutes")}: ${keepWarmNote(model)}`,
					...(stopped ? [`stopped: ${stopped}`] : []),
					`compact before expiry: ${expiryNote(true, compactionBlocked(ctx))}`,
					`cache retention: ${retentionNote(model)}`,
					`model data from providers.dev: ${dataNote(ctx)}`,
					`settings: ${ownKeys().length > 0 ? `this session's own: ${describeOwn(own, true)}; every other follows the defaults` : "the defaults (this session has none of its own)"} · change them with /cache-keeper-settings`,
					`log file: ${TRACE_PATH_LABEL}`,
					"",
					...log,
				].join("\n"),
				"info",
			);
		},
	});
}
