import type { Api, Model, OpenAICompletionsCompat, OpenAIResponsesCompat } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

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
}

/**
 * The cache tier in use: the one the latest cache write reported (Anthropic says which it wrote), else the one Pi asks
 * for. A compaction starts over.
 */
export function cacheTier(entries: SessionEntry[], model?: { provider: string; id: string }): "short" | "long" {
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
	return reported ?? (process.env.PI_CACHE_RETENTION === "long" ? "long" : "short");
}

/**
 * `warmedAt` is when this extension last re-sent the cached request to keep it warm. Pi's own refreshes are
 * `cache_warm` usage entries; the extension's are kept in memory, because an extension cannot add usage entries.
 * `keepWarmOn` changes three things, so the countdown follows the cache the period keeps warm; with it off everything
 * is counted as before:
 * - the expiry is counted from the latest real answer, so a failed or aborted answer whose usage reports a cache read
 *   or write moves it too (otherwise such an answer is skipped);
 * - a `cache_warm` entry later than the answer counts wherever it sits: Pi appends an answer when it has finished
 *   streaming, with the timestamp of its start, so Pi's refresh during a long answer can come before it on the branch;
 * - the tier is the one the model's own answers reported (as `cacheTier` with a model): another model's cache is
 *   another cache.
 */
export function cacheState(model: Model<Api>, entries: SessionEntry[], warmedAt?: number, keepWarmOn = false): CacheState {
	let refreshedAt: number | undefined;
	let latestWarm: number | undefined;
	let answer: { at: number; prompt: number } | undefined;
	let reported: "short" | "long" | undefined;
	let replied = false;
	for (const entry of entries) {
		if (entry.type === "compaction") {
			refreshedAt = reported = answer = latestWarm = undefined;
			replied = false;
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			const { input, cacheRead, cacheWrite, cacheWrite1h } = entry.message.usage;
			const own = !keepWarmOn || (entry.message.provider === model.provider && entry.message.model === model.id);
			if (own && cacheWrite > 0 && cacheWrite1h !== undefined) reported = cacheWrite1h > 0 ? "long" : "short";
			const failed = entry.message.stopReason === "error" || entry.message.stopReason === "aborted";
			if (cacheRead + cacheWrite > 0 || !failed) answer = { at: entry.message.timestamp, prompt: input + cacheRead + cacheWrite };
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
			if (refreshedAt !== undefined) refreshedAt = Math.max(refreshedAt, at);
		}
	}
	if (keepWarmOn && refreshedAt !== undefined && latestWarm !== undefined) refreshedAt = Math.max(refreshedAt, latestWarm);
	// A refresh before the latest real request (or before a compaction, which leaves refreshedAt unset) is stale.
	if (refreshedAt !== undefined && warmedAt !== undefined) refreshedAt = Math.max(refreshedAt, warmedAt);
	const declared = model.promptCache?.[reported ?? (process.env.PI_CACHE_RETENTION === "long" ? "long" : "short")];
	let lifetime: CacheState["lifetime"];
	if (declared !== undefined) lifetime = { ms: declared * 1000, source: "declared by the model" };
	else if (reported) lifetime = { ms: REPORTED_TIER_SECONDS[reported] * 1000, source: "reported by the provider" };
	else if (hasExplicitPromptCache(model)) lifetime = { ms: OPENAI_MIN_LIFETIME_SECONDS * 1000, source: "OpenAI's minimum" };
	else if (isKimiOnMoonshot(model)) {
		const long = process.env.PI_CACHE_RETENTION === "long" && (model.compat as OpenAICompletionsCompat | undefined)?.supportsLongCacheRetention !== false;
		lifetime = { ms: KIMI_TTL_SECONDS[long ? "long" : "short"] * 1000, source: long ? "Kimi's 1-hour option" : "Kimi's default" };
	}
	const expiresAt = lifetime && refreshedAt !== undefined ? refreshedAt + lifetime.ms : undefined;
	return { lifetime, cached: refreshedAt !== undefined, expiresAt, ...(refreshedAt === undefined ? {} : { refreshedAt }), replied, ...(answer ? { answeredAt: answer.at, answerPrompt: answer.prompt } : {}) };
}
