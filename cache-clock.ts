/**
 * The only owner of "when does this cache expire, as far as anything seen says".
 *
 * A keep-warm period the extension took at its start has a clock (`PeriodClock`). It holds everything seen about the
 * period's cache: the time of the period's answer, the lifetime its request came by and how, the route that served it, the extension's own refreshes that reported a hit (when each left) and what they wrote; and, on
 * every read, what the answer wrote (and the model's latest write before it), Pi's refreshes since the answer and the
 * route's lifetime for the request's tier read now. It does not know
 * who warms the period, and it is told nothing about that.
 *
 * Three values only move one way:
 * - the floor: the shortest lifetime anything read has allowed. It starts at the period's lifetime and each read lowers it
 *   to the shortest lifetime of the evidence then (lifetime-evidence.ts). It never rises again. Zero: no lifetime can be
 *   read for a request that states none.
 * - the last sure fact: the later of the answer's time and the moment the latest of the extension's refreshes that reported
 *   a hit left. Pi's refreshes never move it: they are recorded when their answer came back, not when they left.
 * - the route changed: set once a request of the period's model was served by another route than the answer's; never
 *   unset, also when the first route is seen again (a cache on one route says nothing about another's).
 *
 * One reading (`cacheView`), with two edges:
 * - `sendBy`, what anything that sends (a refresh, a summary) relies on: the last sure fact plus the floor. Unknown where
 *   the route changed or the floor is zero: then nothing is sent.
 * - `goneBy`, only for what Pi's own warming is told about a period handed over to it: the later of the last sure fact
 *   and Pi's latest refresh, plus the floor. At or after it, nothing seen says the cache can be alive.
 *
 * Outside a taken period (keep-warm off, a period never taken, another branch, another model) the reading is
 * `cacheState` with keep-warm off, exactly; keep-warm switched off inside a taken period adds the clock's latest hit.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { cacheState, type CacheState } from "./cache-state.ts";
import type { CacheMarker } from "./keep-warm.ts";
import {
	agrees,
	periodLifetime,
	requestLifetime,
	routeLifetime,
	shortestMs,
	type Evidence,
	type PeriodLifetime,
	type Report,
	type RequestLifetime,
	type Verdict,
	type Written,
} from "./lifetime-evidence.ts";
import { formatDuration } from "./trace.ts";

declare const sendByBrand: unique symbol;
/** An expiry a request may be sent on. Only this module makes one. */
export type SendBy = number & { readonly [sendByBrand]: true };

export interface CacheView {
	regime: "plain" | "period";
	cached: boolean;
	replied: boolean;
	answeredAt?: number;
	/** What every display shows: in a taken period the floor, with its source. */
	lifetime?: { ms: number; source: string };
	/** A request may leave only before it. Undefined: no cache, or unknown. Nothing is sent. */
	sendBy?: SendBy;
	/** Why there is no sendBy although the answer used the cache. */
	unknown?: "the route changed" | "no lifetime can be read";
	/** Period regime: at or after it, nothing seen says the cache can be alive. For Pi's question only. */
	goneBy?: number;
	/** Period regime: the first evidence against the period, kept. */
	against?: { reason: string; label: string };
}

/** What the period's start reads: `cacheState` with keep-warm on, without its expiry. */
export type StartFacts = Omit<CacheState, "expiresAt" | "refreshedAt">;

/** What a request's cache markers ask for (keep-warm.ts's `requestCache`). */
export interface RequestCache {
	tier: "short" | "long";
	markers: CacheMarker[];
	unreadable?: string;
	mixed: boolean;
}

/** What the period's start reads: `cacheState` with keep-warm on, for the tier the request asked for, without the expiry. */
export function startFacts(served: Model<Api>, entries: SessionEntry[], requested: "short" | "long"): StartFacts {
	const { expiresAt: _expiresAt, refreshedAt: _refreshedAt, ...facts } = cacheState(served, entries, undefined, true, requested);
	return facts;
}

/** How a request came by its lifetime, for the words of a disagreement. */
interface How {
	asked: RequestLifetime;
	dataMs?: number;
	markerAt?: string;
}

