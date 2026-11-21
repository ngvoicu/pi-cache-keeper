import { visibleWidth } from "@earendil-works/pi-tui";
import type { CacheMarker } from "./keep-warm.ts";
import { fieldStates, usableLifetime, type Found, type Via } from "./model-data.ts";
import { formatCacheStatus, formatRemaining, stopLabel, type WarmStop } from "./trace.ts";

/**
 * The extension's line in Pi's footer: the cache countdown, then what has gone wrong or where the extension stepped
 * back, then the values in use (the cache lifetimes, what the last request asked for, the price), as one status.
 *
 * Every piece has a wide and one or two narrower renderings and a priority. The line is fitted to the terminal's width:
 * the least important pieces are narrowed first, then dropped, then whatever room is left goes back to the most
 * important ones. Errors sit right after the countdown and are dropped last, so a footer that Pi or powerline-footer
 * cuts at the right still shows them.
 */

type Tier = "short" | "long";

/** Pi's theme colours, by what a piece says. A piece without one keeps the footer's own colour. */
export type Tone = "dim" | "muted" | "warning";
export interface Segment {
	text: string;
	tone?: Tone;
}
type Form = Segment[];
/**
 * One piece of the line, in its renderings from the widest to the narrowest. `keep`: never dropped. `lastResort`: the
 * narrowest rendering (an error's bare mark) is used only where the part would otherwise be dropped.
 */
export interface Part {
	forms: Form[];
	priority: number;
	keep?: boolean;
	lastResort?: boolean;
}

/** The countdown turns to the warning colour for its last 30 seconds. */
export const WARNING_MS = 30_000;
const SEPARATOR = " · ";
/** The narrowest rendering of an error: the mark alone, so an error is never dropped while a value is still shown. */
const ALERT = "⚠";

/**
 * What is kept longest: errors, the countdown (never dropped, but its wording goes before an error's detail), then the
 * values in use, then what explains them.
 */
const PRIORITY = {
	warmAlert: 95,
	countdownAlert: 93,
	countdown: 90,
	served: 85,
	dataAlert: 80,
	sentConflict: 75,
	warmNote: 60,
	warmGoal: 42,
	inUse: 55,
	price: 50,
	offline: 45,
	other: 40,
	guess: 35,
	sent: 30,
	noEntry: 20,
} as const;

const segment = (text: string, tone?: Tone): Segment => (tone ? { text, tone } : { text });
/** A part whose renderings are each one piece of text in one tone. */
const plainPart = (priority: number, texts: string[], tone?: Tone, keep = false): Part => ({
	forms: texts.map((text) => [segment(text, tone)]),
	priority,
	...(keep ? { keep } : {}),
	...(texts.at(-1) === ALERT ? { lastResort: true } : {}),
});

