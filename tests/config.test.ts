import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { autoCompactionEnabled, fullThreshold, loadConfig, saveConfig, summaryBudget } from "../config.ts";

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

test("settings: only cacheKeeper is read; pi-cached-compaction's cachedCompaction is not, and a save leaves it alone", () => {
	const dir = mkdtempSync(join(tmpdir(), "pck-config-"));
	const settings = join(dir, "settings.json");
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		const old = { cacheRetention: "short", compactAtPercent: 70 };
		writeFileSync(settings, JSON.stringify({ theme: "dark", cachedCompaction: old }));
		assert.deepEqual(loadConfig(), { cacheRetention: "long", compactBeforeExpiry: true, minContextTokens: 140_000, compactAtPercent: 90, compactAtTokens: 0, keepWarmMinutes: 0, modelData: true, fallbackCompactionModel: "" });
		saveConfig({ keepWarmMinutes: 60 });
		assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), { theme: "dark", cachedCompaction: old, cacheKeeper: { keepWarmMinutes: 60 } });
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

test("settings: coldCompactionModel, the setting's name in 0.10.0, is an unknown key", () => {
	const dir = mkdtempSync(join(tmpdir(), "pcc-config-"));
	const settings = join(dir, "settings.json");
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		writeFileSync(settings, JSON.stringify({ cacheKeeper: { coldCompactionModel: "google/gemini-2.5-flash" } }));
		assert.throws(loadConfig, /cacheKeeper in .* has unknown keys: coldCompactionModel/);
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(dir, { recursive: true });
	}
});
