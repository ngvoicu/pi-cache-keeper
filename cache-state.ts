import type { Api, Model, OpenAICompletionsCompat, OpenAIResponsesCompat } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { FIVE_MINUTES_MS, ONE_HOUR_MS, written, writtenMs, type Written } from "./lifetime-evidence.ts";

const REPORTED_TIER_SECONDS = { short: 300, long: 3600 } as const;

const OPENAI_MIN_LIFETIME_SECONDS = 1800;
const KIMI_TTL_SECONDS = { short: 300, long: 3600 } as const;

export function hasExplicitPromptCache(model: Model<Api>): boolean {
	return model.api === "openai-responses" && (model.compat as OpenAIResponsesCompat | undefined)?.supportsExplicitPromptCacheMode === true;
}

export function isKimiOnMoonshot(model: Model<Api>): boolean {
	return model.api === "openai-completions" && /^https:\/\/api\.moonshot\.(ai|cn)\//.test(model.baseUrl) && model.id.startsWith("kimi-k3");
}

export interface CacheState {
	lifetime?: { ms: number; source: string };
	cached: boolean;
	expiresAt?: number;
	/** When the cache was last read or written: the answer, or a later refresh (Pi's or this extension's). */
	refreshedAt?: number;
	replied: boolean;
	/**
	 * When the latest answer arrived: the latest assistant message whose usage reports a cache read or write, whatever
	 * its stop reason (an aborted answer that read the cache counts), or a later successful one that reports none (then
	 * `cached` is false). Refreshes (Pi's or this extension's) do not move it. A new value means a request has gone to
	 * the provider since: a new keep-warm period.
	 */
	answeredAt?: number;
	/** That answer's prompt: input + cache read + cache write tokens. */
	answerPrompt?: number;
	/** With keep-warm on: the write buckets that answer reports, as lifetimes (5 minutes, 1 hour), where it reports them. */
	answerBuckets?: number[];
	/** With keep-warm on: what that answer wrote (see lifetime-evidence.ts). */
	answerWritten?: Written;
	/**
	 * With keep-warm on: what the latest cache write of the model's own answers wrote, up to and including that answer,
	 * where one reported which cache (a write in both stays until an answer reports a write in one cache only).
	 */
	latestWritten?: Written;
	/**
	 * With keep-warm on: what Pi's refreshes wrote after that answer started (`cache_warm` entries of the model's
	 * provider). A later answer that wrote is a new answer itself.
	 */
	piRefreshes?: Written[];
}

/**
 * The lifetime the route's data gives the tier a request asks for (`asked`): declared for it (Pi's catalog, models.json,
 * providers.dev's values written there); else a lifetime assumed for the model family (OpenAI's 30-minute minimum,
 * Kimi's 5 minutes or 1 hour). Nothing an answer reported.
 */
export function lifetimeFor(model: Model<Api>, asked: "short" | "long"): CacheState["lifetime"] {
	const declared = model.promptCache?.[asked];
	if (declared !== undefined) return { ms: declared * 1000, source: "declared by the model" };
	if (hasExplicitPromptCache(model)) return { ms: OPENAI_MIN_LIFETIME_SECONDS * 1000, source: "OpenAI's minimum" };
	if (isKimiOnMoonshot(model)) {
		const long = asked === "long" && (model.compat as OpenAICompletionsCompat | undefined)?.supportsLongCacheRetention !== false;
		return { ms: KIMI_TTL_SECONDS[long ? "long" : "short"] * 1000, source: long ? "Kimi's 1-hour option" : "Kimi's default" };
	}
	return undefined;
}

/**
 * The lifetime a request's cache lasts, by the evidence: the answer's write bucket where one reported it (the 1-hour
 * write an hour, a write with nothing in the 1-hour cache five minutes, whatever the data says for either tier; with the
 * data's source where the data gives the tier asked that same lifetime), else the route's data for the tier the request
 * asked for (`lifetimeFor`).
 */