/** A "no" of lifetime-evidence.ts in words, with what the footer says of it. */
function disagreement(verdict: Exclude<Verdict, { agrees: true }>, lifetime: PeriodLifetime, how: How, atStart: boolean): { reason: string; label: string } {
	const no = (label: string, reason: string) => ({ reason, label });
	const period = formatDuration(lifetime.ms);
	const by = lifetime.stated ? "as it states" : how.dataMs !== undefined ? "by the route's data" : how.markerAt ? "by its marker's default" : "by its format's default";
	const lasts = `the request's cache lasts ${period} ${by}`;
	const what = (w: Written) => (w === "both" ? "a cache write partly in the 5-minute and partly in the 1-hour cache" : `a ${w === "hour" ? "60 min" : "5 min"} cache write`);
	if (verdict.why === "unconfirmed") {
		const marker = how.markerAt ? `(${how.markerAt}), and the route's lifetime for its tier (${period}) is not the 5 min that marker defaults to` : `(it carries no cache marker), and the route's lifetime for its tier (${period}) is not the 5 min a request without one defaults to`;
		return no("route's lifetime unconfirmed", `the request states no cache lifetime ${marker}; the answer did not report a cache write, all of it in that cache, that confirms it`);
	}
	if (verdict.why === "route") {
		if (atStart && lifetime.stated) return no("lifetime differs from the data", "the request's cache lifetime does not match the model data");
		const now = verdict.routeMs === undefined ? "an unknown time" : `${formatDuration(verdict.routeMs)} by the route's data`;
		return no("the route's lifetime changed", `the request's cache now lasts ${now}, the cached request was written with ${period}`);
	}
	const { report } = verdict;
	if (report.from === "answer" && report.written === "both") return no("both tiers written", "the answer reports cache writes in both tiers (5 min and 1 h)");
	if (report.from === "Pi's refresh") return no("Pi's refresh wrote otherwise", `a refresh of Pi's after the answer reports ${what(report.written)}; ${lasts}`);
	if (report.from === "refresh") return no("the refresh wrote otherwise", `the extension's refresh reports ${what(report.written)}; ${lasts}`);
	if (report.written === "both") return no("mixed cache write", "an answer of this model reports a cache write partly in the 5-minute and partly in the 1-hour cache: two lifetimes, until an answer reports a write in one of them only");
	return no("the answer's write lasts otherwise", `an answer of this model reports a ${formatDuration(verdict.ms)} cache write; ${lasts}`);
}

/** Another route served a request of the period's model since its answer. */
function routeChanged(atAnswer: string, since: string): { reason: string; label: string } {
	return { label: "the route changed", reason: `the period's answer was served by ${atAnswer}, and a request of the model was served by ${since} since: a cache on one route says nothing about the other's` };
}

/** The reports a period starts with: its answer, and the model's latest write up to it where the answer itself wrote none. */
function answerReports(facts: StartFacts): Report[] {
	const answer = facts.answerWritten ?? "nothing";
	const earlier = answer === "nothing" || answer === "no breakdown" ? facts.latestWritten : undefined;
	return [{ from: "answer", written: answer }, ...(earlier ? [{ from: "earlier answer" as const, written: earlier }] : [])];
}
const piReports = (facts: StartFacts): Report[] => (facts.piRefreshes ?? []).map((w) => ({ from: "Pi's refresh" as const, written: w.written }));

// The one reading of a clock, for `cacheView` only (set in the class's static block, so nothing else can call it).
let readClock: (clock: PeriodClock, kept: CacheState, routeKey: string, dataMs: number | undefined) => CacheView;
let answerOf: (clock: PeriodClock) => number;
let hitOf: (clock: PeriodClock) => number | undefined;

export class PeriodClock {
	readonly #answeredAt: number;
	readonly #lifetime: PeriodLifetime;
	readonly #source: string;
	readonly #how: Omit<How, "dataMs">;
	readonly #routeKey: string;
	#floor: number;
	#hitAt: number | undefined;
	readonly #own: Written[] = [];
	#otherRoute: string | undefined;
	#against: { reason: string; label: string } | undefined;

	private constructor(o: { answeredAt: number; lifetime: PeriodLifetime; source: string; how: Omit<How, "dataMs">; routeKey: string }) {
		this.#answeredAt = o.answeredAt;
		this.#lifetime = o.lifetime;
		this.#source = o.source;
		this.#how = o.how;
		this.#routeKey = o.routeKey;
		this.#floor = o.lifetime.ms;
	}

	/**
	 * The period's start: a clock where everything seen agrees with the lifetime the request came by, else why not. The
	 * request's lifetime is the one its markers state, else the route's data for the tier asked (`dataMs`) with its
	 * format's default; it must be the one the start facts count with.
	 */
	static start(o: { facts: StartFacts; api: string; cache: RequestCache; dataMs: number | undefined; routeKey: string }): { clock: PeriodClock } | { declined: { reason: string; label: string } } {
		const implied = o.cache.markers.find((m) => m.implied);
		const asked = requestLifetime(o.api, o.cache.markers.find((m) => m.ms !== undefined && !m.implied)?.ms, implied?.ms);
		const lifetime = periodLifetime(asked, o.dataMs);
		if (!lifetime) return { declined: { label: "no cache lifetime", reason: "the cache lifetime is unknown" } };
		const how = { asked, ...(implied ? { markerAt: implied.at } : {}) };
		const answered = answerReports(o.facts);
		const verdict = agrees(lifetime, { reports: [...answered, ...piReports(o.facts)], routeMs: routeLifetime(asked, o.dataMs) }, true);
		if (!verdict.agrees) return { declined: disagreement(verdict, lifetime, { ...how, dataMs: o.dataMs }, true) };
		// The lifetime the start facts count with (the model's latest write, else the data) is the period's.
		if (o.facts.answeredAt === undefined || !o.facts.lifetime || lifetime.ms !== o.facts.lifetime.ms) {
			return { declined: { label: "lifetime differs from the data", reason: "the request's cache lifetime does not match the model data" } };
		}
		return { clock: new PeriodClock({ answeredAt: o.facts.answeredAt, lifetime, source: o.facts.lifetime.source, how, routeKey: o.routeKey }) };
	}

