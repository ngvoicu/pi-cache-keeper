import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { isPlainObject } from "./cached-request.ts";

export interface CacheKeeperConfig {
	cacheRetention: "short" | "long";
	compactBeforeExpiry: boolean;
	minContextTokens: number;
	/** Compact once the context fills this share of the model's window, 0 = off. */
	compactAtPercent: number;
	/** Compact once the context holds this many tokens, whatever the model's window, 0 = off. */
	compactAtTokens: number;
	/** Keep the prompt cache warm for this many minutes after Pi goes idle, 0 = off. */
	keepWarmMinutes: number;
}

const DEFAULTS: CacheKeeperConfig = { cacheRetention: "long", compactBeforeExpiry: true, minContextTokens: 140_000, compactAtPercent: 90, compactAtTokens: 0, keepWarmMinutes: 0 };

/** The values `/cache-keeper-settings` offers for compactAtPercent; 0 is "off". */
export const COMPACT_AT_PERCENTS = [0, 50, 60, 70, 75, 80, 85, 90, 95];
/** The values `/cache-keeper-settings` offers for compactAtTokens; 0 is "off". */
export const COMPACT_AT_TOKEN_CHOICES = [0, 150_000, 200_000, 300_000, 400_000, 500_000, 600_000, 800_000];
/** The values `/cache-keeper-settings` offers for minContextTokens. */
export const MIN_CONTEXT_CHOICES = [50_000, 100_000, 140_000, 200_000, 300_000, 500_000];
/** The values `/cache-keeper-settings` offers for keepWarmMinutes; 0 is "off". */
export const KEEP_WARM_CHOICES = [0, 30, 60, 120, 180, 240, 480];
/** A cached summary request needs at least this many output tokens; with less room, Pi's compaction runs instead. */
export const MIN_SUMMARY_TOKENS = 16_000;
/** Room kept free for the summary instruction and token-count drift between Pi's estimate and the provider's count. */
const PROMPT_MARGIN_TOKENS = 4_000;

const settingsPath = () => join(getAgentDir(), "settings.json");

function readSettings(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	const text = readFileSync(path, "utf8");
	return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

/** The key in pi's settings.json this extension reads and writes. */
export const SETTINGS_KEY = "cacheKeeper";
/** pi-cached-compaction's key: read when `cacheKeeper` is absent, so settings made for it keep working. Never written. */
export const LEGACY_SETTINGS_KEY = "cachedCompaction";

/** Which key the settings come from: `cacheKeeper`, else `cachedCompaction` when only that one is present. */
export function settingsKeyInUse(settings: Record<string, unknown> = readSettings(settingsPath())): string {
	return settings[SETTINGS_KEY] === undefined && settings[LEGACY_SETTINGS_KEY] !== undefined ? LEGACY_SETTINGS_KEY : SETTINGS_KEY;
}

export function loadConfig(): CacheKeeperConfig {
	const path = settingsPath();
	const settings = readSettings(path);
	const key = settingsKeyInUse(settings);
	const raw: unknown = settings[key];
	if (raw === undefined) return DEFAULTS;
	if (!isPlainObject(raw)) throw new Error(`${key} in ${path} must be an object`);
	const unknown = Object.keys(raw).filter((name) => !(name in DEFAULTS));
	if (unknown.length > 0) throw new Error(`${key} in ${path} has unknown keys: ${unknown.join(", ")}`);
	const {
		cacheRetention = DEFAULTS.cacheRetention,
		compactBeforeExpiry = DEFAULTS.compactBeforeExpiry,
		minContextTokens = DEFAULTS.minContextTokens,
		compactAtPercent = DEFAULTS.compactAtPercent,
		compactAtTokens = DEFAULTS.compactAtTokens,
		keepWarmMinutes = DEFAULTS.keepWarmMinutes,
	} = raw;
	if (cacheRetention !== "short" && cacheRetention !== "long") throw new Error(`${key}.cacheRetention in ${path} must be "short" or "long"`);
	if (typeof compactBeforeExpiry !== "boolean") throw new Error(`${key}.compactBeforeExpiry in ${path} must be true or false`);
	if (typeof minContextTokens !== "number" || !Number.isInteger(minContextTokens) || minContextTokens < 0) {
		throw new Error(`${key}.minContextTokens in ${path} must be a whole number of tokens`);
	}
	if (typeof compactAtPercent !== "number" || !Number.isInteger(compactAtPercent) || compactAtPercent < 0 || compactAtPercent > 99) {
		throw new Error(`${key}.compactAtPercent in ${path} must be a whole percentage from 1 to 99, or 0 for off`);
	}
	if (typeof compactAtTokens !== "number" || !Number.isInteger(compactAtTokens) || compactAtTokens < 0) {
		throw new Error(`${key}.compactAtTokens in ${path} must be a whole number of tokens, or 0 for off`);
	}
	if (typeof keepWarmMinutes !== "number" || !Number.isInteger(keepWarmMinutes) || keepWarmMinutes < 0 || keepWarmMinutes > 1440) {
		throw new Error(`${key}.keepWarmMinutes in ${path} must be a whole number of minutes from 0 (off) to 1440`);
	}
	return { cacheRetention, compactBeforeExpiry, minContextTokens, compactAtPercent, compactAtTokens, keepWarmMinutes };
}

/**
 * Writes the given keys into `cacheKeeper` in the global settings file, keeping every other setting, and returns the
 * new config. The first save copies the settings it was reading from `cachedCompaction`, which is left as it is.
 */
export function saveConfig(patch: Partial<CacheKeeperConfig>): CacheKeeperConfig {
	const path = settingsPath();
	const settings = readSettings(path);
	const source = settings[settingsKeyInUse(settings)];
	const current = isPlainObject(source) ? source : {};
	settings[SETTINGS_KEY] = { ...current, ...patch };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
	return loadConfig();
}

export function autoCompactionEnabled(trustedProjectDir: string | undefined): boolean {
	const enabled = (path: string) => (readSettings(path).compaction as { enabled?: unknown } | undefined)?.enabled;
	const project = trustedProjectDir === undefined ? undefined : enabled(join(trustedProjectDir, CONFIG_DIR_NAME, "settings.json"));
	return (project ?? enabled(settingsPath())) !== false;
}

interface WindowedModel {
	contextWindow: number;
	maxTokens: number;
}

/**
 * Output tokens a summary request may use: the model's output limit, reduced so the prompt and the summary fit the
 * context window (as Pi's own compaction does). Undefined when the model declares neither limit.
 */
export function summaryBudget(model: WindowedModel, promptTokens: number): number | undefined {
	const cap = model.maxTokens > 0 ? model.maxTokens : Infinity;
	const room = model.contextWindow > 0 ? model.contextWindow - promptTokens - PROMPT_MARGIN_TOKENS : Infinity;
	const budget = Math.min(cap, room);
	return Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : undefined;
}

/**
 * The context size at which compacting "when full" starts: `percent` of the model's window or the `tokens` cap,
 * whichever comes first. Undefined when both are off, or only the percentage is set and the window is unknown.
 */
export function fullThreshold(model: WindowedModel, percent: number, tokens = 0): number | undefined {
	const share = percent > 0 && model.contextWindow > 0 ? Math.floor((model.contextWindow * percent) / 100) : undefined;
	if (tokens <= 0) return share;
	return share === undefined ? tokens : Math.min(share, tokens);
}