export function evidencedLifetime(model: Model<Api>, asked: "short" | "long", latest: Written | undefined): CacheState["lifetime"] {
	const data = lifetimeFor(model, asked);
	const bucketMs = latest === "hour" || latest === "five minutes" ? writtenMs(latest) : undefined;
	if (bucketMs === undefined) return data;
	return data?.ms === bucketMs ? data : { ms: bucketMs, source: "reported by the provider" };
}

/** The lifetime counted with keep-warm off, as before: the data for the tier the answer's bucket is named after. */
function namedLifetime(model: Model<Api>, tier: "short" | "long", reported: boolean, asked: "short" | "long"): CacheState["lifetime"] {
	const declared = model.promptCache?.[tier];
	if (declared !== undefined) return { ms: declared * 1000, source: "declared by the model" };
	if (reported) return { ms: REPORTED_TIER_SECONDS[tier] * 1000, source: "reported by the provider" };
	return lifetimeFor(model, asked);
}

/**
 * The cache tier in use: the one the latest cache write reported (Anthropic says which it wrote), else `requested` (the
 * tier a request was sent with), else the one Pi asks for now. A compaction starts over.
 */
export function cacheTier(entries: SessionEntry[], model?: { provider: string; id: string }, requested?: "short" | "long"): "short" | "long" {
	let reported: "short" | "long" | undefined;
	for (const entry of entries) {
		if (entry.type === "compaction") reported = undefined;
		else if (entry.type === "message" && entry.message.role === "assistant") {
			// Given a model, only its own answers: another model's cache is another cache.
			if (model && (entry.message.provider !== model.provider || entry.message.model !== model.id)) continue;
			const { cacheWrite, cacheWrite1h } = entry.message.usage;
			if (cacheWrite > 0 && cacheWrite1h !== undefined) reported = cacheWrite1h > 0 ? "long" : "short";
		}
	}
	return reported ?? requested ?? (process.env.PI_CACHE_RETENTION === "long" ? "long" : "short");
}

/**
 * `warmedAt` is when the latest of the current period's refreshes by this extension that reported a hit left (a period
 * the extension kept warm before it was left to Pi). Pi's own refreshes are `cache_warm` usage entries; the extension's
 * are kept in memory, because an extension cannot add usage entries. A period the extension keeps warm does not count its
 * expiry here (see `expiryOf` in warm-period.ts).
 * `keepWarmOn` changes three things, so the countdown follows the cache the period keeps warm; with it off everything
 * is counted as before:
 * - the expiry is counted from the latest real answer, so a failed or aborted answer whose usage reports a cache read
 *   or write moves it too (otherwise such an answer is skipped);
 * - a `cache_warm` entry later than the answer counts wherever it sits: Pi appends an answer when it has finished
 *   streaming, with the timestamp of its start, so Pi's refresh during a long answer can come before it on the branch;
 * - the lifetime is the request's, by the evidence (`evidencedLifetime`): the write bucket the model's own latest
 *   cache write reported, where all of it went to one cache, else the data for the tier asked (`requested`, the tier the
 *   cached request was sent with, else the retention Pi asks for now); another model's cache is another cache;
 * - what was written is kept as reports for lifetime-evidence.ts: the answer's own, the model's latest, and Pi's
 *   refreshes after the answer (`answerWritten`, `latestWritten`, `piRefreshes`).
 */
// Pi's refreshes after the answer started: one is recorded when it settles, so one during a long answer can come before
// the answer on the branch (Pi appends an answer when it has finished, stamped with its start).
const after = (refreshes: { at: number; written: Written }[], answeredAt: number): Written[] => refreshes.filter((w) => w.at > answeredAt).map((w) => w.written);

