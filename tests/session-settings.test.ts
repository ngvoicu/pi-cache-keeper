// Settings per session over the defaults: the two layers, their entry in the session (resume, fork, a branch switch,
// back to the defaults, a session without one), the menu and /cache-keeper, and keep-warm reading the session's own
// value. The real parts run in Pi's own session runtime, with a temporary agent directory and no network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { FALLBACK, EXPIRY, flush, FULL, inWindow, KEEP_WARM, lineOf, NO_OWN, OWN, ownEntries, ownOf, settingsText, writeDefaults, type Any } from "./session-runtime.ts";

const {
	GLOBAL_ONLY_KEYS,
	readSessionSettings,
	SESSION_KEYS,
	SESSION_SETTINGS_TYPE,
	sessionSettingsOn,
	settingsInEffect,
	saveConfig,
	withSessionValue,
} = await import("../config.ts");
// ------------------------------------------------------------------------------------------------- the two layers

const DEFAULTS = { cacheRetention: "long", compactBeforeExpiry: true, minContextTokens: 140_000, compactAtPercent: 90, compactAtTokens: 0, keepWarmMinutes: 0, modelData: true, fallbackCompactionModel: "" } as const;
const entry = (settings: unknown) => ({ type: "custom", customType: SESSION_SETTINGS_TYPE, data: { settings } });

test("the merge: the session's own value wins for each key it set; every other key follows the defaults, also a default changed later", () => {
	assert.deepEqual(settingsInEffect(DEFAULTS, {}), DEFAULTS, "no own values: the defaults exactly");
	const own = { keepWarmMinutes: 240, compactAtPercent: 80 };
	assert.deepEqual(settingsInEffect(DEFAULTS, own), { ...DEFAULTS, keepWarmMinutes: 240, compactAtPercent: 80 });
	const later = { ...DEFAULTS, keepWarmMinutes: 60, compactAtPercent: 70, minContextTokens: 200_000, compactBeforeExpiry: false };
	assert.deepEqual(settingsInEffect(later, own), { ...later, keepWarmMinutes: 240, compactAtPercent: 80 }, "a changed default holds where the session set nothing");
	// A session's own value equal to the default is still its own: a later change of the default does not move it.
	assert.equal(settingsInEffect({ ...DEFAULTS, compactAtTokens: 400_000 }, { compactAtTokens: 0 }).compactAtTokens, 0);
	// Off (0, false) is a value like any other.
	assert.deepEqual(settingsInEffect({ ...DEFAULTS, keepWarmMinutes: 120 }, { keepWarmMinutes: 0, compactBeforeExpiry: false }), { ...DEFAULTS, keepWarmMinutes: 0, compactBeforeExpiry: false });
});

test("the global-only keys are refused per session: cacheRetention and modelData can't be set, and an entry holding them is read without them", () => {
	assert.deepEqual([...SESSION_KEYS].sort(), ["compactAtPercent", "compactAtTokens", "compactBeforeExpiry", "fallbackCompactionModel", "keepWarmMinutes", "minContextTokens"]);
	assert.deepEqual([...GLOBAL_ONLY_KEYS], ["cacheRetention", "modelData"]);
	assert.throws(() => withSessionValue({}, "cacheRetention", "short"), /cacheRetention is the same for every session/);
	assert.throws(() => withSessionValue({}, "modelData", false), /modelData is the same for every session/);
	assert.throws(() => withSessionValue({}, "keepWarm", 60), /not a setting a session can set/);
	assert.throws(() => withSessionValue({}, "keepWarmMinutes", 1441), /keepWarmMinutes must be a whole number of minutes from 0 \(off\) to 1440/);
	assert.throws(() => withSessionValue({}, "compactAtPercent", 100), /whole percentage/);
	assert.deepEqual(withSessionValue({ keepWarmMinutes: 60 }, "compactAtTokens", 400_000), { keepWarmMinutes: 60, compactAtTokens: 400_000 });
	assert.deepEqual(withSessionValue({ keepWarmMinutes: 60, compactAtTokens: 1 }, "keepWarmMinutes", undefined), { compactAtTokens: 1 }, "undefined drops a key: it follows the default again");
	// A hand-edited entry, or one of another version: only valid values of session keys are read.
	const read = readSessionSettings({ settings: { cacheRetention: "short", modelData: false, keepWarmMinutes: 240, compactAtPercent: "80", future: 1 } });
	assert.deepEqual(read.settings, { keepWarmMinutes: 240 });
	assert.deepEqual(read.ignored.sort(), ["cacheRetention", "compactAtPercent", "future", "modelData"]);
	assert.deepEqual(readSessionSettings(undefined).settings, {});
	assert.deepEqual(readSessionSettings({ settings: [1] }).settings, {});
});

// Design 0.10.0, test 6 (session part): the fallback compaction model is the sixth session key.
test("fallbackCompactionModel is a session key: \"\" and provider/id are valid per session, anything else is refused; an entry holding it is read, and one without it changes nothing", () => {
	assert.ok((SESSION_KEYS as readonly string[]).includes("fallbackCompactionModel"));
	assert.deepEqual(withSessionValue({}, "fallbackCompactionModel", "google/gemini-2.5-flash"), { fallbackCompactionModel: "google/gemini-2.5-flash" });
	assert.deepEqual(withSessionValue({ keepWarmMinutes: 60 }, "fallbackCompactionModel", ""), { keepWarmMinutes: 60, fallbackCompactionModel: "" }, "off for this session is a value of its own");
	assert.deepEqual(withSessionValue({ fallbackCompactionModel: "" }, "fallbackCompactionModel", undefined), {}, "dropped: it follows the default again");
	for (const bad of ["gemini", "google/", 3]) assert.throws(() => withSessionValue({}, "fallbackCompactionModel", bad), /fallbackCompactionModel must be "provider\/modelId", or "" for off/);
	const read = readSessionSettings({ settings: { fallbackCompactionModel: "google/gemini-2.5-flash", keepWarmMinutes: 240 } });
	assert.deepEqual(read.settings, { fallbackCompactionModel: "google/gemini-2.5-flash", keepWarmMinutes: 240 });
	assert.deepEqual(readSessionSettings({ settings: { fallbackCompactionModel: "nope" } }).ignored, ["fallbackCompactionModel"], "a bad value is left out and named");
	// An entry of 0.9.0, without the key: the session follows the default.
	const old = readSessionSettings({ settings: { keepWarmMinutes: 240 } }).settings;
	assert.equal(settingsInEffect({ ...DEFAULTS, fallbackCompactionModel: "google/gemini-2.5-flash" }, old).fallbackCompactionModel, "google/gemini-2.5-flash");
});

test("a session's own coldCompactionModel (the setting's name in 0.10.0) is left out and named", () => {
	assert.deepEqual(readSessionSettings({ settings: { coldCompactionModel: "google/gemini-2.5-flash", keepWarmMinutes: 240 } }), { settings: { keepWarmMinutes: 240 }, ignored: ["coldCompactionModel"] });
	assert.throws(() => withSessionValue({}, "coldCompactionModel", "acme/tiny"), /coldCompactionModel is not a setting a session can set/);
});

