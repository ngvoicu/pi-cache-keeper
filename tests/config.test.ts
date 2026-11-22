import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { autoCompactionEnabled, fullThreshold, loadConfig, saveConfig, settingsKeyInUse, summaryBudget } from "../config.ts";

test("settings: compacting before expiry is on by default, a byte-order mark is allowed, unknown keys fail, and Pi's compaction switch is read project over global", () => {
	const dir = mkdtempSync(join(tmpdir(), "pcc-config-"));
	const settings = join(dir, "settings.json");
	const project = join(dir, "project");
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		assert.equal(loadConfig().compactBeforeExpiry, true);
		writeFileSync(settings, String.fromCharCode(0xfeff) + JSON.stringify({ cacheKeeper: { compactBeforeExpiry: false }, compaction: { enabled: false } }));
		assert.equal(loadConfig().compactBeforeExpiry, false);
		assert.equal(autoCompactionEnabled(undefined), false);
		writeFileSync(settings, JSON.stringify({ cacheKeeper: { compactBeforeExpiryy: true } }));
		assert.throws(loadConfig, /unknown keys: compactBeforeExpiryy/);
		assert.equal(autoCompactionEnabled(undefined), true);
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
		assert.equal(autoCompactionEnabled(project), false);
		writeFileSync(settings, JSON.stringify({ compaction: { enabled: false } }));
		writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ compaction: { enabled: true } }));
		assert.equal(autoCompactionEnabled(project), true);
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(dir, { recursive: true });
	}
});

test("settings: compacting when full is on at 90% by default, takes a whole percentage or 0, and saving keeps every other setting", () => {
	const dir = mkdtempSync(join(tmpdir(), "pcc-config-"));
	const settings = join(dir, "settings.json");
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		assert.equal(loadConfig().compactAtPercent, 90);
		for (const bad of [100, -1, 85.5, "90"]) {
			writeFileSync(settings, JSON.stringify({ cacheKeeper: { compactAtPercent: bad } }));
			assert.throws(loadConfig, /compactAtPercent .* whole percentage/);
		}
		writeFileSync(settings, JSON.stringify({ theme: "dark", compaction: { enabled: true }, cacheKeeper: { minContextTokens: 200_000 } }));
		const saved = saveConfig({ compactAtPercent: 80, cacheRetention: "short" });
		assert.deepEqual(saved, { cacheRetention: "short", compactBeforeExpiry: true, minContextTokens: 200_000, compactAtPercent: 80, compactAtTokens: 0, keepWarmMinutes: 0, modelData: true, fallbackCompactionModel: "" });
		assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), {
			theme: "dark",
			compaction: { enabled: true },
			cacheKeeper: { minContextTokens: 200_000, compactAtPercent: 80, cacheRetention: "short" },
		});
		assert.equal(saveConfig({ compactAtPercent: 0 }).compactAtPercent, 0);
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(dir, { recursive: true });
	}
});

test("a summary may use the model's output limit, reduced so prompt and summary fit the window; when full starts at the given share of the window", () => {
	const opus = { contextWindow: 1_000_000, maxTokens: 128_000 };
	// 2026-11-07: a 984k-token session had ~12k left, too little; at 90% a summary has ~96k.
	assert.equal(summaryBudget(opus, 984_000), 12_000);
	assert.equal(summaryBudget(opus, 900_000), 96_000);
	assert.equal(summaryBudget(opus, 200_000), 128_000);
	assert.equal(summaryBudget(opus, 1_200_000), 0);
	assert.equal(summaryBudget({ contextWindow: 0, maxTokens: 32_000 }, 500_000), 32_000);
	assert.equal(summaryBudget({ contextWindow: 0, maxTokens: 0 }, 500_000), undefined);
	assert.equal(fullThreshold(opus, 90), 900_000);
	assert.equal(fullThreshold({ contextWindow: 272_000, maxTokens: 128_000 }, 85), 231_200);
	assert.equal(fullThreshold(opus, 0), undefined);
	assert.equal(fullThreshold({ contextWindow: 0, maxTokens: 128_000 }, 90), undefined);
	// The token cap applies on any model; with the percentage, whichever comes first.
	assert.equal(fullThreshold(opus, 90, 400_000), 400_000);
	assert.equal(fullThreshold(opus, 30, 400_000), 300_000);
	assert.equal(fullThreshold({ contextWindow: 272_000, maxTokens: 128_000 }, 85, 400_000), 231_200, "a cap above a small window changes nothing");
	assert.equal(fullThreshold(opus, 0, 400_000), 400_000, "the cap alone");
	assert.equal(fullThreshold({ contextWindow: 0, maxTokens: 128_000 }, 90, 400_000), 400_000, "the cap needs no declared window");
	assert.equal(fullThreshold(opus, 0, 0), undefined);
});