	/** A refresh of the extension's reported a hit; it left at `sentAt`. */
	hit(sentAt: number): void {
		this.#hitAt = Math.max(this.#hitAt ?? sentAt, sentAt);
	}

	/** What a refresh of the extension's wrote. */
	wrote(report: Written): void {
		this.#own.push(report);
	}

	/** The route that served a request of the period's model. */
	served(routeKey: string): void {
		if (routeKey !== this.#routeKey) this.#otherRoute ??= routeKey;
	}

	static {
		answerOf = (clock) => clock.#answeredAt;
		hitOf = (clock) => clock.#hitAt;
		readClock = (clock, kept, routeKey, dataMs) => clock.#read(kept, routeKey, dataMs);
	}

	#read(kept: CacheState, routeKey: string, dataMs: number | undefined): CacheView {
		this.served(routeKey);
		// The answer's write and the model's latest before it are read from the branch again: the same answer, but a
		// write of the model's placed before it since (an edited branch) is evidence too.
		const evidence: Evidence = {
			reports: [...answerReports(kept), ...piReports(kept), ...this.#own.map((w) => ({ from: "refresh" as const, written: w }))],
			routeMs: routeLifetime(this.#how.asked, dataMs),
		};
		const verdict = agrees(this.#lifetime, evidence, false);
		this.#floor = Math.min(this.#floor, shortestMs(this.#lifetime, evidence));
		if (!verdict.agrees) this.#against ??= disagreement(verdict, this.#lifetime, { ...this.#how, dataMs }, false);
		else if (this.#otherRoute !== undefined) this.#against ??= routeChanged(this.#routeKey, this.#otherRoute);
		const floor = this.#floor;
		const sure = Math.max(this.#answeredAt, this.#hitAt ?? this.#answeredAt);
		const piLatest = Math.max(sure, ...(kept.piRefreshes ?? []).map((w) => w.at));
		const unknown = !kept.cached ? undefined : this.#otherRoute !== undefined ? ("the route changed" as const) : floor === 0 ? ("no lifetime can be read" as const) : undefined;
		return {
			regime: "period",
			cached: kept.cached,
			replied: kept.replied,
			...(kept.answeredAt === undefined ? {} : { answeredAt: kept.answeredAt }),
			...(floor > 0 ? { lifetime: { ms: floor, source: floor === this.#lifetime.ms ? this.#source : "the shortest lifetime read since" } } : {}),
			...(kept.cached && unknown === undefined ? { sendBy: (sure + floor) as SendBy } : {}),
			...(unknown ? { unknown } : {}),
			...(kept.cached && floor > 0 ? { goneBy: piLatest + floor } : {}),
			...(this.#against ? { against: this.#against } : {}),
		};
	}
}

/** The plain reading: `cacheState` as it is. */
function plainView(state: CacheState): CacheView {
	return {
		regime: "plain",
		cached: state.cached,
		replied: state.replied,
		...(state.answeredAt === undefined ? {} : { answeredAt: state.answeredAt }),
		...(state.lifetime ? { lifetime: state.lifetime } : {}),
		...(state.expiresAt === undefined ? {} : { sendBy: state.expiresAt as SendBy }),
	};
}

/**
 * The one reading. `period` is passed where the period's model is the model asked about; this checks the branch: the
 * period's facts hold only while the branch in front of the user still holds the period's answer. `on`: keep-warm reads
 * on now. `served`: the model with the lifetimes of what served the period (its own route; else `served` as given).
 * `routeKey`: the identity of the route serving the model, read now (the whole report of it); `dataMs`: the route's
 * lifetime for the request's tier, read now; `requested`: the tier the period's request asked for.
 */
export function cacheView(
	served: Model<Api>,
	entries: SessionEntry[],
	period?: { clock: PeriodClock; on: boolean; served?: Model<Api>; routeKey: string; dataMs: number | undefined; requested: "short" | "long" },
): CacheView {
	const plain = cacheState(served, entries);
	if (!period || plain.answeredAt === undefined || plain.answeredAt !== answerOf(period.clock)) return plainView(plain);
	if (!period.on) {
		const hit = hitOf(period.clock);
		return plainView(hit === undefined ? plain : cacheState(served, entries, hit));
	}
	// The period's own reading: the model with the lifetimes of what served the period (its own route), where given.
	const kept = cacheState(period.served ?? served, entries, undefined, true, period.requested);
	if (kept.answeredAt !== plain.answeredAt) return plainView(plain);
	return readClock(period.clock, kept, period.routeKey, period.dataMs);
}