test("the latest settings entry on the branch decides; an empty one is back to the defaults; a session without one has the defaults", () => {
	const user = { type: "message", message: { role: "user" } };
	assert.deepEqual(sessionSettingsOn([]), {});
	assert.deepEqual(sessionSettingsOn([user, { type: "custom", customType: "cache-keeper-refresh", data: { text: "x" } }]), {}, "an old session: other entries only");
	assert.deepEqual(sessionSettingsOn([user, entry({ keepWarmMinutes: 240, compactAtPercent: 80 }), user]), { keepWarmMinutes: 240, compactAtPercent: 80 });
	// Each entry holds the whole set of the session's own values: the latest replaces, not adds to, an earlier one.
	assert.deepEqual(sessionSettingsOn([entry({ keepWarmMinutes: 240, compactAtPercent: 80 }), user, entry({ compactAtTokens: 400_000 })]), { compactAtTokens: 400_000 });
	assert.deepEqual(sessionSettingsOn([entry({ keepWarmMinutes: 240 }), entry({})]), {}, "back to the defaults");
	assert.deepEqual(sessionSettingsOn([entry({ keepWarmMinutes: 240 }), { type: "custom_message", customType: SESSION_SETTINGS_TYPE, data: { settings: { keepWarmMinutes: 1 } } }]), { keepWarmMinutes: 240 }, "only custom entries count");
});


