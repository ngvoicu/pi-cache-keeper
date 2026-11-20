/**
 * The one place that decides whether what the extension has seen agrees with the lifetime a keep-warm period counts with.
 *
 * A request asks for a tier (short, long); how long a tier lasts is the route's (its model data); what a provider reports
 * writing (Anthropic's 5-minute or 1-hour cache) is evidence of a lifetime, never the name of a tier. A period counts with
 * one lifetime: the one its request states (`ttl`, OpenAI's and Kimi's values), else the route's data for the tier asked,
 * else the request format's default. Everything else is a report about it, and this file answers one question from them:
 * does everything seen agree with that lifetime?
 *
 * - A report is usage seen for the period's model: the period's own answer; the model's latest write on the branch up to
 *   and including it (for "against" only, never for confirmation); Pi's refreshes after it; and the responses of the
 *   extension's own refreshes. From each, what it wrote (`Written`).
 * - Confirmation: only where the period relies on a lifetime its request does not state and that is not the format's
 *   default (`confirm`): the period's own answer wrote, all of it in the cache of that lifetime. Nothing else confirms.
 * - Against: a report that wrote into a cache of another lifetime, or into both; or the route read now giving the
 *   request's tier another lifetime. For a period whose request states its lifetime, a report after the period's answer,
 *   and the route read after the period's start, are against only where they show a shorter lifetime (a 5-minute write, a
 *   write in both caches, the route now giving the tier less): the cache outliving the countdown costs nothing.
 * - Formats whose answers report no breakdown (OpenAI, Kimi) have no default of their own: they go by the data, need no
 *   confirmation, and none of their reports is ever against.
 *
 * Who asks, and what follows, is index.ts's: at the period's start (not confirmed, or against: the period is Pi's); on
 * each countdown read, when Pi's warming asks and at the last gate (against: warming ends, the period is Pi's, nothing
 * leaves); when one of the extension's refreshes settles, its report added first; and for a period whose warming ended
 * on its time limit, for what Pi's warming is told. After a hand-over on evidence against, `shortestMs` is the lifetime the
 * period's countdown counts with, from the period's own last fact.
 */

/** The lifetimes of the two caches an answer can report writing to (Anthropic, Bedrock). */
export const FIVE_MINUTES_MS = 300_000;
export const ONE_HOUR_MS = 3_600_000;

/**
 * What a report wrote: nothing; all of it in the 1-hour cache; none of it there (the 5-minute cache); some in each; or a
 * write in a format that reports no breakdown (`cacheWrite1h` undefined).
 */
export type Written = "nothing" | "hour" | "five minutes" | "both" | "no breakdown";

export function written(usage: { cacheWrite: number; cacheWrite1h?: number }): Written {
	if (!(usage.cacheWrite > 0)) return "nothing";
	if (usage.cacheWrite1h === undefined) return "no breakdown";
	if (usage.cacheWrite1h <= 0) return "five minutes";
	return usage.cacheWrite1h >= usage.cacheWrite ? "hour" : "both";
}

/** The lifetime a write is evidence of, the shorter for a write in both caches; none for the rest. */
export function writtenMs(w: Written): number | undefined {
	return w === "hour" ? ONE_HOUR_MS : w === "five minutes" || w === "both" ? FIVE_MINUTES_MS : undefined;
}

/** Where a report comes from. */
export type ReportSource = "answer" | "earlier answer" | "Pi's refresh" | "refresh";
export interface Report {
	from: ReportSource;
	written: Written;
}

/** The lifetime a period counts with, and how its request came by it. */
export interface PeriodLifetime {
	ms: number;
	/** The request states it (`ttl`, OpenAI's and Kimi's values). */
	stated: boolean;
	/** It relies on a lifetime the request does not state and that is not the format's default: the answer must confirm it. */
	confirm: boolean;
}

/** How a request came by its lifetime: one it states, and the default of its format where it states none. */
export interface RequestLifetime {
	statedMs?: number;
	defaultMs?: number;
}