export function cacheState(model: Model<Api>, entries: SessionEntry[], warmedAt?: number, keepWarmOn = false, requested?: "short" | "long"): CacheState {
	let refreshedAt: number | undefined;
	let latestWarm: number | undefined;
	let answer: { at: number; prompt: number; buckets?: number[]; written: Written } | undefined;
	let reported: "short" | "long" | undefined;
	let latest: Written | undefined;
	// What Pi's refreshes wrote, and when they were recorded.
	let later: { at: number; written: Written }[] = [];
	let replied = false;
	for (const entry of entries) {
		if (entry.type === "compaction") {
			refreshedAt = reported = answer = latestWarm = latest = undefined;
			later = [];
			replied = false;
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			const { input, cacheRead, cacheWrite, cacheWrite1h } = entry.message.usage;
			const own = !keepWarmOn || (entry.message.provider === model.provider && entry.message.model === model.id);
			if (own && cacheWrite > 0 && cacheWrite1h !== undefined) reported = cacheWrite1h > 0 ? "long" : "short";
			const wrote = written(entry.message.usage);
			if (own && wrote !== "nothing" && wrote !== "no breakdown") latest = wrote;
			const failed = entry.message.stopReason === "error" || entry.message.stopReason === "aborted";
			if (cacheRead + cacheWrite > 0 || !failed) {
				const buckets: number[] | undefined =
					cacheWrite > 0 && cacheWrite1h !== undefined ? [...(cacheWrite > cacheWrite1h ? [FIVE_MINUTES_MS] : []), ...(cacheWrite1h > 0 ? [ONE_HOUR_MS] : [])] : undefined;
				answer = { at: entry.message.timestamp, prompt: input + cacheRead + cacheWrite, ...(buckets ? { buckets } : {}), written: wrote };
			}
			// A failed request may not have reached the cache.
			if (entry.message.stopReason === "error" || entry.message.stopReason === "aborted") {
				if (keepWarmOn && cacheRead + cacheWrite > 0) refreshedAt = entry.message.timestamp;
				continue;
			}
			replied = true;
			refreshedAt = cacheRead + cacheWrite > 0 ? entry.message.timestamp : undefined;
		} else if (entry.type === "usage" && entry.kind === "cache_warm") {
			const at = Date.parse(entry.timestamp);
			latestWarm = Math.max(latestWarm ?? at, at);
			// Pi records its refresh under the model that answered it (a gateway may name another), so the provider decides.
			if (entry.usage && entry.provider === model.provider) later.push({ at, written: written(entry.usage) });
			if (refreshedAt !== undefined) refreshedAt = Math.max(refreshedAt, at);
		}
	}
	if (keepWarmOn && refreshedAt !== undefined && latestWarm !== undefined) refreshedAt = Math.max(refreshedAt, latestWarm);
	// A refresh before the latest real request (or before a compaction, which leaves refreshedAt unset) is stale.
	if (refreshedAt !== undefined && warmedAt !== undefined) refreshedAt = Math.max(refreshedAt, warmedAt);
	const asked = requested ?? (process.env.PI_CACHE_RETENTION === "long" ? "long" : "short");
	const lifetime = keepWarmOn ? evidencedLifetime(model, asked, latest) : namedLifetime(model, reported ?? asked, reported !== undefined, asked);
	const expiresAt = lifetime && refreshedAt !== undefined ? refreshedAt + lifetime.ms : undefined;
	return {
		lifetime,
		cached: refreshedAt !== undefined,
		expiresAt,
		...(refreshedAt === undefined ? {} : { refreshedAt }),
		replied,
		...(keepWarmOn && latest !== undefined ? { latestWritten: latest } : {}),
		...(answer
			? {
					answeredAt: answer.at,
					answerPrompt: answer.prompt,
					...(keepWarmOn && answer.buckets ? { answerBuckets: answer.buckets } : {}),
					...(keepWarmOn ? { answerWritten: answer.written } : {}),
					...(keepWarmOn ? { piRefreshes: after(later, answer.at) } : {}),
				}
			: {}),
	};
}