test("the menu opens on this session; values set there are saved in the session when it closes, never in settings.json; they hold after a resume, follow a branch switch and a fork, and /cache-keeper marks them", async () => {
	writeDefaults({ keepWarmMinutes: 0 });
	const before = settingsText();
	const result = await inWindow(
		async (w) => {
			await w.answer();
			const first = w.manager();
			const file = first.getSessionFile();
			assert.equal(lineOf(await w.status(), "settings:"), NO_OWN, "a session without its own settings: the defaults, as before");
			const menu = await w.menu();
			assert.match(menu.text(), /^pi-cache-keeper · editing this session · its own values are saved in the session; every other follows the defaults\n→ Editing +this session\n/);
			assert.match(menu.text(), /\n {2}Keep the cache warm when idle +off · default\n/);
			menu.set(KEEP_WARM, "4 h · this session");
			menu.set(FULL, "80% · this session");
			assert.match(menu.text(), /\n {2}Back to the defaults +drop 2 own values\n/);
			assert.match(menu.text(), /\n {2}Cache retention · all sessions +short\n {2}Model data · all sessions +off\n/);
			assert.deepEqual(ownEntries(first), [], "nothing saved while the menu is open");
			await menu.close();
			assert.equal(settingsText(), before, "settings.json untouched");
			assert.deepEqual(ownOf(first), { settings: { keepWarmMinutes: 240, compactAtPercent: 80 } }, "one entry, in the session");
			assert.equal(ownEntries(first).length, 1);
			// Closing again without a change saves nothing more.
			await (await w.menu()).close();
			assert.equal(ownEntries(first).length, 1);
			const status = await w.status();
			assert.match(status, /\ncompact when full: at 80% \(this session\) of the window: 800k of 1000k tokens on anthropic\/claude-sonnet-4-6/);
			assert.match(status, /\nkeep warm while you are away \(this session\): re-sends your last request with a one-token answer shortly before the cache expires, for up to 4 h after Pi goes idle/);
			assert.match(status, /\ncompact before expiry: on, from 140k tokens of context: in the last 20 s before the cache expires, while Pi is idle with no message queued and the cache can be read, it starts a compaction from the still-warm cache; when that succeeds, your next message writes a summary and the recent messages again, not the whole session\ncache retention: short: /, "a key it didn't set: unmarked");
			assert.equal(lineOf(status, "settings:"), OWN);
			// The entry is never sent to the model.
			assert.ok(!JSON.stringify(first.buildSessionProjection().messages).includes("keepWarmMinutes"));
			await w.answer();
			const [u1, a1, , u2] = first.getBranch().filter((e: Any) => e.type === "message" || e.customType === SESSION_SETTINGS_TYPE);
			assert.equal(u1.message.role, "user");
			assert.equal(a1.message.role, "assistant");
			assert.equal(u2.message.role, "user");

			// A resume: the latest entry on the branch.
			await w.runtime.switchSession(file);
			assert.equal(lineOf(await w.status(), "settings:"), OWN, "after a resume");
			// A branch switch to before the entry: the defaults; back to the leaf: the session's own again.
			const leaf = w.manager().getLeafId();
			await w.runtime.session.navigateTree(a1.id, { summarize: false });
			let status2 = await w.status();
			assert.equal(lineOf(status2, "settings:"), NO_OWN, "on a branch without the entry");
			assert.match(status2, /\nkeep warm while you are away: off: this extension sends no refresh while you are away; Pi's own warming works as usual\n/);
			await w.runtime.session.navigateTree(leaf, { summarize: false });
			assert.equal(lineOf(await w.status(), "settings:"), OWN, "back on the branch with it");

			// A fork made after the entry has it; one from before it doesn't (its branch never had it).
			await w.runtime.fork(u2.id);
			assert.notEqual(w.manager().getSessionFile(), file);
			assert.equal(lineOf(await w.status(), "settings:"), OWN, "in a fork made after the entry");
			await w.runtime.switchSession(file);
			await w.runtime.fork(u1.id);
			assert.equal(lineOf(await w.status(), "settings:"), NO_OWN, "in a fork from before it");
			await w.runtime.switchSession(file);
			await w.runtime.fork(leaf, { position: "at" });
			assert.equal(lineOf(await w.status(), "settings:"), OWN, "in a clone");
			assert.equal(settingsText(), before);
		},
		{ persisted: true },
	);
	assert.deepEqual(result.thrown, []);
});

test("back to the defaults drops the session's own values, in the session; another session keeps its own", async () => {
	writeDefaults({ keepWarmMinutes: 0 });
	const result = await inWindow(
		async (w) => {
			await w.answer();
			const file = w.manager().getSessionFile();
			let menu = await w.menu();
			menu.set(KEEP_WARM, "4 h · this session");
			menu.set(FULL, "80% · this session");
			await menu.close();
			await w.answer();
			const u2 = w.manager().getBranch().filter((e: Any) => e.type === "message").at(-2);
			await w.runtime.fork(u2.id);
			const fork = w.manager();
			const forkFile = fork.getSessionFile();
			assert.equal(lineOf(await w.status(), "settings:"), OWN);
			menu = await w.menu();
			menu.press("Back to the defaults");
			const text = menu.text();
			assert.match(text, /\n→ Back to the defaults +nothing to drop\n/);
			assert.match(text, /\n {2}Keep the cache warm when idle +off · default\n/);
			assert.match(text, /\n {2}Compact when the context is +off · default\n/);
			await menu.close();
			assert.deepEqual(ownOf(fork), { settings: {} }, "an empty entry: back to the defaults");
			assert.equal(lineOf(await w.status(), "settings:"), NO_OWN);
			// A single row set back to its default drops only that key.
			menu = await w.menu();
			menu.set(KEEP_WARM, "1 h · this session");
			menu.set(FULL, "50% · this session");
			menu.set(FULL, "off · default");
			await menu.close();
			assert.deepEqual(ownOf(fork), { settings: { keepWarmMinutes: 60 } });
			menu = await w.menu();
			menu.press("Back to the defaults");
			await menu.close();
			await w.runtime.switchSession(forkFile);
			assert.equal(lineOf(await w.status(), "settings:"), NO_OWN, "the fork, resumed");
			await w.runtime.switchSession(file);
			assert.equal(lineOf(await w.status(), "settings:"), OWN, "the session it was forked from keeps its own");
		},
		{ persisted: true },
	);
	assert.deepEqual(result.thrown, []);
});

test("the defaults are one step away in the menu: changed there, they are saved in settings.json, and hold in this session only for keys it didn't set", async () => {
	writeDefaults({ keepWarmMinutes: 0 });
	const result = await inWindow(async (w) => {
		await w.answer();
		let menu = await w.menu();
		menu.set(KEEP_WARM, "4 h · this session");
		menu.press("Editing");
		const text = menu.text();
		assert.match(text, /^pi-cache-keeper · editing the defaults for all sessions · saved to cacheKeeper in ~\/\.pi\/agent\/settings\.json\n→ Editing +defaults for all sessions\n/);
		assert.match(text, /\n {2}Keep the cache warm when idle +off\n/, "the default, plain");
		assert.doesNotMatch(text, /Back to the defaults/);
		assert.match(text, /\n {2}Cache retention +short\n/);
		menu.set(EXPIRY, "off");
		menu.set(KEEP_WARM, "1 h");
		assert.match(menu.text(), /This session has its own value \(4 h\), which wins in it\./, "the row says the session's own value wins");
		await menu.close();
		const saved = JSON.parse(settingsText()).cacheKeeper;
		assert.equal(saved.keepWarmMinutes, 60);
		assert.equal(saved.compactBeforeExpiry, false);
		assert.deepEqual(ownOf(w.manager()), { settings: { keepWarmMinutes: 240 } }, "the session's own value, saved when the menu closed");
		const status = await w.status();
		assert.match(status, /\nkeep warm while you are away \(this session\): re-sends your last request with a one-token answer shortly before the cache expires, for up to 4 h after Pi goes idle/, "its own value wins");
		assert.match(status, /\ncompact before expiry: off: this extension does not compact an idle session before its cache expires\ncache retention: short: /, "the changed default holds where it set nothing");
		assert.equal(lineOf(status, "settings:"), "settings: this session's own: keepWarmMinutes 4 h (default 1 h); every other follows the defaults · change them with /cache-keeper-settings");
		// The menu opens on this session again, the default shown beside its own value.
		menu = await w.menu();
		assert.match(menu.text(), /\n→ Editing +this session\n/);
		assert.match(menu.text(), /\n {2}Compact before the cache expires +off · default\n/);
		await menu.close();
	});
	assert.deepEqual(result.thrown, []);
});

test("an old session without the entry has the defaults; an entry holding global-only keys is read without them", async () => {
	writeDefaults({ keepWarmMinutes: 0 });
	const result = await inWindow(
		async (w) => {
			await w.answer();
			const file = w.manager().getSessionFile();
			// Written as a 0.7.0 session would be: no settings entry.
			assert.ok(!readFileSync(file, "utf8").includes(SESSION_SETTINGS_TYPE));
			await w.runtime.switchSession(file);
			assert.equal(lineOf(await w.status(), "settings:"), NO_OWN);
			const menu = await w.menu();
			assert.doesNotMatch(menu.text(), /· this session\n/);
			assert.match(menu.text(), /\n {2}Back to the defaults +nothing to drop\n/);
			await menu.close();
			assert.ok(!readFileSync(file, "utf8").includes(SESSION_SETTINGS_TYPE), "opening and closing the menu saves nothing");
			// A hand-edited entry with keys a session can't set: those are left out.
			w.manager().appendCustomEntry(SESSION_SETTINGS_TYPE, { settings: { cacheRetention: "long", modelData: true, keepWarmMinutes: 30 } });
			await w.runtime.switchSession(file);
			const status = await w.status();
			assert.equal(lineOf(status, "settings:"), "settings: this session's own: keepWarmMinutes 30 min (default off); every other follows the defaults · change them with /cache-keeper-settings");
			assert.match(status, /\ncache retention: short: /, "cacheRetention stays the default's");
			assert.equal(process.env.PI_CACHE_RETENTION, undefined);
		},
		{ persisted: true },
	);
	assert.deepEqual(result.thrown, []);
});

test("outside the TUI, /cache-keeper-settings lists both layers", async () => {
	writeDefaults({ keepWarmMinutes: 120 });
	const result = await inWindow(async (w) => {
		await w.answer();
		w.manager().appendCustomEntry(SESSION_SETTINGS_TYPE, { settings: { keepWarmMinutes: 240, compactAtTokens: 400_000 } });
		await w.runtime.switchSession(w.manager().getSessionFile());
		const runner = w.runtime.session.extensionRunner;
		const notes: string[] = [];
		const ctx = runner.createCommandContext();
		Object.defineProperty(ctx, "ui", { value: { ...ctx.ui, notify: (text: string) => notes.push(text) } });
		await runner.getCommand("cache-keeper-settings").handler("", ctx);
		const lines = notes.join("\n").split("\n");
		assert.equal(lines[0], "pi-cache-keeper settings: the defaults for all sessions (cacheKeeper in ~/.pi/agent/settings.json), and over them this session's own values (saved in the session); /cache-keeper-settings in the TUI changes either");
		assert.match(lines[1], /^compactAtPercent: 0 \[default\] · compactAtTokens: 400000 \[this session; default 0\] \(at the 400k-token cap from your settings on/);
		assert.equal(lines[2], "compactBeforeExpiry: true [default] · minContextTokens: 140000 [default]");
		assert.match(lines[3], /^keepWarmMinutes: 240 \[this session; default 120\] \(re-sends your last request with a one-token answer shortly before the cache expires, for up to 4 h after Pi goes idle/);
		assert.equal(lines[4], `fallbackCompactionModel: "" [default] (off: when the cache can't be read, Pi's own compaction writes the summary on this session's model)`);
		assert.equal(lines[5], "cacheRetention: short (all sessions)");
		assert.match(lines[6], /^modelData: false \(all sessions\) \(off\)$/);
		assert.equal(lines[7], "This session's own: compactAtTokens 400k tokens (default off), keepWarmMinutes 4 h (default 2 h); every other setting follows the defaults.");
	}, { mode: "rpc", persisted: true });
	assert.deepEqual(result.thrown, []);
});

// ------------------------------------------------------------------------------------------------------ keep-warm

test("keep-warm reads the session's own keepWarmMinutes: on over a default of off, off over a default of on, and it holds when the default changes in another window", async () => {
	writeDefaults({ keepWarmMinutes: 0 });
	const on = await inWindow(async (w) => {
		const menu = await w.menu();
		menu.set(KEEP_WARM, "2 h · this session");
		await menu.close();
		await w.answer();
		await w.ticks(280);
		assert.equal(await w.decide(), "stop", "the extension keeps it warm, Pi's warming is told to stop");
		// The footer shows the value in effect, as for a default.
		assert.match(w.footer() ?? "", /^cache warm · 4m left · keep-warm 2h until \d\d:\d\d, \$0\.036 spent of \$0\.41 · /);
		// Another window saves the default off: this session's own value still holds.
		writeDefaults({ keepWarmMinutes: 0 });
		await w.ticks(300);
		assert.equal(await w.decide(), "stop");
	});
	assert.deepEqual(on.thrown, []);
	assert.equal(on.refreshes, 2, "a refresh before each expiry");

	writeDefaults({ keepWarmMinutes: 120 });
	const off = await inWindow(async (w) => {
		const menu = await w.menu();
		menu.set(KEEP_WARM, "off · this session");
		await menu.close();
		await w.answer();
		await w.ticks(600);
		assert.equal(await w.decide(), "warm", "keep-warm off here: Pi's proposal stands");
	});
	assert.deepEqual(off.thrown, []);
	assert.equal(off.refreshes, 0);

	// Raised for this session during a period kept warm at the default: the step from the default goes up, never through
	// off, so the period's warming goes on, now with the session's limit.
	writeDefaults({ keepWarmMinutes: 120 });
	const raised = await inWindow(async (w) => {
		await w.answer();
		await w.ticks(100);
		const menu = await w.menu();
		menu.press(KEEP_WARM);
		assert.match(menu.text(), /\n→ Keep the cache warm when idle +3 h · this session\n/, "one step up from the default");
		menu.set(KEEP_WARM, "4 h · this session");
		await menu.close();
		await w.ticks(180);
		assert.equal(await w.decide(), "stop");
		assert.match(w.footer() ?? "", / · keep-warm 4h until /);
		assert.ok(!w.warmLog().some((r: Any) => r.reason === "keep-warm was turned off"), "warming never ended");
	});
	assert.deepEqual(raised.thrown, []);
	assert.equal(raised.refreshes, 1);
});

// The same switch during an idle period, made once in the defaults and once for this session: everything seen is the same.
for (const turn of ["on", "off"] as const) {
	test(`keep-warm switched ${turn} during an idle period for this session behaves as switching the default ${turn} does`, async () => {
		const seen: Record<string, unknown> = {};
		for (const layer of ["defaults", "session"] as const) {
			writeDefaults({ keepWarmMinutes: turn === "on" ? 0 : 120 });
			const observed: Any = { decisions: [], footers: [] };
			const result = await inWindow(async (w) => {
				await w.answer();
				await w.ticks(100);
				observed.decisions.push(await w.decide());
				observed.footers.push(w.footer());
				const menu = await w.menu();
				if (layer === "defaults") menu.press("Editing");
				menu.set(KEEP_WARM, turn === "on" ? (layer === "defaults" ? "2 h" : "2 h · this session") : layer === "defaults" ? "off" : "off · this session");
				await menu.close();
				observed.footers.push(w.footer());
				for (let i = 0; i < 4; i++) {
					await w.ticks(150);
					observed.decisions.push(await w.decide());
					observed.footers.push(w.footer());
				}
				observed.log = w.warmLog().map((r: Any) => [r.action, r.reason, r.stop]);
				// The next answer starts a period with the setting as it is now.
				await w.answer();
				await w.ticks(280);
				observed.decisions.push(await w.decide());
			});
			assert.deepEqual(result.thrown, []);
			observed.refreshes = result.refreshes;
			seen[layer] = observed;
		}
		assert.deepEqual(seen.session, seen.defaults);
		const observed = seen.session as Any;
		if (turn === "on") {
			assert.equal(observed.decisions[0], "warm", "off at the start: Pi's");
			assert.equal(observed.refreshes, 1, "only the next period is kept warm by the extension");
			assert.equal(observed.decisions.at(-1), "stop");
		} else {
			assert.equal(observed.decisions[0], "stop", "on at the start: the extension's");
			assert.ok(observed.log.some((r: string[]) => r[1] === "keep-warm was turned off"), "warming ends, said once");
			assert.equal(observed.decisions.at(-1), "warm", "the next period is Pi's");
		}
	});
}

// ------------------------------------------------------------------------------------------- after the review

// The limit in effect is the one at the moment a refresh would leave. At 32 min 05 s idle, refresh 7 is being prepared
// (its adapter has not built the payload yet) when the limit becomes 30 min: the session goes back to its 30-minute
// default, or another window saves a 30-minute default. Nothing leaves past the limit, and warming ends with it.
for (const change of ["back to the defaults", "the default, saved in another window"] as const) {
	test(`a refresh being prepared when the time limit is shortened to 30 min (${change}) does not go out`, async () => {
		writeDefaults({ keepWarmMinutes: change === "the default, saved in another window" ? 120 : 30, compactBeforeExpiry: false });
		const seen: Any = {};
		const result = await inWindow(
			async (w) => {
				if (change !== "the default, saved in another window") {
					const menu = await w.menu();
					menu.set(KEEP_WARM, "2 h · this session");
					await menu.close();
				}
				await w.answer();
				const registry = w.runtime.session.extensionRunner.createContext().modelRegistry;
				const stream = registry.streamSimple.bind(registry);
				let release: () => void = () => {};
				const held = new Promise<void>((resolve) => (release = resolve));
				let pending = false;
				let calls = 0;
				registry.streamSimple = (...args: Any[]) => {
					calls++;
					if (calls !== 7) return stream(...args);
					return {
						result: async () => {
							pending = true;
							await held;
							return stream(...args).result();
						},
					};
				};
				await w.ticks(1925);
				assert.equal(pending, true, "refresh 7 is being prepared");
				seen.before = w.refreshCount();
				if (change === "back to the defaults") {
					const menu = await w.menu();
					menu.press("Back to the defaults");
					await menu.close();
				} else saveConfig({ keepWarmMinutes: 30 });
				seen.status = lineOf(await w.status(), "keep warm while you are away");
				release();
				for (let i = 0; i < 8; i++) await flush();
				seen.after = w.refreshCount();
				seen.last = w.warmLog().at(-1);
				await w.ticks(600);
				seen.end = w.refreshCount();
			},
			{ persisted: true },
		);
		assert.deepEqual(result.thrown, []);
		assert.equal(seen.before, 6);
		assert.match(seen.status, /up to 30 min after Pi goes idle/, "/cache-keeper shows the 30-minute limit");
		assert.equal(seen.after, 6, "refresh 7 did not go out");
		assert.equal(seen.end, 6, "nor any later one");
		assert.equal(seen.last?.stop, "limit");
		assert.equal(seen.last?.reason, "the cache lasts to the end of the 30 min limit after Pi went idle");
	});
}

// The defaults another window saved (here written to settings.json, as that window's menu does) hold at the next decision
// of every session that has no value of its own for them: dropping the session's own value, or never having one.
test("back to the defaults after another window turned compactBeforeExpiry off: no compaction before expiry", async () => {
	writeDefaults({ compactBeforeExpiry: true, minContextTokens: 100_000, keepWarmMinutes: 0 });
	const seen: Any = {};
	const result = await inWindow(
		async (w) => {
			let menu = await w.menu();
			menu.set(EXPIRY, "on · this session");
			await menu.close();
			await w.answer();
			const start = Date.now();
			await w.ticks(100);
			saveConfig({ compactBeforeExpiry: false });
			menu = await w.menu();
			menu.press("Back to the defaults");
			assert.match(menu.text(), /\n {2}Compact before the cache expires +off · default\n/, "the menu shows the default as saved now");
			await menu.close();
			seen.status = lineOf(await w.status(), "compact before expiry");
			await w.ticks(182);
			seen.compactions = w.compactAt.map((at) => (at - start) / 1000);
		},
		{ persisted: true },
	);
	assert.deepEqual(result.thrown, []);
	assert.equal(seen.status, "compact before expiry: off: this extension does not compact an idle session before its cache expires");
	assert.deepEqual(seen.compactions, [], "nothing compacted at 280 s");
});

for (const kind of ["expiry", "full"] as const) {
	test(`a default saved in another window after this one started holds here: ${kind === "expiry" ? "compactBeforeExpiry turned off" : "the compactAtTokens cap turned off"}`, async () => {
		writeDefaults({ keepWarmMinutes: 0, compactAtPercent: 0, compactAtTokens: kind === "full" ? 100_000 : 0, compactBeforeExpiry: kind === "expiry", minContextTokens: 100_000 });
		const seen: Any = {};
		const result = await inWindow(
			async (w) => {
				if (kind === "expiry") {
					await w.answer();
					await w.ticks(100);
				}
				saveConfig(kind === "expiry" ? { compactBeforeExpiry: false } : { compactAtTokens: 0 });
				seen.status = lineOf(await w.status(), kind === "expiry" ? "compact before expiry" : "compact when full");
				if (kind === "full") await w.answer();
				else await w.ticks(182);
				seen.compactions = w.compactAt.length;
			},
			{ persisted: true },
		);
		assert.deepEqual(result.thrown, []);
		assert.equal(seen.status, kind === "expiry" ? "compact before expiry: off: this extension does not compact an idle session before its cache expires" : "compact when full: off: this extension doesn't compact as the context fills; Pi's own automatic compaction, where it is on in Pi's settings, starts at its threshold (by default when the window is nearly full), often with too little room left to summarize from the cache");
		assert.equal(seen.compactions, 0);
	});
}

test("/cache-keeper marks each value by where it comes from", async () => {
	writeDefaults({ keepWarmMinutes: 0, compactAtPercent: 90, compactAtTokens: 0, compactBeforeExpiry: false, minContextTokens: 140_000 });
	const result = await inWindow(
		async (w) => {
			await w.answer();
			let menu = await w.menu();
			menu.set("Or once it holds", "off · this session");
			menu.set("Before expiry, only from", "200k · this session");
			await menu.close();
			let status = await w.status();
			// The session's own cap (off) and minimum (200k) decide nothing shown: the 90% and "off" are the defaults'.
			assert.equal(lineOf(status, "compact when full"), "compact when full: at 90% of the window: 900k of 1000k tokens on anthropic/claude-sonnet-4-6, leaving 96k for the summary");
			assert.equal(lineOf(status, "compact before expiry"), "compact before expiry: off: this extension does not compact an idle session before its cache expires");
			assert.equal(lineOf(status, "settings:"), "settings: this session's own: compactAtTokens off (default off), minContextTokens 200k (default 140k); every other follows the defaults · change them with /cache-keeper-settings");
			menu = await w.menu();
			menu.set(EXPIRY, "on · this session");
			menu.set("Or once it holds", "400k tokens · this session");
			await menu.close();
			status = await w.status();
			assert.equal(lineOf(status, "compact when full"), "compact when full: at the 400k-token cap from your settings (this session) on anthropic/claude-sonnet-4-6, leaving 128k for the summary");
			assert.equal(lineOf(status, "compact before expiry"), "compact before expiry: on (this session), from 200k tokens of context (this session): in the last 20 s before the cache expires, while Pi is idle with no message queued and the cache can be read, it starts a compaction from the still-warm cache; when that succeeds, your next message writes a summary and the recent messages again, not the whole session");
			menu = await w.menu();
			menu.set("Compact when the context is", "off · this session");
			menu.set("Or once it holds", "off · this session");
			await menu.close();
			assert.equal(lineOf(await w.status(), "compact when full"), "compact when full: off (this session): this extension doesn't compact as the context fills; Pi's own automatic compaction, where it is on in Pi's settings, starts at its threshold (by default when the window is nearly full), often with too little room left to summarize from the cache");
		},
		{ persisted: true },
	);
	assert.deepEqual(result.thrown, []);
});

// ------------------------------------------------------------------------------------------- the last round

// The reviewer's case: refresh 7's payload passes the last gate under a 2-hour default at 32 min 05 s idle; in the
// microtask right after, before the adapter hands the request to its transport, another window saves a 30-minute
// default. The check at the send stops it.
test("a 30-minute default saved after the payload passed, before the transport: refresh 7 does not reach the transport", async () => {
	writeDefaults({ keepWarmMinutes: 120, compactBeforeExpiry: false });
	const seen: Any = {};
	const result = await inWindow(
		async (w) => {
			await w.answer();
			const registry = w.runtime.session.extensionRunner.createContext().modelRegistry;
			const stream = registry.streamSimple.bind(registry);
			let calls = 0;
			registry.streamSimple = (model: Any, context: Any, options: Any) => {
				if (++calls !== 7) return stream(model, context, options);
				return stream(model, context, {
					...options,
					onPayload: (...args: Any[]) => {
						const passed = options.onPayload(...args);
						seen.whenHookPassed = { transportCalls: w.refreshCount(), minutes: JSON.parse(settingsText()).cacheKeeper.keepWarmMinutes };
						queueMicrotask(() => {
							saveConfig({ keepWarmMinutes: 30 });
							seen.whenSaved = { transportCalls: w.refreshCount(), minutes: JSON.parse(settingsText()).cacheKeeper.keepWarmMinutes };
						});
						return passed;
					},
				});
			};
			await w.ticks(1925);
			for (let i = 0; i < 8; i++) await flush();
			seen.afterSend = w.refreshCount();
			seen.last = w.warmLog().at(-1);
			await w.ticks(600);
			seen.end = w.refreshCount();
		},
		{ persisted: true },
	);
	assert.deepEqual(result.thrown, []);
	assert.deepEqual(seen.whenHookPassed, { transportCalls: 6, minutes: 120 }, "the payload passed under the 2-hour default");
	assert.deepEqual(seen.whenSaved, { transportCalls: 6, minutes: 30 }, "the 30-minute default is saved before the transport");
	assert.equal(seen.afterSend, 6, "refresh 7 did not reach the transport");
	assert.equal(seen.end, 6);
	assert.equal(seen.last?.stop, "limit");
	assert.equal(seen.last?.reason, "the cache lasts to the end of the 30 min limit after Pi went idle");
});

// The reviewer's case: another window's save lands right after the extension read the defaults at its start. It runs in
// a process of its own (tests/fixtures/startup-race.ts), where the extension loads with the hook in place. The save is
// complete before the first turn; nothing compacts that it turned off.
for (const kind of ["expiry", "full"] as const) {
	test(`a default saved right after this window read the defaults at its start holds at the first decision (${kind === "expiry" ? "compactBeforeExpiry off" : "the cap off"})`, () => {
		const child = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("fixtures/startup-race.ts", import.meta.url)), kind], { encoding: "utf8", timeout: 60_000 });
		assert.equal(child.status, 0, child.stderr);
		const seen = JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "{}");
		assert.equal(seen.savedDuringStartup, true, "saved during the startup read");
		assert.equal(seen.thrown, 0);
		assert.equal(seen.status, kind === "expiry" ? "compact before expiry: off: this extension does not compact an idle session before its cache expires" : "compact when full: off: this extension doesn't compact as the context fills; Pi's own automatic compaction, where it is on in Pi's settings, starts at its threshold (by default when the window is nearly full), often with too little room left to summarize from the cache");
		assert.equal(seen.calls, 0, "no compaction");
	});
}

