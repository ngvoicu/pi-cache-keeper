import { appendFileSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { formatUsd } from "./keep-warm.ts";

const TRACE_PATH = join(getAgentDir(), "cache-keeper.jsonl");
export const TRACE_PATH_LABEL = TRACE_PATH.startsWith(homedir()) ? `~${TRACE_PATH.slice(homedir().length)}` : TRACE_PATH;
const MAX_TRACE_BYTES = 5_000_000;

export type Trigger = "manual" | "threshold" | "overflow" | "expiry" | "full";

export interface TraceUsage {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	cost: number;
}

export interface CompactTrace {
	event: "compact";
	trigger: Trigger;
	model: string;
	outcome: "cached" | "fallback" | "cancelled";
	reason?: string;
	mismatch?: { captured?: string; rebuilt?: string };
	tokensBefore: number;
	cwd: string;
	sessionFile?: string;
	lastRequest?: { secondsAgo: number; messages: number; promptTokens?: number; newMessages: number };
	cache?: { lifetimeSeconds?: number; source?: string; expiresInSeconds?: number };
	request?: { thinking: string; bridgeFork: boolean; toolChoiceNone: boolean; sharedPrefix: boolean };
	response?: { stopReason: string; seconds: number; usage: TraceUsage; summaryChars: number; error?: string };
	piEstimate?: { input: number; cost: number };
}

export interface ResultTrace {
	event: "result";
	trigger: Trigger;
	by: "extension" | "pi";
	entryId: string;
	tokensBefore: number;
	usage?: TraceUsage;
	summaryChars: number;
}

export interface FailedTrace {
	event: "failed";
	trigger: Trigger;
	aborted: boolean;
	error?: string;
}

/** The model and cache lifetime a timer decision was made for (records before 0.5 have none). */
export interface TimerContext {
	/** "provider/id". */
	model?: string;
	lifetimeSeconds?: number;
	/** Where the lifetime came from: "declared by the model", "reported by the provider", … */
	lifetimeSource?: string;
}

export interface ExpiryTrace extends TimerContext {
	event: "expiry";
	action: "compact" | "skip";
	reason?: string;
	secondsLeft: number;
	contextTokens?: number;
}

export interface FullTrace {
	event: "full";
	action: "compact" | "skip";
	reason?: string;
	contextTokens: number;
	threshold: number;
	percent: number;
	/** The compactAtTokens cap, when it is the mark that was passed instead of the percentage. */
	tokens?: number;
}

/**
 * Why keeping warm ended for the rest of an idle period: the budget (refreshing has cost as much as one cache miss, or
 * 10 refreshes without prices), the time limit (the cache lasts to the end of the window), a refresh that missed the
 * cache, a refresh that failed, a request that can no longer be re-sent, or a /cache-keeper-stop.
 */
export type WarmStop = "budget" | "limit" | "missed" | "failed" | "unable" | "unknown" | "stopped";

export interface WarmTrace extends TimerContext {
	event: "warm";
	/**
	 * "warm": the cache was refreshed; "missed": the refresh wrote the cache again instead of reading it; "cancelled": a
	 * new request (or a change of session) cancelled a refresh that had gone out, still counted; "skip": no refresh went
	 * out (with `stop`: warming ended); "pi-stopped": Pi's own idle warming was told to stop, since the extension keeps
	 * this idle period's cache warm (or a /cache-keeper-stop holds); "left": a period left to Pi's own warming from its
	 * start, written when the reason changes (`reason`: why).
	 */
	action: "warm" | "missed" | "failed" | "cancelled" | "skip" | "pi-stopped" | "left";
	reason?: string;
	secondsLeft: number;
	contextTokens?: number;
	idleMinutes?: number;
	seconds?: number;
	usage?: TraceUsage;
	/**
	 * What the extension's refreshes have cost in this idle period against what they may: in dollars against one cache
	 * miss, or, for a model without prices, in refreshes. `next`: what one more refresh is reserved at.
	 */
	budget?: { unit: "usd" | "refreshes"; spent: number; limit: number; next?: number };
	/** Set on the one record where keeping warm ended for the rest of the idle period. */
	stop?: WarmStop;
	/**
	 * Set on the refresh that was a model's second miss in a row: from then on, until /cache-keeper-warm or the end of
	 * the Pi process, this model is left to Pi's own warming. The line `/cache-keeper` shows.
	 */
	leftToPi?: string;
	/** On the record of a refresh that left: its number in its idle period, and what its reported usage showed. */
	refresh?: number;
	verdict?: "hit" | "miss";
	/** On a `skip` without an end: why the refresh that was due did not leave. */
	hold?: "busy" | "settling" | "late";
	/** On the record where a period changes hands: why it is Pi's from now (evidence against it, or its request let go). */
	handedOver?: "evidence" | "let go";
}

export interface DataTrace {
	event: "data";
	/** "updated": models.json changed; "unchanged": it already held the data; "failed": providers.dev or models.json could not be read. */
	action: "updated" | "unchanged" | "failed";
	reason?: string;
	/** How many models' entries in models.json changed. */
	models?: number;
	dataset?: string;
	downloaded?: boolean;
}

export type TraceEvent = CompactTrace | ResultTrace | FailedTrace | ExpiryTrace | FullTrace | WarmTrace | DataTrace;
export type TraceRecord = TraceEvent & { at: string; session: string };
const TRACE_EVENTS = new Set<string>(["compact", "result", "failed", "expiry", "full", "warm", "data"] satisfies TraceEvent["event"][]);

export function appendTrace(record: TraceRecord): void {
	try {
		if (statSync(TRACE_PATH).size > MAX_TRACE_BYTES) renameSync(TRACE_PATH, `${TRACE_PATH}.1`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	appendFileSync(TRACE_PATH, `${JSON.stringify(record)}\n`);
}

export function readTraces(session: string, limit: number): TraceRecord[] {
	let text: string;
	try {
		text = readFileSync(TRACE_PATH, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const records: TraceRecord[] = [];
	for (const line of text.split("\n")) {
		if (!line) continue;
		// Skips lines cut short by a crash and events from other versions.
		try {
			const record = JSON.parse(line) as TraceRecord;
			if (record.session === session && TRACE_EVENTS.has(record.event)) records.push(record);
		} catch {}
	}
	return records.slice(-limit);
}

const TRIGGER_LABELS: Record<Trigger, string> = {
	manual: "/compact",
	threshold: "auto-compaction",
	overflow: "overflow recovery",
	expiry: "compact before expiry",
	full: "compact when full",
};

function cacheShare(usage: TraceUsage): string {
	const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
	const pct = prompt > 0 ? Math.floor((100 * usage.cacheRead) / prompt) : 0;
	return `${pct}% of ${formatTokens(prompt)} from cache, ${formatTokens(usage.output)} out`;
}

function budgetText(budget: NonNullable<WarmTrace["budget"]>): string {
	return budget.unit === "usd"
		? `${formatUsd(budget.spent)} of ${formatUsd(budget.limit)} (one cache miss) spent`
		: `${budget.spent} of at most ${budget.limit} refreshes (no prices)`;
}

/** Why keeping warm ended, in a few words; `limit` names the time limit when it is known ("2 h limit"). */
export function stopLabel(stop: WarmStop, limit?: string): string {
	switch (stop) {
		case "budget":
			return "budget reached";
		case "limit":
			return limit ? `${limit} limit` : "time limit";
		case "missed":
			return "a refresh missed the cache";
		case "failed":
			return "a refresh failed";
		case "unable":
			return "the request can't be re-sent";
		case "unknown":
			return "a refresh reported no usage";
		case "stopped":
			return "stopped by /cache-keeper-stop";
	}
}

/** The reason a switch-off ends a period's warming with: its notice is worded by it. */
export const SWITCHED_OFF = "keep-warm was turned off";

/** What a record says in the transcript. */
export interface Notice {
	readonly level: "info" | "warning";
	readonly text: string;
}

const UNTIL_NEXT = "Stopped until your next message.";

/**
 * What a `warm` record says in the transcript, or nothing: each event the extension meets while keeping warm, worded
 * from the record alone (docs/stop-warming.md, section 5). `limit` names the time limit, as for `stopLabel`. A record
 * whose `stop` is "stopped" says nothing (the stop's own notice has said it), nor does a `skip` that has neither an end,
 * a `hold` nor `handedOver`.
 */
export function noticeOf(record: WarmTrace, limit?: string): Notice | undefined {
	const info = (text: string): Notice => ({ level: "info", text });
	const warning = (text: string): Notice => ({ level: "warning", text });
	const { budget, usage, reason = "" } = record;
	const amounts = !budget ? undefined : budget.unit === "usd" ? `${formatUsd(budget.spent)} spent, a miss costs ${formatUsd(budget.limit)}` : `${budget.spent} of ${budget.limit} refreshes`;
	const tail = amounts ? `; ${amounts}` : "";
	const prompt = usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0;
	const read = usage && prompt > 0 ? `${Math.floor((100 * usage.cacheRead) / prompt)}% of ${formatTokens(prompt)} from the cache` : undefined;
	// The cost, for a model with prices only.
	const cost = usage && budget?.unit === "usd" ? formatUsd(usage.cost) : undefined;
	const n = record.refresh === undefined ? "" : ` (refresh ${record.refresh})`;
	const warmed = () => `Cache warmed (pi-cache-keeper${record.refresh === undefined ? "" : `, refresh ${record.refresh}`}): ${read ?? "what it read is unknown"}${cost ? `, ${cost}` : ""}${tail}`;
	const readOnly = () => `read only ${read}${cost ? `: ${cost}` : ""}`;
	const handed = (text: string) => (record.handedOver === "let go" ? info(text) : warning(text));
	switch (record.action) {
		case "left":
			return info(`Keep-warm: this session is left to Pi's own warming: ${reason}`);
		case "pi-stopped":
			return info(`Told Pi's own idle warming to stop: ${reason}`);
		case "warm": {
			if (record.stop === "unknown" || !read) return warning(`Keeping the cache warm: refresh${record.refresh === undefined ? "" : ` ${record.refresh}`} reported no usage, so what it cost is unknown${tail}. ${UNTIL_NEXT}`);
			if (record.stop === "budget" || record.stop === "limit") return info(`${warmed()}. Keep-warm ended until your next message (${stopLabel(record.stop, limit)}).`);
			if (record.stop === "unable" || record.handedOver) return handed(`${warmed()}. Keep-warm ended, and this idle period is left to Pi's own warming: ${reason}.`);
			return info(warmed());
		}
		case "missed":
			return warning(`Keeping the cache warm ${read ? `read only ${read}` : "missed the cache"}, so it wrote the context again${cost ? `: ${cost}` : ""}${tail}. ${UNTIL_NEXT}`);
		case "failed":
			if (record.verdict === "hit") return info(`${warmed()}. The request then failed: ${reason}`);
			if (record.refresh === undefined) return warning(`pi-cache-keeper could not keep the cache warm: ${reason} (nothing was sent)${tail}. ${UNTIL_NEXT}`);
			return warning(`pi-cache-keeper could not keep the cache warm: ${reason}${tail}. ${UNTIL_NEXT}${record.verdict === "miss" && read ? ` It had ${readOnly()}.` : ""}`);
		case "cancelled":
			if (record.verdict === "hit") return info(`${warmed()}. It was then cancelled by a new request or a change of session.`);
			if (record.verdict === "miss" && read) return warning(`The cache refresh on its way${n} was cancelled by a new request; it had ${readOnly()}${tail}`);
			return info(`The cache refresh on its way${n} was cancelled by a new request or a change of session; it stays counted${amounts ? `: ${amounts}` : ""}`);
		case "skip":
			switch (record.stop) {
				case "stopped":
					return undefined;
				case "budget":
				case "limit":
					return info(`Keep-warm ended until your next message (${stopLabel(record.stop, limit)}): ${reason}${tail}`);
				case "unable":
					if (reason === SWITCHED_OFF) return info(`Keep-warm ended for this idle period: ${reason}${tail}`);
					if (record.handedOver) return handed(`Keep-warm ended, and this idle period is left to Pi's own warming: ${reason}${tail}`);
					return warning(`Keep-warm ended until your next message (the request can't be re-sent): ${reason}${tail}`);
				case "failed":
					return warning(`pi-cache-keeper could not keep the cache warm: ${reason} (nothing was sent)${tail}. ${UNTIL_NEXT}`);
				case undefined:
					break;
				default:
					return warning(`Keep-warm ended until your next message (${stopLabel(record.stop, limit)}): ${reason}${tail}`);
			}
			if (record.hold === "busy") return info("Cache refresh held back: Pi is busy or has queued messages; tried again until the last safe moment.");
			if (record.hold === "settling") return info("Cache refresh held back: an earlier refresh of this model has not settled yet, and it may have missed the cache; tried again until the last safe moment.");
			if (record.hold === "late") {
				return warning(`The cache was not refreshed: too late, less than half the warm lead was left before it expires (the computer slept, or Pi was busy until then). It expires in ${Math.max(0, record.secondsLeft)}s.`);
			}
			if (record.handedOver) return handed(`This idle period is left to Pi's own warming from now: ${reason}`);
			return undefined;
	}
}

function formatCost(cost: number): string {
	return `$${Number(cost.toPrecision(2))}`;
}

export function comparison(record: CompactTrace): { text: string; ratio: number } | undefined {
	const { piEstimate, response } = record;
	if (record.outcome !== "cached" || !piEstimate || !response) return undefined;
	const { usage } = response;
	const priced = piEstimate.cost > 0;
	const ratio = priced ? usage.cost / piEstimate.cost : (usage.input + usage.cacheWrite) / piEstimate.input;
	const delta =
		ratio <= 0.95 ? `${Math.round(100 * (1 - ratio))}% less`
		: ratio < 1.05 ? "about the same"
		: ratio < 2 ? `${Math.round(100 * (ratio - 1))}% more`
		: `${ratio.toFixed(1)}× as much`;
	const text = priced
		? `vs Pi's compaction: ${delta}, ${formatCost(usage.cost)} instead of ~${formatCost(piEstimate.cost)} (it sends ~${formatTokens(piEstimate.input)} tokens, none from cache)`
		: `vs Pi's compaction: ${delta}, ${formatTokens(usage.input + usage.cacheWrite)} tokens not from cache instead of ~${formatTokens(piEstimate.input)}`;
	return { text, ratio };
}

export function formatRemaining(ms: number): string {
	const seconds = Math.max(0, Math.ceil(ms / 1000));
	// A 12-hour cache reads "11h 59m", not "719m".
	if (seconds >= 2 * 3600) {
		const minutes = Math.floor(seconds / 60);
		return minutes % 60 === 0 ? `${minutes / 60}h` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
	}
	if (seconds >= 120) return `${Math.floor(seconds / 60)}m`;
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The footer text: "cache warm · 59m left", then "cache cold · next message full price". */
export function formatCacheStatus(ms: number): string {
	return ms <= 0 ? "cache cold · next message full price" : `cache warm · ${formatRemaining(ms)} left`;
}

export function formatTokens(count: number): string {
	return count >= 1000 ? `${Math.round(count / 1000)}k` : String(count);
}

export function formatDuration(ms: number): string {
	return ms >= 120_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
}

export function describeTrace(record: TraceRecord): string {
	const time = new Date(record.at).toLocaleTimeString([], { hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" });
	switch (record.event) {
		case "compact": {
			const what = TRIGGER_LABELS[record.trigger];
			if (record.outcome === "cached" && record.response) {
				const { usage, seconds, summaryChars } = record.response;
				return `${time} ${what}: cached, ${cacheShare(usage)}, ${seconds.toFixed(1)}s, summary ${summaryChars} chars`;
			}
			const then = record.outcome === "fallback" ? "Pi's compaction" : "cancelled";
			const usage = record.response?.usage;
			const spent = usage && usage.input + usage.cacheRead + usage.cacheWrite > 0 ? ` (the summary request used ${cacheShare(usage)}, ${formatCost(usage.cost)})` : "";
			return `${time} ${what}: ${then}, ${record.reason}${spent}`;
		}
		case "result":
			return record.by === "pi"
				? `${time}   Pi's compaction saved${record.usage ? `: ${cacheShare(record.usage)}, ${formatCost(record.usage.cost)}` : ""}, summary ${record.summaryChars} chars`
				: `${time}   saved, ${formatTokens(record.tokensBefore)} tokens summarized`;
		case "failed":
			return `${time} ${TRIGGER_LABELS[record.trigger]}: ${record.aborted ? "aborted" : (record.error ?? "failed")}`;
		case "expiry":
			return record.action === "compact"
				? `${time} cache expires in ${record.secondsLeft}s: compacting ${formatTokens(record.contextTokens ?? 0)} tokens`
				: `${time} cache expires in ${record.secondsLeft}s: not compacting, ${record.reason}`;
		case "warm": {
			const idle = record.idleMinutes === undefined ? "" : `, idle ${record.idleMinutes} min`;
			const used = record.usage ? `: ${cacheShare(record.usage)}, ${formatCost(record.usage.cost)}` : "";
			const budget = record.budget ? `; ${budgetText(record.budget)}` : "";
			const ended = record.stop ? `; keep-warm ended (${stopLabel(record.stop)})` : "";
			if (record.action === "warm") return `${time} kept the cache warm${idle}${used}${budget}${ended}`;
			if (record.action === "missed") return `${time} keeping the cache warm missed the cache${idle}${used}${budget}${ended || "; stopped until your next message"}${record.leftToPi ? `; ${record.leftToPi}` : ""}`;
			if (record.action === "failed") return `${time} keeping the cache warm failed: ${record.reason}${used}${budget}${ended}${record.leftToPi ? `; ${record.leftToPi}` : ""}`;
			if (record.action === "pi-stopped") return `${time} told Pi's own idle warming to stop: ${record.reason}${budget}`;
			if (record.action === "left") return `${time} keep-warm: left to Pi's own warming, ${record.reason}`;
			if (record.action === "cancelled") return `${time} a refresh of the cache was cancelled: ${record.reason}${used}${budget}${ended}${record.leftToPi ? `; ${record.leftToPi}` : ""}`;
			if (record.stop) return `${time} cache expires in ${record.secondsLeft}s: keep-warm ended (${stopLabel(record.stop)}), ${record.reason}${budget}`;
			if (record.handedOver) return `${time} cache expires in ${record.secondsLeft}s: left to Pi's own warming from now, ${record.reason}`;
			return `${time} cache expires in ${record.secondsLeft}s: not keeping it warm, ${record.reason}`;
		}
		case "data":
			if (record.action === "failed") return `${time} model data from providers.dev: failed, ${record.reason}`;
			return record.action === "updated"
				? `${time} model data from providers.dev: ${record.models} model${record.models === 1 ? "" : "s"} updated in models.json`
				: `${time} model data from providers.dev: nothing to change`;
		case "full": {
			const mark = record.tokens === undefined ? `${record.percent}% (${formatTokens(record.threshold)})` : `the ${formatTokens(record.tokens)}-token cap`;
			const where = `context at ${formatTokens(record.contextTokens)}, past ${mark}`;
			return record.action === "compact" ? `${time} ${where}: compacting` : `${time} ${where}: not compacting, ${record.reason}`;
		}
	}
}

export function traceDetails(record: CompactTrace): string[] {
	const lines: string[] = [];
	const { cache, lastRequest, request, response, mismatch } = record;
	if (cache) {
		const lifetime = cache.lifetimeSeconds === undefined ? "lifetime unknown" : `lifetime ${formatDuration(cache.lifetimeSeconds * 1000)} (${cache.source})`;
		const left = cache.expiresInSeconds === undefined ? "" : `, ${formatDuration(cache.expiresInSeconds * 1000)} left`;
		lines.push(`cache: ${lifetime}${left}`);
	}
	if (lastRequest) {
		const sent = lastRequest.promptTokens ? `, ${formatTokens(lastRequest.promptTokens)} prompt tokens` : "";
		lines.push(`last request: ${formatDuration(lastRequest.secondsAgo * 1000)} ago, ${lastRequest.messages} messages${sent}, ${lastRequest.newMessages} new since`);
	}
	if (request) {
		const extras = [
			request.sharedPrefix ? "shared 12h prefix" : "",
			request.toolChoiceNone ? "tool_choice none" : "",
			request.bridgeFork ? "Claude Code fork" : "",
		].filter(Boolean);
		lines.push(`request: thinking ${request.thinking}${extras.map((extra) => `, ${extra}`).join("")}`);
	}
	if (response?.error) lines.push(`error: ${response.error}`);
	if (mismatch?.captured !== undefined) lines.push(`last request had: ${mismatch.captured}`, `summary request had: ${mismatch.rebuilt ?? "(nothing)"}`);
	return lines;
}
