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
	/** Read each model's input window, cache lifetimes and prices from providers.dev and put them into pi's models.json. */
	modelData: boolean;
}

const DEFAULTS: CacheKeeperConfig = { cacheRetention: "long", compactBeforeExpiry: true, minContextTokens: 140_000, compactAtPercent: 90, compactAtTokens: 0, keepWarmMinutes: 0, modelData: true };

/** The values `/cache-keeper-settings` offers for compactAtPercent; 0 is "off". */
export const COMPACT_AT_PERCENTS = [0, 50, 60, 70, 75, 80, 85, 90, 95];
/** The values `/cache-keeper-settings` offers for compactAtTokens; 0 is "off". */
export const COMPACT_AT_TOKEN_CHOICES = [0, 150_000, 200_000, 300_000, 400_000, 500_000, 600_000, 800_000];
/** The values `/cache-keeper-settings` offers for minContextTokens. */
export const MIN_CONTEXT_CHOICES = [50_000, 100_000, 140_000, 200_000, 300_000, 500_000];
/** The values `/cache-keeper-settings` offers for keepWarmMinutes; 0 is "off". */
export const KEEP_WARM_CHOICES = [0, 30, 60, 120, 180, 240, 360, 480, 720, 1440];
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
		modelData = DEFAULTS.modelData,
	} = raw;
	const values = { cacheRetention, compactBeforeExpiry, minContextTokens, compactAtPercent, compactAtTokens, keepWarmMinutes, modelData };
	for (const name of Object.keys(DEFAULTS) as (keyof CacheKeeperConfig)[]) {
		const problem = valueProblem(name, values[name]);
		if (problem) throw new Error(`${key}.${name} in ${path} ${problem}`);
	}
	return values as CacheKeeperConfig;
}

const wholeNumber = (value: unknown, max = Infinity): boolean => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;

/** What is wrong with a value of a setting ("must be …"), or undefined when it is valid. */
function valueProblem(name: keyof CacheKeeperConfig, value: unknown): string | undefined {
	switch (name) {
		case "cacheRetention":
			return value === "short" || value === "long" ? undefined : 'must be "short" or "long"';
		case "compactBeforeExpiry":
		case "modelData":
			return typeof value === "boolean" ? undefined : "must be true or false";
		case "minContextTokens":
			return wholeNumber(value) ? undefined : "must be a whole number of tokens";
		case "compactAtPercent":
			return wholeNumber(value, 99) ? undefined : "must be a whole percentage from 1 to 99, or 0 for off";
		case "compactAtTokens":
			return wholeNumber(value) ? undefined : "must be a whole number of tokens, or 0 for off";
		case "keepWarmMinutes":
			return wholeNumber(value, 1440) ? undefined : "must be a whole number of minutes from 0 (off) to 1440";
	}
}

/**
 * The settings a session can set for itself, over the defaults: its own value wins for each key it set, every other key
 * follows the defaults. cacheRetention (the process-wide PI_CACHE_RETENTION) and modelData (Pi's models.json) are the
 * same for every session.
 */
export const SESSION_KEYS = ["compactAtPercent", "compactAtTokens", "compactBeforeExpiry", "minContextTokens", "keepWarmMinutes"] as const;
export type SessionKey = (typeof SESSION_KEYS)[number];
export type SessionSettings = Partial<Pick<CacheKeeperConfig, SessionKey>>;
/** The settings that stay the same for every session. */
export const GLOBAL_ONLY_KEYS = ["cacheRetention", "modelData"] as const;
const isSessionKey = (name: string): name is SessionKey => (SESSION_KEYS as readonly string[]).includes(name);

/**
 * The custom entry (Pi's `appendEntry`, never sent to the model) that holds a session's own settings: `{ settings }`,
 * the whole set of the session's own values. The latest one on the current branch decides; `{ settings: {} }` is "back
 * to the defaults".
 */
export const SESSION_SETTINGS_TYPE = "cache-keeper-settings";

/**
 * The session's own values from one entry's data: only keys a session may set, with valid values. Anything else (a
 * global-only key, an unknown key, a bad value: a hand-edited file or another version) is left out and named.
 */
export function readSessionSettings(data: unknown): { settings: SessionSettings; ignored: string[] } {
	const raw = isPlainObject(data) && isPlainObject(data.settings) ? data.settings : {};
	const settings: Record<string, unknown> = {};
	const ignored: string[] = [];
	for (const [name, value] of Object.entries(raw)) {
		if (isSessionKey(name) && valueProblem(name, value) === undefined) settings[name] = value;
		else ignored.push(name);
	}
	return { settings: settings as SessionSettings, ignored };
}

interface BranchEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

/** The session's own values on a branch (root to leaf): those of its latest settings entry, none without one. */
export function sessionSettingsOn(branch: readonly BranchEntry[]): SessionSettings {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type === "custom" && entry.customType === SESSION_SETTINGS_TYPE) return readSessionSettings(entry.data).settings;
	}
	return {};
}

/** The settings in effect: the session's own value for each key it set, the defaults for every other. */
export function settingsInEffect(defaults: CacheKeeperConfig, own: SessionSettings): CacheKeeperConfig {
	const merged = { ...defaults };
	for (const name of SESSION_KEYS) if (own[name] !== undefined) (merged as Record<string, unknown>)[name] = own[name];
	return merged;
}

/**
 * The session's own values with one key set (a value) or dropped (undefined), checked: a global-only or unknown key, or
 * a bad value, throws, and nothing changes.
 */
export function withSessionValue(own: SessionSettings, name: string, value: unknown): SessionSettings {
	if ((GLOBAL_ONLY_KEYS as readonly string[]).includes(name)) throw new Error(`${name} is the same for every session: change it in the defaults`);
	if (!isSessionKey(name)) throw new Error(`${name} is not a setting a session can set`);
	const next: SessionSettings = { ...own };
	if (value === undefined) {
		delete next[name];
		return next;
	}
	const problem = valueProblem(name, value);
	if (problem) throw new Error(`${name} ${problem}`);
	(next as Record<string, unknown>)[name] = value;
	return next;
}

/** Whether two sets of a session's own values are the same. */
export function sameSessionSettings(a: SessionSettings, b: SessionSettings): boolean {
	return SESSION_KEYS.every((name) => a[name] === b[name]);
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