// The reviewer's case: the session's own 150k cap left the context at 160k after a compaction; another window changes the
// default cap, which this session overrides. Nothing in effect changed, so nothing is tried again.
test("a change of a default the session overrides does not try compacting when full again", async () => {
	writeDefaults({ compactAtTokens: 100_000, compactBeforeExpiry: false, keepWarmMinutes: 0 });
	const seen: Any = {};
	const result = await inWindow(
		async (w) => {
			const menu = await w.menu();
			menu.set("Or once it holds", "150k tokens · this session");
			await menu.close();
			w.runtime.session.getContextUsage = () => ({ tokens: 160_000, contextWindow: 1_000_000, percent: 16 });
			await w.answer();
			await flush();
			seen.first = w.compactAt.length;
			await w.answer();
			await flush();
			seen.unchanged = w.compactAt.length;
			saveConfig({ compactAtTokens: 200_000 });
			await w.answer();
			await flush();
			seen.changedDefault = w.compactAt.length;
			seen.status = lineOf(await w.status(), "compact when full");
			// A change of the mark in effect does try again: back to the defaults, now a 100k cap.
			saveConfig({ compactAtTokens: 100_000 });
			const again = await w.menu();
			again.press("Back to the defaults");
			await again.close();
			await w.answer();
			await flush();
			seen.changedOwn = w.compactAt.length;
		},
		{ persisted: true },
	);
	assert.deepEqual(result.thrown, []);
	assert.deepEqual([seen.first, seen.unchanged, seen.changedDefault], [1, 1, 1]);
	assert.match(seen.status, /^compact when full: at the 150k-token cap from your settings \(this session\) on /);
	assert.equal(seen.changedOwn, 2, "the cap in effect changed: tried again");
});

