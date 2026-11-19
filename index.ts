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
	formatCacheStatus,
	formatDuration,
	formatRemaining,
	formatTokens,
	readTraces,
	TRACE_PATH_LABEL,
	traceDetails,
	stopLabel,
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
	canReplay,
	formatUsd,
	gateAllows,
	hasPrices,
	keepWarmLabel,
	keepWarmRule,
	MAX_UNPRICED_REFRESHES,
	MIN_WARM_CACHED_SHARE,
	reserveFor,
	spendingLimit,
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
	accessVia,
	formatFieldStates,
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
	type FetchState,
	type Found,
} from "./model-data.ts";

interface CapturedRequest {
	transcript: AgentMessage[];
	payload?: Payload;
	model: Model<Api>;
	at: number;
	/** The timestamp of the answer to this request, once it arrived (message_end). */
	answeredAt?: number;
}

/** A cache lifetime under this cannot carry a refresh: Pi's own warming keeps such a session, if anything does. */
const MIN_OWNED_LIFETIME_MS = 60_000;

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
	/** The request of the period's answer; forgotten with the cached request (model switch, compaction, branch move). */
	request?: CapturedRequest;
	budget?: WarmBudget;
	spending: WarmSpending;
	/** Why keeping warm ended for the rest of the period. */
	ended?: { stop: WarmStop; reason: string };
	/** The expiry the refresh was decided for (sent, or too late), so it is not tried again for it. */
	doneFor?: number;
	/** The expiry for which "Pi is busy" was logged, so a refresh tried on every tick logs it once. */
	busyFor?: number;
}

interface CachedPath {
	request: CapturedRequest;
	prefix?: CachedPrefix;
	trailing: AgentMessage[];
	cache: CacheState;
}