/**
 * A marker without `ttl` (Anthropic's `cache_control`, wherever it is carried) has five minutes as its default, and so
 * has an Anthropic Messages request without any marker (the one format re-sent whose answers report which cache they
 * wrote). A request without markers in a format that reports no breakdown has no default of its own: it goes by the
 * route's data. `impliedMs`: the default of a marker without a lifetime the request carries.
 */
export function requestLifetime(api: string, statedMs: number | undefined, impliedMs?: number): RequestLifetime {
	if (statedMs !== undefined) return { statedMs };
	if (impliedMs !== undefined) return { defaultMs: impliedMs };
	return api === "anthropic-messages" ? { defaultMs: FIVE_MINUTES_MS } : {};
}

/** The route's lifetime for the request's tier read now (`dataMs`, the model data), with the format's default. */
export function routeLifetime(request: RequestLifetime, dataMs: number | undefined): number | undefined {
	return request.statedMs !== undefined ? dataMs : (dataMs ?? request.defaultMs);
}

/** The lifetime a period counts with: the one its request states, else the route's (with the format's default). */
export function periodLifetime(request: RequestLifetime, dataMs: number | undefined): PeriodLifetime | undefined {
	const ms = request.statedMs ?? routeLifetime(request, dataMs);
	if (ms === undefined) return undefined;
	return { ms, stated: request.statedMs !== undefined, confirm: request.statedMs === undefined && request.defaultMs !== undefined && ms !== request.defaultMs };
}

/** What is read now: the reports so far, and the route's lifetime for the request's tier (undefined: unknown). */
export interface Evidence {
	reports: readonly Report[];
	routeMs: number | undefined;
}

export type Verdict =
	| { agrees: true }
	| { agrees: false; why: "unconfirmed" }
	| { agrees: false; why: "route"; routeMs: number | undefined }
	| { agrees: false; why: "write"; report: Report; ms: number };

/**
 * Whether everything seen agrees with the period's lifetime. `atStart`: asked when the period starts, where a stated
 * lifetime must also be the route's.
 */
export function agrees(period: PeriodLifetime, evidence: Evidence, atStart: boolean): Verdict {
	const own = evidence.reports.find((r) => r.from === "answer");
	// The period's own answer wrote into both caches: two lifetimes, whatever the request says.
	if (own?.written === "both") return { agrees: false, why: "write", report: own, ms: FIVE_MINUTES_MS };
	const { routeMs } = evidence;
	const routeAgainst = period.stated ? routeMs !== undefined && (atStart ? routeMs !== period.ms : routeMs < period.ms) : routeMs !== period.ms;
	if (routeAgainst) return { agrees: false, why: "route", routeMs };
	for (const report of evidence.reports) {
		const ms = writtenMs(report.written);
		if (ms === undefined) continue;
		// What the request's own write, or the latest before it, says is compared both ways (the period's start); a later
		// report about a lifetime the request states only where it is shorter.
		const later = report.from === "Pi's refresh" || report.from === "refresh";
		const against = period.stated && later ? ms < period.ms : report.written === "both" || ms !== period.ms;
		if (against) return { agrees: false, why: "write", report, ms };
	}
	if (period.confirm && (own === undefined || writtenMs(own.written) !== period.ms)) return { agrees: false, why: "unconfirmed" };
	return { agrees: true };
}

/**
 * The lifetime a period handed over on evidence against counts with: the shortest of its own and every lifetime read
 * (the route now, every report's write, a write in both caches as the shorter). Zero where the route's lifetime is
 * unknown for a lifetime the request does not state: when in doubt, expired.
 */
export function shortestMs(period: PeriodLifetime, evidence: Evidence): number {
	if (evidence.routeMs === undefined && !period.stated) return 0;
	const read = evidence.reports.map((r) => writtenMs(r.written)).filter((ms): ms is number => ms !== undefined);
	return Math.min(period.ms, ...(evidence.routeMs === undefined ? [] : [evidence.routeMs]), ...read);
}