// ------------------------------------------------------------------------------------------- the fallback compaction model

// The models a test's registry lists, with credentials: the picked model's list is Pi's available models.
const GEMINI = { provider: "google", id: "gemini-2.5-flash", api: "google-generative-ai", contextWindow: 1_048_576, maxTokens: 65_536, reasoning: true, input: ["text"], cost: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 } };
const TINY = { ...GEMINI, provider: "acme", id: "tiny", contextWindow: 8_000, maxTokens: 4_000, cost: { input: 0.05, output: 0.1, cacheRead: 0, cacheWrite: 0 } };
const NO_WINDOW = { ...GEMINI, provider: "local", id: "llama", contextWindow: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const VIRTUAL = { ...GEMINI, provider: "pi", id: "auto", api: "pi-virtual" };
const fallbackModels = (w: Any) => {
	const registry = w.runtime.session.extensionRunner.createContext().modelRegistry;
	const listed = [GEMINI, TINY, NO_WINDOW, VIRTUAL];
	const find = registry.find.bind(registry);
	const auth = registry.hasConfiguredAuth.bind(registry);
	registry.getAvailable = () => [...listed, w.runtime.session.model];
	registry.find = (provider: string, id: string) => listed.find((m) => m.provider === provider && m.id === id) ?? find(provider, id);
	registry.hasConfiguredAuth = (model: Any) => listed.includes(model) || auth(model);
};
// What /cache-keeper says of the picked model: the setting, the model, its window and price; no prediction (review 7).
const DECIDED = "whether it writes a summary is decided at each compaction, from the part Pi cuts off";
const GEMINI_LINE = `fallback compaction model (asked to write the summary when the cache can't be used): gemini-2.5-flash [google] · 1.05M window · $0.30 in, $2.50 out per M · ${DECIDED}`;
const NOT_CACHED = "the fallback compaction model (below) is asked to write the summary, else Pi's own compaction runs";

// Design 0.10.0, test 7.
test("the fallback compaction model: a session's own value wins over the default, its off wins over a default model, the default is read as saved now, and back to the defaults drops it", async () => {
	writeDefaults({ fallbackCompactionModel: "google/gemini-2.5-flash" });
	const result = await inWindow(
		async (w) => {
			fallbackModels(w);
			await w.answer();
			assert.equal(lineOf(await w.status(), "fallback compaction model ("), GEMINI_LINE, "the default, as saved");
			// Off for this session over a default model: the list's second line.
			let menu = await w.menu();
			assert.match(menu.text(), /\n {2}When the cache can't be used, compact with +gemini-2\.5-flash \[google\] · default\n/);
			menu.press(FALLBACK);
			menu.keys("\x1b[B\r");
			assert.match(menu.text(), /\n→ When the cache can't be used, compact with +off · this session\n/);
			await menu.close();
			assert.deepEqual(ownOf(w.manager()), { settings: { fallbackCompactionModel: "" } });
			assert.equal(lineOf(await w.status(), "fallback compaction model ("), "fallback compaction model (asked to write the summary when the cache can't be used): off (this session): when the cache can't be read, Pi's own compaction writes the summary on this session's model");
			// A default changed in another window: this session's off still wins.
			saveConfig({ fallbackCompactionModel: "acme/tiny" });
			assert.match(lineOf(await w.status(), "fallback compaction model (") ?? "", /^fallback compaction model \(asked to write the summary when the cache can't be used\): off \(this session\)/);
			assert.match(lineOf(await w.status(), "settings:") ?? "", /fallbackCompactionModel off \(default tiny \[acme\]\)/);
			// Back to the defaults: the default as saved now.
			menu = await w.menu();
			menu.press("Back to the defaults");
			await menu.close();
			assert.equal(lineOf(await w.status(), "fallback compaction model ("), `fallback compaction model (asked to write the summary when the cache can't be used): tiny [acme] · 8k window · $0.05 in, $0.10 out per M · ${DECIDED}`);
			// A session's own model over the default, picked by typing.
			menu = await w.menu();
			menu.press(FALLBACK);
			menu.keys("gemini\r");
			assert.match(menu.text(), /\n→ When the cache can't be used, compact with +gemini-2\.5-flash \[google\] · this session\n/);
			await menu.close();
			assert.deepEqual(ownOf(w.manager()), { settings: { fallbackCompactionModel: "google/gemini-2.5-flash" } });
			assert.match(lineOf(await w.status(), "fallback compaction model (") ?? "", /^fallback compaction model \(asked to write the summary when the cache can't be used\): gemini-2\.5-flash \[google\] \(this session\) · 1\.05M window/);
			// The list opens on the session's own pick, marked as Pi marks the current model; its first line drops it again.
			menu = await w.menu();
			menu.press(FALLBACK);
			assert.match(menu.text(), /\n→ ✓ gemini-2\.5-flash \[google\] · 1\.05M window/);
			menu.keys("\x1b[A\x1b[A\r");
			assert.match(menu.text(), /\n→ When the cache can't be used, compact with +tiny \[acme\] · default\n/);
			await menu.close();
			assert.deepEqual(ownOf(w.manager()), { settings: {} });
		},
		{ persisted: true },
	);
	assert.deepEqual(result.thrown, []);
	assert.equal(JSON.parse(settingsText()).cacheKeeper.fallbackCompactionModel, "acme/tiny", "the session's values never went into settings.json");
});

// Design 0.10.0, test 8.
test("the fallback compaction model's row, its list, its /cache-keeper lines and the next compaction; a pick Pi can't use now is kept and marked", async () => {
	writeDefaults({});
	const result = await inWindow(async (w) => {
		fallbackModels(w);
		await w.answer();
		let menu = await w.menu();
		assert.match(menu.text(), /\n {2}Or once it holds +[^\n]+\n {2}When the cache can't be used, compact with +off · default\n {2}Compact before the cache expires/, "after Or once it holds");
		menu.press(FALLBACK);
		const list = menu.text().split("\n");
		assert.match(list.find((line) => line.startsWith("When the cache can't be used, compact with,")) ?? "", /^When the cache can't be used, compact with, in this session · "holds this session" speaks of this session now \(about \d+k? tokens as text\)$/);
		// Each row as Pi's picker draws a model: the selection marker, the mark of the value in effect, the id, the badge.
		const lines = list.filter((line) => /^(→ |  )(✓ |  )(default|off|gemini|tiny|llama|auto|claude)/.test(line)).map((line) => line.slice(4));
		assert.deepEqual(list.filter((line) => /^(→ |  )(✓ |  )(default|off)/.test(line)), ["→ ✓ default (off)", "    off"]);
		assert.ok(lines.includes("gemini-2.5-flash [google] · 1.05M window · $0.30 in, $2.50 out per M · holds this session"), lines.join("\n"));
		assert.ok(lines.some((line) => /^tiny \[acme\] · 8k window · \$0\.05 in, \$0\.10 out per M · too small now \(needs about \d+k?\)$/.test(line)), lines.join("\n"));
		assert.ok(lines.includes("llama [local] · window unknown · no price · can't be used: it declares no context window"), lines.join("\n"));
		assert.ok(!lines.some((line) => line.startsWith("auto [pi]")), "a virtual model is not offered");
		// The models that hold this session come first.
		assert.ok(lines.findIndex((line) => line.includes("holds this session")) < lines.findIndex((line) => line.startsWith("llama [local]")));
		menu.keys("\x1b");
		// The defaults: no default line in the list.
		menu.press("Editing");
		menu.press(FALLBACK);
		assert.match(menu.text(), /\nWhen the cache can't be used, compact with, by default · "holds this session" speaks of the session this menu was opened in/);
		assert.match(menu.text(), /\n→ ✓ off\n/, "off, the default in effect, marked and selected");
		assert.doesNotMatch(menu.text(), /default \(/);
		menu.keys("gemini\r");
		assert.match(menu.text(), /\n→ When the cache can't be used, compact with +gemini-2\.5-flash \[google\]\n/);
		await menu.close();
		assert.equal(JSON.parse(settingsText()).cacheKeeper.fallbackCompactionModel, "google/gemini-2.5-flash");
		// /cache-keeper: the line, and the next compaction on a cold cache (none since the session's model last answered
		// is still warm: the cached path; a model switch makes it cold).
		let status = await w.status();
		assert.equal(lineOf(status, "fallback compaction model ("), GEMINI_LINE);
		assert.match(lineOf(status, "next compaction:") ?? "", /^next compaction: from the cache, as far as can be told now;/);
		const session = w.runtime.session;
		const original = session.model;
		session.agent.state.model = { ...original, id: "claude-sonnet-4-5" };
		status = await w.status();
		assert.equal(lineOf(status, "next compaction:"), `next compaction: not from the cache, because the model changed since the last request; ${NOT_CACHED}`);
		saveConfig({ fallbackCompactionModel: "local/llama" });
		status = await w.status();
		assert.equal(lineOf(status, "next compaction:"), `next compaction: not from the cache, because the model changed since the last request; ${NOT_CACHED}`);
		assert.equal(lineOf(status, "fallback compaction model ("), "fallback compaction model (asked to write the summary when the cache can't be used): llama [local] · window unknown · no price · can't be used: it declares no context window");
		session.agent.state.model = original;
		// A pick Pi can't use now is kept, and marked on the row and in /cache-keeper.
		saveConfig({ fallbackCompactionModel: "google/gemini-9" });
		assert.equal(lineOf(await w.status(), "fallback compaction model ("), "fallback compaction model (asked to write the summary when the cache can't be used): gemini-9 [google] · not available now: Pi no longer lists it");
		menu = await w.menu();
		assert.match(menu.text(), /\n {2}When the cache can't be used, compact with +gemini-9 \[google\] · not available now · default\n/);
		await menu.close();
		assert.equal(JSON.parse(settingsText()).cacheKeeper.fallbackCompactionModel, "google/gemini-9");
	});
	assert.deepEqual(result.thrown, []);
});

// Findings 10 and 3 (review of 0.10.0, round 1), as 0.10.4 draws a row (Pi's /model picker): in a narrow terminal the
// picker's rows keep the whole id and the whole [provider] badge, over a second line where they need it, and stay
// distinct; and the row says what goes to the picked model's provider.
test("review 10 and 3: at 40 and 60 columns the picker's rows keep the whole model id and provider, wrapping rather than cutting them, and stay distinct; the row's description names what is sent", async () => {
	writeDefaults({});
	const result = await inWindow(async (w) => {
		const registry = w.runtime.session.extensionRunner.createContext().modelRegistry;
		const long = [
			{ ...GEMINI, provider: "amazon-bedrock", id: "anthropic.claude-sonnet-4-5-20250929-v1:0", contextWindow: 200_000, cost: { input: 3.3, output: 16.5, cacheRead: 0.33, cacheWrite: 4.125 } },
			{ ...GEMINI, provider: "amazon-bedrock", id: "anthropic.claude-sonnet-4-6", contextWindow: 1_000_000, cost: { input: 3.3, output: 16.5, cacheRead: 0.33, cacheWrite: 4.125 } },
		];
		registry.getAvailable = () => long;
		registry.find = (provider: string, id: string) => long.find((m) => m.provider === provider && m.id === id);
		registry.hasConfiguredAuth = () => true;
		await w.answer();
		const menu = await w.menu();
		menu.press(FALLBACK);
		for (const width of [40, 60]) {
			// The list's rows below "off": a row's first line after the 4 columns of marks, its next lines indented 2 more.
			const lines = menu.text(width).split("\n");
			const list = lines.slice(lines.findIndex((line) => /^(→ |  )(✓ |  )off$/.test(line)) + 1, lines.findIndex((line) => line.startsWith("Type to search")));
			const rows: string[] = [];
			for (const line of list) {
				if (/^ {6}\S/.test(line)) rows[rows.length - 1] += `\n${line.slice(6)}`;
				else rows.push(line.slice(4));
			}
			assert.equal(rows.length, 2, `${width}: ${rows.join(" | ")}`);
			assert.notEqual(rows[0], rows[1], `${width}: distinct`);
			for (const line of list) assert.ok(line.length <= width - 2, `${width}: ${line}`);
			// Each row holds its whole id (an id wider than a line goes on where the line ends) and its whole badge.
			for (const model of long) assert.ok(rows.some((row) => row.replace(/\n/g, "").startsWith(model.id)), `${width}: ${model.id} in ${rows.join(" | ")}`);
			for (const row of rows) assert.match(row, /(^|\s)\[amazon-bedrock\]/, `${width}: ${row}`);
		}
		// At 60 columns, the long id and its badge over two lines; the shorter one on one.
		assert.match(menu.text(60), /\n {4}anthropic\.claude-sonnet-4-5-20250929-v1:0\n {6}\[amazon-bedrock\] · [^\n]+\n/);
		assert.match(menu.text(60), /\n {4}anthropic\.claude-sonnet-4-6 \[amazon-bedrock\] · [^\n]+\n/);
		menu.keys("\x1b");
		const description = menu.text();
		assert.match(description, /full output of shell commands you ran with !/);
		await menu.close();
	});
	assert.deepEqual(result.thrown, []);
});

// 0.10.4: pi-provimux 105.0.5's models (provider provimux, the service and the access in each name) beside a plain
// anthropic one: the list draws each model as Pi's /model picker does, at 80 and 120 columns; it is searched by provider
// and by name; the access part agrees with the name; the pick shows as `model-id [provider]` and is saved as provider/id.
const PROVIMUX_MODEL = { provider: "provimux", api: "anthropic-messages", baseUrl: "http://127.0.0.1:18399", reasoning: true, input: ["text"], contextWindow: 1_000_000, maxTokens: 128_000, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } };
const PROVIMUX_MODELS = [
	{ ...PROVIMUX_MODEL, id: "claude-opus-5-5", name: "Claude Opus 5.5 · Anthropic sub, fallback api" },
	{ ...PROVIMUX_MODEL, id: "devin/claude-opus-5-5", name: "Claude Opus 5.5 (Devin) · Devin sub" },
	{ ...PROVIMUX_MODEL, id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5 · OpenRouter api" },
];
// As pi-provimux says where they come from (its model-upstreams event).
const PROVIMUX_ROUTES = {
	provider: "provimux",
	models: {
		"claude-opus-5-5": { upstreams: [{ provider: "anthropic", subscription: true }], fallbacks: [{ provider: "anthropic", subscription: false }] },
		"devin/claude-opus-5-5": { upstreams: [{ provider: "devin", model: "claude-opus-5-5" }] },
		"anthropic/claude-opus-5.5": { upstreams: [{ provider: "openrouter", subscription: false }] },
	},
};
test("0.10.4: Provimux models in the list as Pi's /model picker shows them, at 80 and 120 columns; searched by provider and name; the pick as model-id [provider]", async () => {
	writeDefaults({ fallbackCompactionModel: "provimux/devin/claude-opus-5-5" });
	const result = await inWindow(
		async (w) => {
			const registry = w.runtime.session.extensionRunner.createContext().modelRegistry;
			const opus = { ...w.runtime.session.model, id: "claude-opus-4-5", name: "Claude Opus 4.5 (latest)", contextWindow: 200_000, maxTokens: 64_000, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } };
			const listed = [...PROVIMUX_MODELS, opus];
			registry.getAvailable = () => [...listed, w.runtime.session.model];
			const find = registry.find.bind(registry);
			registry.find = (provider: string, id: string) => listed.find((m) => m.provider === provider && m.id === id) ?? find(provider, id);
			registry.hasConfiguredAuth = () => true;
			w.runtime.services.resourceLoader.eventBus.emit("model-upstreams", PROVIMUX_ROUTES);
			await w.answer();
			// The current value and /cache-keeper: model-id [provider]; the Devin model's price is left out (its name says sub).
			assert.equal(lineOf(await w.status(), "fallback compaction model ("), `fallback compaction model (asked to write the summary when the cache can't be used): devin/claude-opus-5-5 [provimux] · 1M window · ${DECIDED}`);
			const menu = await w.menu();
			assert.match(menu.text(), /\n {2}When the cache can't be used, compact with +devin\/claude-opus-5-5 \[provimux\] · default\n/);
			menu.press(FALLBACK);
			const listOf = (width: number) => {
				const lines = menu.text(width).split("\n");
				return lines.slice(lines.findIndex((line) => line.startsWith(">")) + 1, lines.findIndex((line) => line.startsWith("Type to search")));
			};
			assert.deepEqual(listOf(120), [
				"→ ✓ default (devin/claude-opus-5-5 [provimux])",
				"    off",
				// A subscription first, as before; its "subscription" is left out: the name says it falls back to an API key.
				"    claude-opus-5-5 (Claude Opus 5.5 · Anthropic sub, fallback api) [provimux] · 1M window · holds this session",
				// Then by price, the references breaking ties. The OpenRouter model's price agrees with its name, but beside
				// the fit there is no room for it at this width: the window and the fit stay.
				"    claude-opus-4-5 (Claude Opus 4.5 (latest)) [anthropic] · $5.00 in, $25.00 out per M · holds this session",
				"    anthropic/claude-opus-5.5 (Claude Opus 5.5 · OpenRouter api) [provimux] · 1M window · holds this session",
				// Its price left out: the name says a Devin subscription.
				"    devin/claude-opus-5-5 (Claude Opus 5.5 (Devin) · Devin sub) [provimux] · 1M window · holds this session",
				"    claude-sonnet-4-6 [anthropic] · $3.00 in, $15.00 out per M · can't be used: it is the session's own model",
			]);
			assert.deepEqual(listOf(80), [
				"→ ✓ default (devin/claude-opus-5-5 [provimux])",
				"    off",
				"    claude-opus-5-5 (Claude Opus 5.5 · Anthropic sub, fallback api) [provimux]",
				"    claude-opus-4-5 (Claude Opus 4.5 (latest)) [anthropic] · holds this sessi…",
				"    anthropic/claude-opus-5.5 (Claude Opus 5.5 · OpenRouter api) [provimux]",
				"    devin/claude-opus-5-5 (Claude Opus 5.5 (Devin) · Devin sub) [provimux]",
				"    claude-sonnet-4-6 [anthropic] · can't be used: it is the session's own mo…",
			]);
			// Pi's colours: the selected id and its marks in the accent colour, the name and the badge muted.
			const theme = getSelectListTheme();
			const raw = menu.raw(120);
			assert.ok(raw.includes(`${theme.selectedPrefix("→ ")}${theme.selectedPrefix("✓ ")}${theme.selectedText("default (devin/claude-opus-5-5 [provimux])")}`), raw.join("\n"));
			assert.ok(raw.includes(`    claude-opus-5-5 ${theme.description("(Claude Opus 5.5 · Anthropic sub, fallback api)")} ${theme.description("[provimux]")}${theme.description(" · 1M window · holds this session")}`), raw.join("\n"));
			// Searched by provider and by name, as Pi's picker searches.
			menu.keys("provimux");
			assert.ok(listOf(120).every((line) => line.includes("[provimux]")), listOf(120).join("\n"));
			assert.equal(listOf(120).filter((line) => / \[provimux\] · /.test(line)).length, 3);
			menu.keys("\x7f".repeat(8));
			menu.keys("devin");
			assert.match(listOf(120)[0], /^→ {3}devin\/claude-opus-5-5 \(Claude Opus 5\.5 \(Devin\) · Devin sub\) \[provimux\]/, "the best match first, selected");
			assert.ok(!listOf(120).some((line) => line.includes("[anthropic]")));
			menu.keys("\x7f".repeat(5));
			menu.keys("openrouter");
			assert.deepEqual(listOf(120), ["→   anthropic/claude-opus-5.5 (Claude Opus 5.5 · OpenRouter api) [provimux] · 1M window · holds this session"]);
			// Picked: saved as provider/id, shown as model-id [provider].
			menu.keys("\r");
			assert.match(menu.text(), /\n→ When the cache can't be used, compact with +anthropic\/claude-opus-5\.5 \[provimux\] · this session\n/);
			await menu.close();
			assert.deepEqual(ownOf(w.manager()), { settings: { fallbackCompactionModel: "provimux/anthropic/claude-opus-5.5" } });
			// Both agree it is an API key: the price stays.
			assert.equal(lineOf(await w.status(), "fallback compaction model ("), `fallback compaction model (asked to write the summary when the cache can't be used): anthropic/claude-opus-5.5 [provimux] (this session) · 1M window · $5.00 in, $25.00 out per M · ${DECIDED}`);
		},
		{ persisted: true },
	);
	assert.deepEqual(result.thrown, []);
});