/** "5m", "1h", "150s": the countdown's units, in every rendering, so one line never mixes "1 h" and "1h". */
export function lifetimeText(seconds: number): string {
	const s = Math.round(seconds);
	if (s % 3600 === 0) return `${s / 3600}h`;
	if (s % 60 === 0) return `${s / 60}m`;
	return `${s}s`;
}
/** A price per million tokens: "$5", "$0.25", "$37.5". */
const usd = (amount: number) => `$${amount >= 100 ? Math.round(amount) : Number(amount.toPrecision(3))}`;
const tokenCount = (count: number) => (count >= 1_000_000 ? `${Number((count / 1_000_000).toFixed(1))}M` : count >= 1000 ? `${Math.round(count / 1000)}k` : String(count));
/** How old the saved data is: "40m", "26h", "3d". */
function ageText(ms: number): string {
	if (ms < 2 * 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m`;
	if (ms < 48 * 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
	return `${Math.round(ms / 86_400_000)}d`;
}

// ------------------------------------------------------------------------------------------------- what is shown

/** The cache countdown: warm with the time left, cold, in use while a request runs, or being refreshed. */
export type Countdown = { state: "warm"; ms: number } | { state: "cold" } | { state: "running" } | { state: "refreshing" };

/**
 * Keeping the cache warm, where it matters to the user: two missed refreshes left the model to Pi's own warming (until
 * /cache-keeper-warm), warming ended for this idle period and why (with the amounts), the period is left to Pi's own
 * warming and why, or keep-warm was switched on during a period and starts with the next message.
 */
export type KeepWarmView =
	| { fallback: true }
	| { ended: { stop: WarmStop; limit: string; amounts: string } }
	| { leftToPi: string }
	| { pending: true }
	| { goal: WarmGoal };

/**
 * Keep-warm is on and nothing above applies: the goal (`minutes`, the setting in force). While the extension keeps this
 * idle period warm, also when the time limit runs out (`until`, the period's idle start plus the limit) and what the
 * period has spent of its budget (dollars against one cache miss, or refreshes against the most without prices).
 */
export interface WarmGoal {
	minutes: number;
	until?: number;
	budget?: { spent: string; of: string; refreshes?: true };
}

/** A cache lifetime in use: seconds when known; a guess (the smaller of values that differ, ⚠) or only partly found (?, not used). */
export interface LifetimeValue {
	seconds?: number;
	mark?: "guess" | "partial";
}
/** The two cache lifetimes of the model and the tier in use (none for Claude through pi-claude-bridge: Claude Code picks it). */
export interface LifetimesView {
	inUse?: Tier;
	short: LifetimeValue;
	long: LifetimeValue;
}

/**
 * What the last request asked the provider's cache for, read from its cache markers (see requestCache): no marker (the
 * provider's default cache), one it cannot read, or the lifetimes the markers state and the tiers they ask for without
 * stating one (a lifetime the request does not state, such as Anthropic's 5-minute default, is not shown as sent).
 * `conflict`: the lifetime it asked for is not the one in use, so the countdown may not follow the cache the request
 * asked for; or the markers are mixed or unreadable. `retention`: the retention in force, when the request asked for
 * another tier.
 */
export interface SentView {
	what: "none" | "unreadable" | { lifetimes: number[]; tiers: Tier[] };
	conflict: boolean;
	retention?: Tier;
}

/**
 * The price in use: how the model is reached, whether it is billed by subscription, and the input and output price per
 * million tokens at the current context size (`above`: the size a tier of the price starts at), or, without a price,
 * whether providers.dev had one for only some of the possible credentials (`partial`). On a subscription the prices are
 * the ones the extension counts with (the keep-warm budget, the compaction card), not what is billed per token; without
 * any, there is no per-token price.
 */
export interface PriceView {
	via?: Via;
	subscription?: boolean;
	rates?: { input: number; output: number; above?: number };
	partial?: boolean;
}

/**
 * providers.dev: never fetched because the fetch failed or Pi runs with PI_OFFLINE, the saved data shown after a refresh
 * failed (`staleMs`: its age), no entry for this model, an answer from another kind of credential than the values are
 * for, and values that are guesses because the login or API key is not known (`access`) or has no entry of its own (`login`).
 */
export interface DataView {
	fetch?: "failed" | "offline";
	staleMs?: number;
	noEntry?: boolean;
	served?: Via;
	guess?: "access" | "login";
}

export interface FooterView {
	countdown?: Countdown;
	/**
	 * The tier the countdown runs on, where it is not the current model's own: with keep-warm off the countdown takes
	 * the tier the latest answer of any model reported, which after a model switch can be another model's.
	 */
	countdownTier?: Tier;
	keepWarm?: KeepWarmView;
	lifetimes?: LifetimesView;
	sent?: SentView;
	price?: PriceView;
	data?: DataView;
}

/**
 * The lifetimes to show: the one the countdown runs on for the tier in use (`inUse.seconds`, which may come from the
 * provider's report or a family's documented lifetime), else the model's declared lifetime for the tier (Pi's catalog,
 * your override, or providers.dev's value written into models.json). `found` marks a value that is providers.dev's
 * guess, or a tier only some of the possible entries have.
 */
export function lifetimesView(declared: { short?: number; long?: number } | undefined, inUse: { tier?: Tier; seconds?: number }, found?: Found): LifetimesView {
	const states = found && found.refs.length > 0 ? fieldStates(found) : undefined;
	const value = (tier: Tier): LifetimeValue => {
		const seconds = tier === inUse.tier && inUse.seconds !== undefined ? inUse.seconds : declared?.[tier];
		if (seconds !== undefined) return states?.[tier] === "assumed" && seconds === usableLifetime(found?.facts[tier]) ? { seconds, mark: "guess" } : { seconds };
		return states?.[tier] === "unsure" ? { mark: "partial" } : {};
	};
	return { ...(inUse.tier ? { inUse: inUse.tier } : {}), short: value("short"), long: value("long") };
}

/**
 * The tier the footer marks "(in use)". A request asks for a tier; how long a tier lasts is the route's (its model data);
 * an answer reports the write bucket the provider used (5 minutes or 1 hour), which is the tier's name only on
 * Anthropic's own API: a route can write its short tier as a one-hour cache. So:
 * - the tier the request asked for (`asked`), where this route's lifetime for it is the one the countdown runs on;
 * - without a request the extension read (after /reload, /resume, /fork, a compaction or /tree, or a form whose markers
 *   it does not read): the tier whose lifetime on this route is the countdown's, and where both tiers have it, the
 *   retention in force (what the next request asks for);
 * - otherwise `fallback`, the tier the countdown runs on as the answer's bucket names it (a stated hour the provider
 *   wrote as 5 minutes reads as the 5-minute tier, and "sent" warns).
 * `route` is in seconds, `countdownMs` in milliseconds.
 */
export function tierInUse(o: { asked?: Tier; countdownMs?: number; route?: { short?: number; long?: number }; retention: Tier; fallback?: Tier }): Tier | undefined {
	const routeMs = (tier: Tier) => (o.route?.[tier] === undefined ? undefined : (o.route[tier] as number) * 1000);
	if (o.countdownMs !== undefined) {
		if (o.asked) {
			if (routeMs(o.asked) === o.countdownMs) return o.asked;
		} else {
			const matching = (["short", "long"] as const).filter((tier) => routeMs(tier) === o.countdownMs);
			if (matching.length === 1) return matching[0];
			if (matching.length === 2) return o.retention;
		}
	}
	return o.fallback;
}

/**
 * What the request asked for, against the lifetime in use (`inUse`), this route's lifetimes in seconds (`declared`), and
 * the retention in force. The lifetime asked for is the one the request states, else the route's lifetime for the tier
 * it asks; where neither is known there is nothing to compare, and different tier names alone are not a difference.
 */
export function sentView(
	cache: { tier: Tier; markers: CacheMarker[]; unreadable?: string; mixed: boolean },
	inUse: { tier?: Tier; ms?: number },
	declared: { short?: number; long?: number } | undefined,
	retention: Tier,
): SentView {
	const counted = inUse.ms !== undefined;
	if (cache.unreadable) return { what: "unreadable", conflict: counted };
	// Only a lifetime the request states; a provider's default for a marker that states none is not one.
	const statedMs = (m: CacheMarker) => (m.implied ? undefined : m.ms);
	const lifetimes = [...new Set(cache.markers.flatMap((m) => (statedMs(m) === undefined ? [] : [statedMs(m) as number])))].sort((a, b) => a - b);
	// A tier is named only where no marker for it states a lifetime.
	const stated = new Set(cache.markers.flatMap((m) => (statedMs(m) !== undefined && m.tier ? [m.tier] : [])));
	const tiers = [...new Set(cache.markers.flatMap((m) => (statedMs(m) === undefined && m.tier && !stated.has(m.tier) ? [m.tier] : [])))].sort().reverse() as Tier[];
	const what: SentView["what"] = cache.markers.length === 0 ? "none" : { lifetimes, tiers };
	// The lifetime asked for: the one stated, else this route's for the tier asked.
	const seconds = declared?.[cache.tier];
	const ms = cache.mixed ? undefined : (lifetimes[0] ?? (seconds === undefined ? undefined : seconds * 1000));
	const conflict = counted && (cache.mixed || (ms !== undefined && ms !== inUse.ms));
	return { what, conflict, ...(!conflict && cache.tier !== retention ? { retention } : {}) };
}

/** The input and output price for a context of `tokens`: the highest tier whose threshold it passes, as Pi prices it. */
export function priceAt(cost: { input: number; output: number; tiers?: Array<{ inputTokensAbove: number; input: number; output: number }> }, tokens?: number): NonNullable<PriceView["rates"]> {
	const tier = tokens === undefined ? undefined : [...(cost.tiers ?? [])].sort((a, b) => b.inputTokensAbove - a.inputTokensAbove).find((one) => tokens > one.inputTokensAbove);
	return tier ? { input: tier.input, output: tier.output, above: tier.inputTokensAbove } : { input: cost.input, output: cost.output };
}

// ------------------------------------------------------------------------------------------------------ the parts

function countdownPart(countdown: Countdown): Part {
	switch (countdown.state) {
		case "warm": {
			const tone = countdown.ms <= WARNING_MS ? "warning" : undefined;
			return plainPart(PRIORITY.countdown, [formatCacheStatus(countdown.ms), `warm ${formatRemaining(countdown.ms)}`], tone, true);
		}
		case "cold":
			return plainPart(PRIORITY.countdown, [formatCacheStatus(0), "cold: full price", "cold"], "dim", true);
		case "running":
			return plainPart(PRIORITY.countdown, ["cache in use", "in use"], "dim", true);
		case "refreshing":
			return plainPart(PRIORITY.countdown, ["cache warm · refreshing", "refreshing"], undefined, true);
	}
}

const ENDED_SHORT: Record<WarmStop, (limit: string) => string> = {
	budget: () => "budget",
	limit: (limit) => `${limit} limit`,
	missed: () => "a refresh missed",
	failed: () => "a refresh failed",
	unable: () => "can't re-send",
	unknown: () => "cost unknown",
	// Never shown: a stopped period's footer says the stop in its own part, in this one's place.
	stopped: () => "stopped",
};
const ENDED_TINY: Partial<Record<WarmStop, string>> = { missed: "keep-warm missed", failed: "keep-warm failed", unable: "keep-warm stopped", unknown: "keep-warm stopped" };

function keepWarmPart(view: KeepWarmView): Part {
	if ("fallback" in view) {
		return plainPart(PRIORITY.warmAlert, ["⚠ keep-warm: Pi's after 2 refreshes without a hit (/cache-keeper-warm)", "⚠ keep-warm: Pi's after 2 without a hit", "⚠ keep-warm: Pi's", ALERT], "warning");
	}
	if ("ended" in view) {
		const { stop, limit, amounts } = view.ended;
		const wide = `keep-warm ended (${stopLabel(stop, limit)}): ${amounts}`;
		const mid = `keep-warm ended: ${ENDED_SHORT[stop](limit)}`;
		const tiny = ENDED_TINY[stop];
		// The budget and the time limit are the rule at work; the others are something gone wrong.
		return tiny ? plainPart(PRIORITY.warmAlert, [`⚠ ${wide}`, `⚠ ${mid}`, `⚠ ${tiny}`, ALERT], "warning") : plainPart(PRIORITY.warmNote, [wide, mid], "muted");
	}
	if ("leftToPi" in view) return plainPart(PRIORITY.warmNote, [`keep-warm: Pi's (${view.leftToPi})`, "keep-warm: Pi's"], "muted");
	if ("goal" in view) return goalPart(view.goal, true);
	return plainPart(PRIORITY.warmNote, ["keep-warm: from your next message", "keep-warm: next message"], "muted");
}

/** The keep-warm limit as the line writes times: "30m", "2h", "1h30m". */
const goalText = (minutes: number) => (minutes < 60 ? `${minutes}m` : minutes % 60 === 0 ? `${minutes / 60}h` : `${Math.floor(minutes / 60)}h${minutes % 60}m`);
/** A clock time, "16:40", or "tomorrow 09:10": never a duration, so it is not read as the cache's time left. */
export const clockText = (ms: number) => {
	const at = new Date(ms);
	const time = at.toTimeString().slice(0, 5);
	return at.toDateString() === new Date(Date.now()).toDateString() ? time : `tomorrow ${time}`;
};

/**
 * The goal. Where the period is kept warm (`active`: a warm cache, not run out), until when and the budget spent;
 * otherwise only the setting, so it never reads as a goal being met.
 */
function goalPart(goal: WarmGoal, active: boolean): Part {
	const setting = `keep-warm ${goalText(goal.minutes)}`;
	if (!active || goal.until === undefined || goal.until <= Date.now()) return plainPart(PRIORITY.warmGoal, [setting], "muted");
	const until = `until ${clockText(goal.until)}`;
	const budget = goal.budget;
	const wide = budget ? (budget.refreshes ? `${budget.spent} of ${budget.of} refreshes` : `${budget.spent} spent of ${budget.of}`) : undefined;
	const mid = budget ? `${budget.spent}/${budget.of}` : undefined;
	return plainPart(PRIORITY.warmGoal, [`${setting} ${until}${wide ? `, ${wide}` : ""}`, `keep-warm ${until}${mid ? `, ${mid}` : ""}`, `keep-warm ${until}`], "muted");
}

function lifetimeParts(view: LifetimesView): Part[] {
	const { short, long } = view;
	if (short.seconds === undefined && long.seconds === undefined && !short.mark && !long.mark) {
		return [plainPart(PRIORITY.inUse, ["cache lifetime unknown", "lifetime unknown", "lifetime –"], "muted")];
	}
	const one = (tier: Tier, value: LifetimeValue, inUse: boolean): Part => {
		const forms = [false, true].map((narrow): Form => {
			const known = value.seconds !== undefined;
			const text = known ? lifetimeText(value.seconds as number) : value.mark === "partial" ? "?" : narrow ? "–" : "unknown";
			const base: Tone | undefined = inUse ? undefined : "dim";
			const form: Form = [segment(`${tier} `, base), segment(text, !known ? (value.mark === "partial" ? "warning" : "dim") : base)];
			if (value.mark === "guess") form.push(segment(" ⚠", "warning"));
			if (inUse && !narrow) form.push(segment(" (in use)", "dim"));
			return form;
		});
		return { forms: forms[0].map((piece) => piece.text).join("") === forms[1].map((piece) => piece.text).join("") ? [forms[0]] : forms, priority: inUse ? PRIORITY.inUse : PRIORITY.other };
	};
	// The tier in use first; without one (Claude Code picks it), short then long.
	if (!view.inUse) return [one("short", short, false), one("long", long, false)].map((part, i) => ({ ...part, priority: i === 0 ? PRIORITY.inUse : PRIORITY.other }));
	const other: Tier = view.inUse === "long" ? "short" : "long";
	return [one(view.inUse, view[view.inUse], true), one(other, view[other], false)];
}

function sentPart(view: SentView): Part {
	const text = (narrow: boolean) => {
		if (view.what === "none") return narrow ? "default" : "default cache";
		if (view.what === "unreadable") return narrow ? "unreadable" : "a cache marker it can't read";
		return [...view.what.lifetimes.map((ms) => lifetimeText(ms / 1000)), ...view.what.tiers].join(narrow ? "+" : " + ");
	};
	if (view.conflict) return plainPart(PRIORITY.sentConflict, [`⚠ sent ${text(false)}`, `⚠ sent ${text(true)}`, ALERT], "warning");
	if (view.retention) return plainPart(PRIORITY.sent, [`sent ${text(false)} (retention ${view.retention})`, `sent ${text(true)}`], "muted");
	return plainPart(PRIORITY.sent, [`sent ${text(false)}`, `sent ${text(true)}`], "dim");
}

function pricePart(view: PriceView): Part {
	if (view.subscription) {
		if (view.rates) {
			// Counted at these prices, billed by the subscription.
			const { input, output, above } = view.rates;
			const amounts = `${usd(input)}/${usd(output)}`;
			const lead = view.via ? `${view.via}, ` : "";
			const per = ` per M${above === undefined ? "" : ` above ${tokenCount(above)}`}`;
			const forms: Form[] = [[segment(`${lead}counted at ${amounts}`, "muted"), segment(per, "dim")], [segment(`${lead}counted ${amounts}`, "muted")]];
			if (view.via) forms.push([segment(view.via, "muted")]);
			return { forms, priority: PRIORITY.price };
		}
		return view.via ? plainPart(PRIORITY.price, [`${view.via}, no per-token price`, view.via], "muted") : plainPart(PRIORITY.price, ["no per-token price"], "muted");
	}
	const lead = view.via ? `${view.via} ` : "";
	const narrowLead = view.via === "sub or api" ? "sub/api " : view.via ? `${view.via} ` : "";
	if (view.rates) {
		const { input, output, above } = view.rates;
		const amounts = `${usd(input)}/${usd(output)}`;
		const wide: Form = [segment(`${lead}${amounts}`), segment(` per M${above === undefined ? "" : ` above ${tokenCount(above)}`}`, "dim")];
		return { forms: [wide, [segment(`${narrowLead}${amounts}`)]], priority: PRIORITY.price };
	}
	const comma = view.via ? `${view.via}, ` : "";
	if (view.partial) return { forms: [[segment(`${comma}price `), segment("?", "warning")], [segment(`${narrowLead}$`), segment("?", "warning")]], priority: PRIORITY.price };
	return { forms: [[segment(comma), segment("price unknown", "dim")], [segment(narrowLead), segment("$–", "dim")]], priority: PRIORITY.price };
}

const SERVED: Record<Via, [string, string]> = { api: ["an API key", "API key"], sub: ["a login", "login"], "sub or api": ["another account", "other account"] };

/** The line's parts, in reading order. */
export function footerParts(view: FooterView): Part[] {
	const parts: Part[] = [];
	const { data } = view;
	if (view.countdown) parts.push(countdownPart(view.countdown));
	// Only beside a countdown that says how long the cache lasts.
	if (view.countdownTier && (view.countdown?.state === "warm" || view.countdown?.state === "cold")) {
		parts.push(plainPart(PRIORITY.countdownAlert, [`⚠ countdown on another model's ${view.countdownTier} tier`, "⚠ countdown: other model", ALERT], "warning"));
	}
	const warm = view.keepWarm ? keepWarmPart(view.keepWarm) : undefined;
	if (warm && warm.priority === PRIORITY.warmAlert) parts.push(warm);
	if (data?.served) {
		const [wide, narrow] = SERVED[data.served];
		parts.push(plainPart(PRIORITY.served, [`⚠ answered by ${wide}`, `⚠ ${narrow} answered`, ALERT], "warning"));
	}
	if (data?.fetch === "failed") parts.push(plainPart(PRIORITY.dataAlert, ["⚠ providers.dev: no data, fetch failed", "⚠ providers.dev failed", ALERT], "warning"));
	if (data?.staleMs !== undefined) {
		parts.push(plainPart(PRIORITY.dataAlert, [`⚠ providers.dev refresh failed: data ${ageText(data.staleMs)} old`, `⚠ data ${ageText(data.staleMs)} old`, ALERT], "warning"));
	}
	// The goal says how far the period stands only beside a warm cache: not while a request runs or once it is cold.
	const kept = view.countdown?.state === "warm" || view.countdown?.state === "refreshing";
	if (view.keepWarm && "goal" in view.keepWarm && !kept) parts.push(goalPart(view.keepWarm.goal, false));
	else if (warm && warm.priority !== PRIORITY.warmAlert) parts.push(warm);
	if (view.lifetimes) parts.push(...lifetimeParts(view.lifetimes));
	if (view.sent) parts.push(sentPart(view.sent));
	if (view.price) parts.push(pricePart(view.price));
	if (data?.guess) {
		const why = data.guess === "login" ? "no entry for this login" : "login or API key unknown";
		parts.push(plainPart(PRIORITY.guess, [`⚠ ${why}: shorter values`, "⚠ shorter values"], "warning"));
	}
	if (data?.fetch === "offline") parts.push(plainPart(PRIORITY.offline, ["providers.dev: no data (PI_OFFLINE)", "PI_OFFLINE"], "muted"));
	if (data?.noEntry) parts.push(plainPart(PRIORITY.noEntry, ["providers.dev: no data for this model"], "dim"));
	return parts;
}

// ------------------------------------------------------------------------------------------------------ the fitting

const formWidth = (form: Form) => form.reduce((sum, piece) => sum + visibleWidth(piece.text), 0);

/**
 * Which rendering of each part fits `width` columns (undefined: dropped). The least important parts are narrowed first,
 * all the way, then the least important are dropped (an error is cut to its bare mark instead, once everything less
 * important has gone; one bare mark stands for all the errors cut to it). Then, from the most important down, a dropped part that fits again comes back, narrowest; and
 * then each part takes back the widest rendering that fits, until one cannot, so a less important part is never worded
 * more fully than a more important one could be. A line that does not fit even so keeps the countdown's narrowest, and
 * Pi cuts it.
 */
export function fitParts(parts: Part[], width: number): Array<number | undefined> {
	const chosen: Array<number | undefined> = parts.map(() => 0);
	const total = () => {
		let sum = 0;
		let count = 0;
		parts.forEach((part, i) => {
			const form = chosen[i];
			if (form === undefined) return;
			sum += formWidth(part.forms[form]);
			count++;
		});
		return sum + Math.max(0, count - 1) * SEPARATOR.length;
	};
	const narrowest = (i: number) => parts[i].forms.length - (parts[i].lastResort ? 2 : 1);
	// Lowest priority first; of two alike, the later one.
	const order = parts.map((_, i) => i).sort((a, b) => parts[a].priority - parts[b].priority || b - a);
	for (const i of order) {
		while (total() > width && (chosen[i] as number) < narrowest(i)) chosen[i] = (chosen[i] as number) + 1;
	}
	const bare = (i: number) => parts[i].lastResort === true && chosen[i] === parts[i].forms.length - 1;
	for (const i of order) {
		if (total() <= width) break;
		if (parts[i].lastResort) {
			// One bare mark stands for every error cut to it: the most important one's.
			parts.forEach((_, j) => {
				if (bare(j)) chosen[j] = undefined;
			});
			chosen[i] = parts[i].forms.length - 1;
		}
		if (total() > width && !parts[i].keep) chosen[i] = undefined;
	}
	const top = [...order].reverse();
	// More of the line beats longer wording: what fits again comes back first.
	for (const i of top) {
		if (chosen[i] !== undefined) continue;
		chosen[i] = narrowest(i);
		if (total() > width) chosen[i] = undefined;
	}
	for (const i of top) {
		const current = chosen[i];
		if (current === undefined) continue;
		for (let form = 0; form < current; form++) {
			chosen[i] = form;
			if (total() <= width) break;
			chosen[i] = current;
		}
		if (chosen[i] !== 0) break;
	}
	return chosen;
}

/** The footer text, fitted to `width` columns; `paint` colours a segment in its tone. Undefined when there is nothing to show. */
export function formatFooter(view: FooterView, width = Number.POSITIVE_INFINITY, paint: (text: string, tone: Tone) => string = (text) => text): string | undefined {
	const parts = footerParts(view);
	if (parts.length === 0) return undefined;
	const chosen = fitParts(parts, width);
	const shown = parts.flatMap((part, i) => {
		const form = chosen[i];
		return form === undefined ? [] : [part.forms[form].map((piece) => (piece.tone ? paint(piece.text, piece.tone) : piece.text)).join("")];
	});
	return shown.join(SEPARATOR);
}
