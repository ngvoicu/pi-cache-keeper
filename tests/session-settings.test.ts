// Settings per session over the defaults: the two layers, their entry in the session (resume, fork, a branch switch,
// back to the defaults, a session without one), the menu and /cache-keeper, and keep-warm reading the session's own
// value. The real parts run in Pi's own session runtime, with a temporary agent directory and no network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EXPIRY, flush, FULL, inWindow, KEEP_WARM, lineOf, NO_OWN, OWN, ownEntries, ownOf, settingsText, skip, writeDefaults, type Any } from "./session-runtime.ts";

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

const DEFAULTS = { cacheRetention: "long", compactBeforeExpiry: true, minContextTokens: 140_000, compactAtPercent: 90, compactAtTokens: 0, keepWarmMinutes: 0, modelData: true } as const;
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
	assert.deepEqual([...SESSION_KEYS].sort(), ["compactAtPercent", "compactAtTokens", "compactBeforeExpiry", "keepWarmMinutes", "minContextTokens"]);
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


test("the menu opens on this session; values set there are saved in the session when it closes, never in settings.json; they hold after a resume, follow a branch switch and a fork, and /cache-keeper marks them", { skip }, async () => {
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
			assert.match(status, /\nwhen full: at 80% \(this session\): 800k of 1000k on anthropic\/claude-sonnet-4-6/);
			assert.match(status, /\nkeep warm \(this session\): up to 4 h after Pi goes idle/);
			assert.match(status, /\nbefore expiry: on, from 140k tokens of context · retention short\n/, "a key it didn't set: unmarked");
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
			assert.match(status2, /\nkeep warm: off\n/);
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

test("back to the defaults drops the session's own values, in the session; another session keeps its own", { skip }, async () => {
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

test("the defaults are one step away in the menu: changed there, they are saved in settings.json, and hold in this session only for keys it didn't set", { skip }, async () => {
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
		assert.match(status, /\nkeep warm \(this session\): up to 4 h after Pi goes idle/, "its own value wins");
		assert.match(status, /\nbefore expiry: off · retention short\n/, "the changed default holds where it set nothing");
		assert.equal(lineOf(status, "settings:"), "settings: this session's own: keepWarmMinutes 4 h (default 1 h); every other follows the defaults · /cache-keeper-settings");
		// The menu opens on this session again, the default shown beside its own value.
		menu = await w.menu();
		assert.match(menu.text(), /\n→ Editing +this session\n/);
		assert.match(menu.text(), /\n {2}Compact before the cache expires +off · default\n/);
		await menu.close();
	});
	assert.deepEqual(result.thrown, []);
});

test("an old session without the entry has the defaults; an entry holding global-only keys is read without them", { skip }, async () => {
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
			assert.equal(lineOf(status, "settings:"), "settings: this session's own: keepWarmMinutes 30 min (default off); every other follows the defaults · /cache-keeper-settings");
			assert.match(status, /· retention short\n/, "cacheRetention stays the default's");
			assert.equal(process.env.PI_CACHE_RETENTION, undefined);
		},
		{ persisted: true },
	);
	assert.deepEqual(result.thrown, []);
});

test("outside the TUI, /cache-keeper-settings lists both layers", { skip }, async () => {
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
		assert.match(lines[1], /^compactAtPercent: 0 \[default\] · compactAtTokens: 400000 \[this session; default 0\] \(at the 400k-token cap/);
		assert.equal(lines[2], "compactBeforeExpiry: true [default] · minContextTokens: 140000 [default]");
		assert.match(lines[3], /^keepWarmMinutes: 240 \[this session; default 120\] \(up to 4 h after Pi goes idle/);
		assert.equal(lines[4], "cacheRetention: short (all sessions)");
		assert.match(lines[5], /^modelData: false \(all sessions\) \(off\)$/);
		assert.equal(lines[6], "This session's own: compactAtTokens 400k tokens (default off), keepWarmMinutes 4 h (default 2 h); every other setting follows the defaults.");
	}, { mode: "rpc", persisted: true });
	assert.deepEqual(result.thrown, []);
});

// ------------------------------------------------------------------------------------------------------ keep-warm