test("settings: the token cap is off by default, takes a whole number of tokens, and is saved beside the percentage", () => {
	const dir = mkdtempSync(join(tmpdir(), "pcc-config-"));
	const settings = join(dir, "settings.json");
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		assert.equal(loadConfig().compactAtTokens, 0);
		for (const bad of [-1, 400_000.5, "400000", true]) {
			writeFileSync(settings, JSON.stringify({ cacheKeeper: { compactAtTokens: bad } }));
			assert.throws(loadConfig, /compactAtTokens .* whole number of tokens/);
		}
		writeFileSync(settings, JSON.stringify({ cacheKeeper: { compactAtPercent: 70 } }));
		const saved = saveConfig({ compactAtTokens: 400_000 });
		assert.equal(saved.compactAtTokens, 400_000);
		assert.equal(saved.compactAtPercent, 70);
		assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")).cacheKeeper, { compactAtPercent: 70, compactAtTokens: 400_000 });
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(dir, { recursive: true });
	}
});

test("settings: keeping the cache warm is off by default and takes whole minutes up to a day", () => {
	const dir = mkdtempSync(join(tmpdir(), "pcc-config-"));
	const settings = join(dir, "settings.json");
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		assert.equal(loadConfig().keepWarmMinutes, 0);
		writeFileSync(settings, JSON.stringify({ cacheKeeper: { keepWarmMinutes: 120 } }));
		assert.equal(loadConfig().keepWarmMinutes, 120);
		for (const bad of [-1, 1441, 1.5, "60", true]) {
			writeFileSync(settings, JSON.stringify({ cacheKeeper: { keepWarmMinutes: bad } }));
			assert.throws(loadConfig, /keepWarmMinutes .* whole number of minutes/);
		}
		writeFileSync(settings, JSON.stringify({ cacheKeeper: { minContextTokens: 200_000 } }));
		assert.equal(saveConfig({ keepWarmMinutes: 60 }).keepWarmMinutes, 60);
		assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")).cacheKeeper, { minContextTokens: 200_000, keepWarmMinutes: 60 });
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(dir, { recursive: true });
	}
});

test("settings: without cacheKeeper, pi-cached-compaction's cachedCompaction is read; the menu saves to cacheKeeper and leaves the old key alone", () => {
	const dir = mkdtempSync(join(tmpdir(), "pck-config-"));
	const settings = join(dir, "settings.json");
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		const old = { cacheRetention: "short", minContextTokens: 140_000, compactAtPercent: 70, compactAtTokens: 400_000 };
		writeFileSync(settings, JSON.stringify({ theme: "dark", cachedCompaction: old }));
		assert.equal(settingsKeyInUse(), "cachedCompaction");
		assert.deepEqual(loadConfig(), { ...old, compactBeforeExpiry: true, keepWarmMinutes: 0, modelData: true, fallbackCompactionModel: "" });
		writeFileSync(settings, JSON.stringify({ cachedCompaction: { compactAtPercent: 101 } }));
		assert.throws(loadConfig, /^Error: cachedCompaction\.compactAtPercent/, "errors name the key the value came from");
		writeFileSync(settings, JSON.stringify({ theme: "dark", cachedCompaction: old }));
		const saved = saveConfig({ keepWarmMinutes: 60 });
		assert.deepEqual(saved, { ...old, compactBeforeExpiry: true, keepWarmMinutes: 60, modelData: true, fallbackCompactionModel: "" });
		assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), { theme: "dark", cachedCompaction: old, cacheKeeper: { ...old, keepWarmMinutes: 60 } });
		assert.equal(settingsKeyInUse(), "cacheKeeper");
		// Once cacheKeeper is present, the old key is ignored.
		writeFileSync(settings, JSON.stringify({ cachedCompaction: old, cacheKeeper: { compactAtPercent: 80 } }));
		assert.deepEqual(loadConfig(), { cacheRetention: "long", compactBeforeExpiry: true, minContextTokens: 140_000, compactAtPercent: 80, compactAtTokens: 0, keepWarmMinutes: 0, modelData: true, fallbackCompactionModel: "" });
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(dir, { recursive: true });
	}
});

test("settings: model data from providers.dev is on by default, takes true or false, and is saved beside the others", () => {
	const dir = mkdtempSync(join(tmpdir(), "pcc-config-"));
	const settings = join(dir, "settings.json");
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		assert.equal(loadConfig().modelData, true);
		writeFileSync(settings, JSON.stringify({ cacheKeeper: { modelData: false } }));
		assert.equal(loadConfig().modelData, false);
		writeFileSync(settings, JSON.stringify({ cacheKeeper: { modelData: "off" } }));
		assert.throws(loadConfig, /modelData .* must be true or false/);
		writeFileSync(settings, JSON.stringify({ cacheKeeper: { compactAtPercent: 70 } }));
		assert.equal(saveConfig({ modelData: false }).modelData, false);
		assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")).cacheKeeper, { compactAtPercent: 70, modelData: false });
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(dir, { recursive: true });
	}
});

