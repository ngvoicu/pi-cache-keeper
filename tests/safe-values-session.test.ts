// providers.dev's safe values (API 1.4.0) in Pi's real session runtime, with settings per session: the window a safe
// value gives is the one a session's own compactAtPercent is taken of, and a safe value that is pi's own is not written,
// so the session's settings apply to Pi's own window.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { dir, inWindow, lineOf, skip, until, writeDefaults, type Any } from "./session-runtime.ts";

process.env.ANTHROPIC_API_KEY = "sk-fixture";

const MODEL = "claude-sonnet-4-6";
const value = (v: number | null, source: string | null, atLeast = false) => ({ value: v, unit: "tokens", at_least: atLeast, scope: "input", window_tokens: null, source, date: "2026-11-20", agreement: source ? "single" : "none", sources: [] });
const none = (unit: string) => ({ ...value(null, null), unit, scope: null });
// One summary of /api/v1/entries at 1.4.0, the copied fields saying what `safe` says.
const summary = (window: number, source: string) => ({
	provider: "anthropic",
	model: MODEL,
	access: "api",
	max_output: null,
	input_window: { tokens: window, bound: "limit", scope: "input", basis: source === "measured" ? "measured" : "documented", source: source === "measured" ? "providers.dev" : source },
	cache_lifetime: { short: { safe_s: null, source: null }, long: { safe_s: null, source: null } },
	pricing: { billing: "per_use", rules: null },
	safe: {
		input_window: value(window, source),
		max_output: none("tokens"),
		cache_short: none("seconds"),
		cache_long: none("seconds"),
		price: { source: null, date: null, agreement: "none", differs: [], sources: [] },
		differing: [],
	},
});

let dataset = { version: "d1", window: 400_000, source: "models.dev" };
const asked: string[] = [];
const providersDev = (async (input: string) => {
	const url = String(input);
	asked.push(url);
	assert.ok(url.startsWith("https://providers.dev/api/v1/"), `asked ${url}`);
	const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
	if (url.endsWith("/meta")) return json({ meta: { dataset_version: dataset.version }, data: {} });
	const provider = new URL(url).searchParams.get("provider");
	return json({ meta: { dataset_version: dataset.version }, next_offset: null, data: provider === "anthropic" ? [summary(dataset.window, dataset.source)] : [] });
}) as typeof fetch;

const modelsFile = () => (existsSync(join(dir, "models.json")) ? JSON.parse(readFileSync(join(dir, "models.json"), "utf8")) : {});
// The refresh is taken up by Pi once it has read models.json again and the extension has selected the session's model
// anew: then the session's model has the window. That takes real I/O, so no fixed number of turns of the event loop.
const windowIs = (w: { runtime: Any }, tokens: number) => () => w.runtime.session.model?.contextWindow === tokens;

test("a session's own compactAtPercent is taken of the window providers.dev's safe value gives; a window that is pi's own is not written, and the session's setting holds on Pi's window", { skip }, async () => {
	writeDefaults({ modelData: true, keepWarmMinutes: 0, compactAtPercent: 90, compactAtTokens: 0, compactBeforeExpiry: false });
	globalThis.fetch = providersDev;
	const result = await inWindow(
		async (w) => {
			await until(windowIs(w, 400_000), "the session's model to carry the 400k window");
			assert.ok(asked.some((url) => url.includes("/entries?provider=anthropic")), `fetched: ${asked.join(", ")}`);
			assert.deepEqual(modelsFile().providers?.anthropic?.modelOverrides?.[MODEL], { contextWindow: 400_000 }, "the safe window (models.dev) replaces Pi's");
			await w.answer();
			const menu = await w.menu();
			menu.set("Compact when the context is", "80% · this session");
			await menu.close();
			assert.match(lineOf(await w.status(), "when full") ?? "", /^when full: at 80% \(this session\): 320k of 400k on anthropic\/claude-sonnet-4-6/);

			// The next dataset: the only source of the window is pi's catalog. It is not written; the extension's own
			// earlier value is taken out, so Pi's window is back, and the session's 80% is taken of it.
			dataset = { version: "d2", window: 500_000, source: "pi.dev" };
			const runner: Any = w.runtime.session.extensionRunner;
			await runner.getCommand("cache-keeper-refresh").handler("", runner.createCommandContext());
			await until(windowIs(w, 1_000_000), "the session's model to carry Pi's own 1000k window again");
			assert.equal(modelsFile().providers?.anthropic?.modelOverrides?.[MODEL], undefined, "pi's own window is not pinned in models.json");
			const store = JSON.parse(readFileSync(join(dir, "cache-keeper-models.json"), "utf8"));
			assert.equal(store.reading, 2);
			assert.deepEqual(store.providers.anthropic[MODEL], {}, "nothing taken from a pi.dev value");
			assert.match(lineOf(await w.status(), "when full") ?? "", /^when full: at 80% \(this session\): 800k of 1000k on anthropic\/claude-sonnet-4-6/);
		},
		{ persisted: true },
	);
	assert.deepEqual(result.thrown, []);
});