const STATUS_KEY = "cache-keeper";
const DATA_STATUS_KEY = "cache-keeper-data";
const httpFetch: Fetch = (url, init) => fetch(url, init);
const CARD_TYPE = "cache-keeper";
/** The card type pi-cached-compaction wrote; still rendered so cards in older sessions show. */
const LEGACY_CARD_TYPE = "cached-compaction";
const PREFIX_MISMATCH = "pi-cache-keeper: request prefix differs from the cached request";
const BRIDGE_API = "claude-bridge";
const FORK_REQUEST_HEADER = "x-claude-bridge-fork";
const EXPIRY_LEAD_MS = 20_000;
const WARNING_MS = 30_000;
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
	let running = false;
	let warmedAt: number | undefined;
	let warming: AbortController | undefined;
	let piWarmAt: number | undefined;
	// The cache lifetime of a proxy model follows what answered (see servedModel below).
	// With keep-warm on the expiry is counted from the latest real answer, an aborted one that used the cache included.
	const stateOf = (model: Model<Api>, entries: SessionEntry[]) => cacheState(servedModel(model), entries, warmedAt, config.keepWarmMinutes > 0);
	// Why the extension cannot keep a period warm itself, from facts that last for the period; undefined when it can.
	const whyNotOwned = (state: CacheState | undefined): string | undefined => {
		if (state?.answeredAt === undefined) return "no answer has read or written the prompt cache yet";
		if (!state.lifetime) return "the cache lifetime is unknown";
		if (state.lifetime.ms < MIN_OWNED_LIFETIME_MS) return `the cache lifetime (${formatDuration(state.lifetime.ms)}) is under a minute`;
		const request = captured;
		if (!request || request.answeredAt !== state.answeredAt) return "the request of the last answer was not captured";
		if (!request.payload) return `${request.model.api} requests cannot be re-sent`;
		if (!canReplay(request.payload)) return "Claude's budget-based thinking changes the cache key when the answer is capped";
		return undefined;
	};
	// Pi is idle. After a run that brought a new real answer (or at a session's start) a new period starts; after one that
	// sent nothing, the period goes on, with its spending and its time limit.
	const goIdle = (ctx: ExtensionContext, fresh = false) => {
		running = false;
		const state = ctx.model ? stateOf(ctx.model, ctx.sessionManager.getBranch()) : undefined;
		const answeredAt = state?.answeredAt;
		if (!fresh && period && (answeredAt === undefined || answeredAt === period.answeredAt)) return;
		const notOwned = whyNotOwned(state);
		const request = notOwned === undefined ? captured : undefined;
		period = {
			answeredAt,
			idleSince: Date.now(),
			notOwned,
			request,
			budget: request && state?.answerPrompt !== undefined ? warmBudget(request.model, state.answerPrompt) : undefined,
			spending: { spent: 0, refreshes: 0 },
		};
	};
	// The extension keeps this period's cache warm: keep-warm on and the period's facts hold.
	const owns = (p: WarmPeriod | undefined): p is WarmPeriod & { budget: WarmBudget } => config.keepWarmMinutes > 0 && p !== undefined && p.notOwned === undefined && p.budget !== undefined;
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

	const stopTimer = (ctx: ExtensionContext) => {
		clearInterval(ticker);
		ticker = undefined;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	};
	const forget = (ctx: ExtensionContext) => {
		pendingTranscript = undefined;
		captured = undefined;
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

	// The footer: what providers.dev has for the current model. Before any data was fetched it shows only when no fetch
	// is coming (it failed, or PI_OFFLINE), so `sub` / `api` and the tier in use still show and the footer says why.
	const showData = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const model = ctx.model;
		const never = data.checkedAt === undefined;
		const fetch: FetchState | undefined = never ? (dataError !== undefined ? "failed" : process.env.PI_OFFLINE ? "offline" : undefined) : dataError !== undefined ? "stale" : undefined;
		if (!config.modelData || !model || (never && !fetch)) return ctx.ui.setStatus(DATA_STATUS_KEY, undefined);
		const { theme } = ctx.ui;
		const color = (state: string) => (state === "found" ? "success" : state === "missing" ? "dim" : "warning");
		// Claude Code picks the tier for the bridge model.
		const tier = model.api === BRIDGE_API ? undefined : cacheTier(ctx.sessionManager.getBranch(), model);
		const access = accessReader(ctx)(model);
		const otherwise = servedOtherwise(model);
		const served = otherwise ? accessVia({ upstreams: otherwise }) : undefined;
		const lastAnswer = answeredFor(model);
		const via = model.api === BRIDGE_API ? undefined : accessVia(lastAnswer ? { upstreams: lastAnswer } : access);
		ctx.ui.setStatus(
			DATA_STATUS_KEY,
			formatFieldStates(findFacts(lookupsFor(model, access), data.providers), (text, state) => theme.fg(color(state), text), { served, tier, via, fetch }),
		);
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
		if (!config.modelData && Object.keys(data.written).length > 0) void applyData(ctx).catch(() => {});
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
		p.ended && `keep-warm ended (${stopLabel(p.ended.stop, keepWarmLabel(config.keepWarmMinutes))}): ${spendingText(p.budget, p.spending)}`;
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
	const limitReason = () => `the cache lasts to the end of the ${keepWarmLabel(config.keepWarmMinutes)} limit after Pi went idle`;

	// The time limit takes effect: the cache already lasts to `idleSince + keepWarmMinutes` or beyond (the answer's own
	// lifetime covers the window, or Pi's refresh from the run just ended carried it there), so no refresh goes out in
	// this period. Recorded when it happens. A refresh of the extension's that carries the cache there says so itself.
	const noteLimit = (ctx: ExtensionContext, expiresAt: number, timer: TimerContext) => {
		const p = period;
		if (!owns(p) || p.ended || running || wantsWarm(expiresAt, p.idleSince, config.keepWarmMinutes)) return;
		trace(ctx, { ...warmBase(ctx, p, expiresAt, timer), action: "skip", ...endWarm(p, "limit", limitReason()), budget: budgetRecord(p) });
	};

	// Shortly before the cache expires, while Pi is idle in a period the extension owns, inside the keep-warm window and
	// the budget, re-sends the period's request exactly as it was sent with a one-token answer, so the cache entry is
	// read and its lifetime starts again. Called on every tick from `warmLead` before expiry: a refresh held back for a
	// passing reason (Pi busy, a message queued, Pi's own refresh from the run just ended still in flight) is tried again
	// until the last safe moment, half the lead before expiry; a lasting reason ends warming for the period.
	const keepWarm = (ctx: ExtensionContext, expiresAt: number, warmLead: number, timer: TimerContext) => {
		const p = period;
		if (!owns(p) || p.ended || running || p.doneFor === expiresAt || !wantsWarm(expiresAt, p.idleSince, config.keepWarmMinutes)) return;
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

		const controller = new AbortController();
		warming = controller;
		const started = Date.now();
		const thinkingLevel = pi.getThinkingLevel();
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
							// The last moment before the request leaves: past the last safe moment it would write, not read.
							if (Date.now() > lastSafe) {
								late = true;
								throw new Error("the cache was about to expire before the refresh went out");
							}
							const built = warmPayload(params, sent);
							if ("reason" in built) throw new Error(built.reason);
							// It goes out: reserved at the larger of its expected cost and what the last refresh really cost.
							out = true;
							reserved = reserveFor(budget, spending);
							spending.spent += reserved;
							spending.refreshes += 1;
							return built.payload;
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
			// Whatever the outcome: once the period's spending reached its limit, warming ends.
			const reached = () => (out && budgetReached(budget, spending) ? endWarm(p, "budget", budgetReason(p, false)) : undefined);
			// A real request started (or the session moved on); it refreshes the cache itself. What went out stays counted.
			// If that run sent nothing, the refresh for this expiry is tried again, as for any passing hold-up.
			if (controller.signal.aborted || response?.stopReason === "aborted") {
				if (p.doneFor === expiresAt) p.doneFor = undefined;
				if (!out) return;
				ifSessionAlive(() => {
					trace(ctx, { ...base, action: "cancelled", seconds, ...(reached() ?? {}), reason: "a new request or a change of session cancelled it", usage, budget: budgetRecord(p) });
				});
				return;
			}
			ifSessionAlive(() => {
				if (late) {
					trace(ctx, { ...base, action: "skip", seconds, reason: "too late: the cache was about to expire before the refresh went out, so it was not sent" });
				} else if (!response || response.stopReason === "error") {
					const reason = error ?? response?.errorMessage ?? "the request failed";
					const ended = reached() ?? endWarm(p, "failed", reason);
					trace(ctx, { ...base, action: "failed", seconds, ...ended, reason, usage, budget: budgetRecord(p) });
					if (ctx.hasUI) ctx.ui.notify(`pi-cache-keeper could not keep the cache warm: ${reason}`, "warning");
				} else {
					// Either way the provider refreshed (or wrote) the entry when it received the request.
					warmedAt = started;
					const share = cachedShare(response.usage);
					const missed = share < MIN_WARM_CACHED_SHARE;
					const after = ctx.model ? stateOf(ctx.model, ctx.sessionManager.getBranch()).expiresAt : undefined;
					const ended =
						reached() ??
						(missed
							? endWarm(p, "missed", `the refresh read only ${Math.floor(100 * share)}% from the cache, so it wrote the context again`)
							: after !== undefined && !wantsWarm(after, p.idleSince, config.keepWarmMinutes)
								? endWarm(p, "limit", limitReason())
								: {});
					trace(ctx, { ...base, action: missed ? "missed" : "warm", seconds, ...ended, usage, budget: budgetRecord(p) });
					if (missed && ctx.hasUI) {
						ctx.ui.notify(`Keeping the cache warm read only ${Math.floor(100 * share)}% from the cache, so it wrote the context again. Stopped until your next message.`, "warning");
					}
				}
				if (ctx.isIdle()) startTimer(ctx);
			});
		})();
	};

	const startTimer = (ctx: ExtensionContext, compactAtExpiry = true) => {
		stopTimer(ctx);
		const readState = () => (ctx.model ? stateOf(ctx.model, ctx.sessionManager.getBranch()) : undefined);
		const first = readState();
		if (first?.expiresAt === undefined) return;
		let expiresAt = first.expiresAt;
		const warmLead = first.lifetime ? warmLeadMs(first.lifetime.ms, EXPIRY_LEAD_MS) : 0;
		const timer: TimerContext = {
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			lifetimeSeconds: first.lifetime && first.lifetime.ms / 1000,
			lifetimeSource: first.lifetime?.source,
		};
		let shown: string | undefined;
		let ticks = 0;
		let attempted = !compactAtExpiry;
		let warmChecked = false;
		const tick = () => {
			if (++ticks % 15 === 0 || expiresAt - Date.now() <= Math.max(EXPIRY_LEAD_MS, warmLead)) expiresAt = readState()?.expiresAt ?? expiresAt;
			const remaining = expiresAt - Date.now();
			const keepWarmOn = config.keepWarmMinutes > 0;
			if (keepWarmOn && remaining > 0 && !warming) noteLimit(ctx, expiresAt, timer);
			const ended = keepWarmOn && owns(period) ? endedStatus(period) : undefined;
			const text = warming ? "cache warm · refreshing" : `${formatCacheStatus(remaining)}${ended ? ` · ${ended}` : ""}`;
			if (ctx.hasUI && text !== shown) {
				shown = text;
				ctx.ui.setStatus(STATUS_KEY, remaining <= WARNING_MS && !warming ? ctx.ui.theme.fg(remaining > 0 ? "warning" : "dim", text) : text);
			}
			if (remaining <= 0) {
				// Expired (or the timer ran this late): nothing is refreshed or compacted from a cache that is gone.
				clearInterval(ticker);
				ticker = undefined;
			} else if (warming) {
				// Wait for the refresh; it restarts the countdown when it lands.
			} else if (!keepWarmOn) {
				// Keep-warm off: as before.
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
		ticker = setInterval(tick, 1000);
		ticker.unref();
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
		if (isKimiOnMoonshot(ctx.model)) payload = withKimiLongCache(payload);
		if (transcript) captured = { transcript, payload, model: ctx.model, at: Date.now() };
		return payload === event.payload ? undefined : payload;
	});
	pi.on("message_start", (event, ctx) => {
		const transcript = pendingTranscript;
		pendingTranscript = undefined;
		if (transcript && event.message.role === "assistant" && ctx.model?.api === BRIDGE_API) captured = { transcript, model: ctx.model, at: Date.now() };
	});
	// Which answer the captured request got, so a keep-warm period knows its answer's request.
	pi.on("message_end", (event) => {
		if (event.message.role === "assistant" && captured && captured.answeredAt === undefined) captured.answeredAt = event.message.timestamp;
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
	});
	// One warmer per idle period. Where the extension keeps the period warm itself (see whyNotOwned), every decision of
	// Pi's own warming that arrives while the window is idle (between agent_settled and agent_start, and Pi idle) is
	// answered "stop". In any other state, and with keep-warm off, it returns nothing and Pi's decision stands.
	pi.on("cache_warming_decision", (event, ctx) => {
		const p = period;
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
		stopTimer(ctx);
		// Keep the status in place during a request, so it does not appear and vanish with each turn.
		if (ctx.hasUI && ctx.model && stateOf(ctx.model, ctx.sessionManager.getBranch()).lifetime) {
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "cache in use"));
		}
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
		setTimeout(() => showCard(records), 0);
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
	});
	pi.on("session_shutdown", (_event, ctx) => {
		sessionCtx = undefined;
		abortWarm();
		stopTimer(ctx);
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
		if (config.keepWarmMinutes <= 0) return "off";
		const p = period;
		const rule = keepWarmRule(config.keepWarmMinutes, p?.budget ? p.budget.priced : !model || hasPrices(model));
		if (!p || running) return rule;
		if (p.notOwned !== undefined) return `${rule}; this session is left to Pi's own warming: ${p.notOwned}`;
		if (!owns(p)) return rule;
		if (p.ended) return `${rule}; ${endedStatus(p)}, until your next message (${p.ended.reason})`;
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
					`keepWarmMinutes: ${config.keepWarmMinutes} (${keepWarmNote(ctx.model)})`,
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
			warmItem.description = `Up to this long after Pi goes idle, re-send the last request with a one-token answer shortly before the cache expires, so your next message still reads it cheaply. Each refresh reads the whole context from the cache (about a tenth of the input price on Anthropic), and warming stops once refreshing has cost as much as one cache miss (writing the context again, less the cached read); a model without prices gets at most ${MAX_UNPRICED_REFRESHES} refreshes. While keep-warm is on, this extension is the only thing that keeps an idle cache warm, and Pi's own idle warming is told to stop; Pi still warms during a run. Sessions this extension cannot refresh itself are left to Pi's own warming: no cache lifetime or one under a minute, or a request that cannot be re-sent (Claude through pi-claude-bridge, or Claude's budget-based thinking). When warming ends, compact before expiry takes over. Now: ${keepWarmNote(ctx.model)}.`;
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
				description: `Once a day, read each model's input window, cache lifetimes and prices from ${DATA_SOURCE} (a public API: no key, and nothing about your sessions is sent) and put them into ~/.pi/agent/models.json: the window replaces Pi's, lifetimes and prices fill what Pi has none for, and values you set there yourself are never touched. The footer shows what was found for the current model. off takes these values out again.`,
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
					if (id === "keepWarmMinutes") describeWarm();
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