// Design 0.10.0, test 6 (settings): the fallback compaction model.
test("settings: fallbackCompactionModel is off (\"\") by default, takes \"provider/modelId\" split at the first slash, and refuses anything else", () => {
	const dir = mkdtempSync(join(tmpdir(), "pcc-config-"));
	const settings = join(dir, "settings.json");
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		assert.equal(loadConfig().fallbackCompactionModel, "");
		for (const good of ["", "google/gemini-2.5-flash", "openrouter/google/gemini-2.5-flash", "a/b"]) {
			writeFileSync(settings, JSON.stringify({ cacheKeeper: { fallbackCompactionModel: good } }));
			assert.equal(loadConfig().fallbackCompactionModel, good);
		}
		for (const bad of ["gemini", "/gemini", "google/", "/", 1, true, null, ["google/gemini"]]) {
			writeFileSync(settings, JSON.stringify({ cacheKeeper: { fallbackCompactionModel: bad } }));
			assert.throws(loadConfig, /fallbackCompactionModel in .* must be "provider\/modelId", or "" for off/, String(bad));
		}
		writeFileSync(settings, JSON.stringify({ theme: "dark", cacheKeeper: { keepWarmMinutes: 60 } }));
		assert.equal(saveConfig({ fallbackCompactionModel: "google/gemini-2.5-flash" }).fallbackCompactionModel, "google/gemini-2.5-flash");
		assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")).cacheKeeper, { keepWarmMinutes: 60, fallbackCompactionModel: "google/gemini-2.5-flash" });
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(dir, { recursive: true });
	}
});

// 0.10.1: the setting is fallbackCompactionModel; 0.10.0's coldCompactionModel keeps working in settings.json, the new
// name wins where both are present, and a rewrite of the settings writes only the new name.
test("settings: 0.10.0's coldCompactionModel is read as fallbackCompactionModel, the new name wins over it, and a save writes only the new name", () => {
	const dir = mkdtempSync(join(tmpdir(), "pcc-config-"));
	const settings = join(dir, "settings.json");
	const saved = () => JSON.parse(readFileSync(settings, "utf8")).cacheKeeper;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		// The old name alone, as 0.10.0 saved it: it works, and it is no unknown key.
		writeFileSync(settings, JSON.stringify({ cacheKeeper: { keepWarmMinutes: 60, coldCompactionModel: "google/gemini-2.5-flash" } }));
		assert.equal(loadConfig().fallbackCompactionModel, "google/gemini-2.5-flash");
		assert.ok(!("coldCompactionModel" in loadConfig()), "the config has the new name only");
		// Off under the old name is off.
		writeFileSync(settings, JSON.stringify({ cacheKeeper: { coldCompactionModel: "" } }));
		assert.equal(loadConfig().fallbackCompactionModel, "");
		// Both: the new name wins, whichever comes first in the file.
		writeFileSync(settings, JSON.stringify({ cacheKeeper: { coldCompactionModel: "google/gemini-2.5-flash", fallbackCompactionModel: "acme/tiny" } }));
		assert.equal(loadConfig().fallbackCompactionModel, "acme/tiny");
		writeFileSync(settings, JSON.stringify({ cacheKeeper: { fallbackCompactionModel: "", coldCompactionModel: "google/gemini-2.5-flash" } }));
		assert.equal(loadConfig().fallbackCompactionModel, "", "the new name's off wins over a model under the old one");
		// A bad value under the old name is named by the old name; under the new one, a bad old value is not read.
		writeFileSync(settings, JSON.stringify({ cacheKeeper: { coldCompactionModel: "gemini" } }));
		assert.throws(loadConfig, /cacheKeeper\.coldCompactionModel in .* must be "provider\/modelId", or "" for off/);
		writeFileSync(settings, JSON.stringify({ cacheKeeper: { coldCompactionModel: "gemini", fallbackCompactionModel: "acme/tiny" } }));
		assert.equal(loadConfig().fallbackCompactionModel, "acme/tiny");
		// Saving the setting writes the new name and takes the old one out.
		writeFileSync(settings, JSON.stringify({ theme: "dark", cacheKeeper: { keepWarmMinutes: 60, coldCompactionModel: "google/gemini-2.5-flash" } }));
		assert.equal(saveConfig({ fallbackCompactionModel: "acme/tiny" }).fallbackCompactionModel, "acme/tiny");
		assert.deepEqual(saved(), { keepWarmMinutes: 60, fallbackCompactionModel: "acme/tiny" });
		assert.equal(JSON.parse(readFileSync(settings, "utf8")).theme, "dark");
		// Saving another setting carries the old name's value over to the new name.
		writeFileSync(settings, JSON.stringify({ cacheKeeper: { keepWarmMinutes: 60, coldCompactionModel: "google/gemini-2.5-flash" } }));
		assert.equal(saveConfig({ keepWarmMinutes: 120 }).fallbackCompactionModel, "google/gemini-2.5-flash");
		assert.deepEqual(saved(), { keepWarmMinutes: 120, fallbackCompactionModel: "google/gemini-2.5-flash" });
		// Both saved: the new name's value stays, the old name goes.
		writeFileSync(settings, JSON.stringify({ cacheKeeper: { coldCompactionModel: "google/gemini-2.5-flash", fallbackCompactionModel: "acme/tiny" } }));
		saveConfig({ keepWarmMinutes: 30 });
		assert.deepEqual(saved(), { fallbackCompactionModel: "acme/tiny", keepWarmMinutes: 30 });
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(dir, { recursive: true });
	}
});