test("keep-warm reads the session's own keepWarmMinutes: on over a default of off, off over a default of on, and it holds when the default changes in another window", { skip }, async () => {
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
	test(`keep-warm switched ${turn} during an idle period for this session behaves as switching the default ${turn} does`, { skip }, async () => {
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
	test(`a refresh being prepared when the time limit is shortened to 30 min (${change}) does not go out`, { skip }, async () => {
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
				seen.status = lineOf(await w.status(), "keep warm");
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
test("back to the defaults after another window turned compactBeforeExpiry off: no compaction before expiry", { skip }, async () => {
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
			seen.status = lineOf(await w.status(), "before expiry");
			await w.ticks(182);
			seen.compactions = w.compactAt.map((at) => (at - start) / 1000);
		},
		{ persisted: true },
	);
	assert.deepEqual(result.thrown, []);
	assert.equal(seen.status, "before expiry: off · retention short");
	assert.deepEqual(seen.compactions, [], "nothing compacted at 280 s");
});

for (const kind of ["expiry", "full"] as const) {
	test(`a default saved in another window after this one started holds here: ${kind === "expiry" ? "compactBeforeExpiry turned off" : "the compactAtTokens cap turned off"}`, { skip }, async () => {
		writeDefaults({ keepWarmMinutes: 0, compactAtPercent: 0, compactAtTokens: kind === "full" ? 100_000 : 0, compactBeforeExpiry: kind === "expiry", minContextTokens: 100_000 });
		const seen: Any = {};
		const result = await inWindow(
			async (w) => {
				if (kind === "expiry") {
					await w.answer();
					await w.ticks(100);
				}
				saveConfig(kind === "expiry" ? { compactBeforeExpiry: false } : { compactAtTokens: 0 });
				seen.status = lineOf(await w.status(), kind === "expiry" ? "before expiry" : "when full");
				if (kind === "full") await w.answer();
				else await w.ticks(182);
				seen.compactions = w.compactAt.length;
			},
			{ persisted: true },
		);
		assert.deepEqual(result.thrown, []);
		assert.equal(seen.status, kind === "expiry" ? "before expiry: off · retention short" : "when full: off: Pi compacts only when the window is nearly full, often with too little room left for a cached summary");
		assert.equal(seen.compactions, 0);
	});
}

test("/cache-keeper marks each value by where it comes from", { skip }, async () => {
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
			assert.equal(lineOf(status, "when full"), "when full: at 90%: 900k of 1000k on anthropic/claude-sonnet-4-6, leaving 96k for the summary");
			assert.equal(lineOf(status, "before expiry"), "before expiry: off · retention short");
			assert.equal(lineOf(status, "settings:"), "settings: this session's own: compactAtTokens off (default off), minContextTokens 200k (default 140k); every other follows the defaults · /cache-keeper-settings");
			menu = await w.menu();
			menu.set(EXPIRY, "on · this session");
			menu.set("Or once it holds", "400k tokens · this session");
			await menu.close();
			status = await w.status();
			assert.equal(lineOf(status, "when full"), "when full: at the 400k-token cap (this session) on anthropic/claude-sonnet-4-6, leaving 128k for the summary");
			assert.equal(lineOf(status, "before expiry"), "before expiry: on (this session), from 200k tokens of context (this session) · retention short");
			menu = await w.menu();
			menu.set("Compact when the context is", "off · this session");
			menu.set("Or once it holds", "off · this session");
			await menu.close();
			assert.equal(lineOf(await w.status(), "when full"), "when full: off (this session): Pi compacts only when the window is nearly full, often with too little room left for a cached summary");
		},
		{ persisted: true },
	);
	assert.deepEqual(result.thrown, []);
});

// ------------------------------------------------------------------------------------------- the last round

// The reviewer's case: refresh 7's payload passes the last gate under a 2-hour default at 32 min 05 s idle; in the
// microtask right after, before the adapter hands the request to its transport, another window saves a 30-minute
// default. The check at the send stops it.
test("a 30-minute default saved after the payload passed, before the transport: refresh 7 does not reach the transport", { skip }, async () => {
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
	test(`a default saved right after this window read the defaults at its start holds at the first decision (${kind === "expiry" ? "compactBeforeExpiry off" : "the cap off"})`, { skip }, () => {
		const child = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("fixtures/startup-race.ts", import.meta.url)), kind], { encoding: "utf8", timeout: 60_000 });
		assert.equal(child.status, 0, child.stderr);
		const seen = JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "{}");
		assert.equal(seen.savedDuringStartup, true, "saved during the startup read");
		assert.equal(seen.thrown, 0);
		assert.equal(seen.status, kind === "expiry" ? "before expiry: off · retention short" : "when full: off: Pi compacts only when the window is nearly full, often with too little room left for a cached summary");
		assert.equal(seen.calls, 0, "no compaction");
	});
}

// The reviewer's case: the session's own 150k cap left the context at 160k after a compaction; another window changes the
// default cap, which this session overrides. Nothing in effect changed, so nothing is tried again.
test("a change of a default the session overrides does not try compacting when full again", { skip }, async () => {
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
			seen.status = lineOf(await w.status(), "when full");
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
	assert.match(seen.status, /^when full: at the 150k-token cap \(this session\) on /);
	assert.equal(seen.changedOwn, 2, "the cap in effect changed: tried again");
});
