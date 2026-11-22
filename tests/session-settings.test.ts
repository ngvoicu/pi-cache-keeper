// Settings per session over the defaults: the two layers, their entry in the session (resume, fork, a branch switch,
// back to the defaults, a session without one), the menu and /cache-keeper, and keep-warm reading the session's own
// value. The real parts run in Pi's own session runtime, with a temporary agent directory and no network.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "pcc-session-settings-"));
process.env.PI_CODING_AGENT_DIR = dir;
const cwd = join(dir, "project");
mkdirSync(cwd);
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => {
	throw new Error("no network in tests");
}) as typeof fetch;
process.on("exit", () => {
	globalThis.fetch = realFetch;
	rmSync(dir, { recursive: true, force: true });
});

const {
	GLOBAL_ONLY_KEYS,
	loadConfig,
	readSessionSettings,
	SESSION_KEYS,
	SESSION_SETTINGS_TYPE,
	sessionSettingsOn,
	settingsInEffect,
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

// ------------------------------------------------------------------------------------------- Pi's real runtime

const base = new URL("../node_modules/@earendil-works/", import.meta.url);
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const load = async (path: string): Promise<Any> => import(new URL(path, base).href).catch(() => undefined);
const runtimeModule = await load("pi-coding-agent/dist/core/agent-session-runtime.js");
const servicesModule = await load("pi-coding-agent/dist/core/agent-session-services.js");
const sessionModule = await load("pi-coding-agent/dist/core/session-manager.js");
const catalog = await load("pi-ai/dist/models.generated.js");
const anthropic = await load("pi-ai/dist/api/anthropic-messages.js");
const transcript = await load("pi-ai/dist/utils/transcript.js");
// Pi's settings menu draws with Pi's theme.
const themeModule = await load("pi-coding-agent/dist/modes/interactive/theme/theme.js");
themeModule?.initTheme("dark", false);
const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
const skip = themeModule && runtimeModule && servicesModule && sessionModule && catalog && anthropic && transcript ? false : "the installed Pi has no session runtime to drive";

const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
const STORE = Symbol.for("pi-cache-keeper.warm-misses");
const STOP_SEEN = Symbol.for("pi-cache-keeper.stop-seen");
const flush = () => new Promise((resolve) => setImmediate(resolve));
const encoder = new TextEncoder();
const packet = (event: { type: string }) => encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
const usage = (read: number, write: number) => ({
	input_tokens: 5,
	cache_read_input_tokens: read,
	cache_creation_input_tokens: write,
	output_tokens: 1,
	cache_creation: { ephemeral_5m_input_tokens: write, ephemeral_1h_input_tokens: 0 },
});
const messageStart = (read: number, write: number) => ({ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [], stop_reason: null, usage: usage(read, write) } });
const end = [{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }, { type: "message_stop" }];
const closed = (events: { type: string }[]) =>
	new Response(
		new ReadableStream({
			start(c) {
				for (const e of events) c.enqueue(packet(e));
				c.close();
			},
		}),
		{ headers: { "content-type": "text/event-stream" } },
	);
const settingsFile = join(dir, "settings.json");
const writeDefaults = (cacheKeeper: Record<string, unknown>) =>
	writeFileSync(settingsFile, JSON.stringify({ cacheKeeper: { modelData: false, cacheRetention: "short", compactAtPercent: 0, ...cacheKeeper }, cacheWarming: "idle", packages: [] }));

interface Menu {
	/** The menu as drawn. */
	text: () => string;
	/** Moves to the row with this label and presses Enter until its value reads `value`. */
	set: (label: string, value: string) => void;
	/** Presses Enter on the row with this label once. */
	press: (label: string) => void;
	/** Closes the menu (Escape). */
	close: () => Promise<void>;
}

interface Window {
	runtime: Any;
	/** The session's manager now (it changes with a resume or fork). */
	manager: () => Any;
	/** One real request and its answer, which read the whole cache; then Pi goes idle. */
	answer: () => Promise<void>;
	ticks: (seconds: number) => Promise<void>;
	decide: () => Promise<unknown>;
	/** /cache-keeper's text. */
	status: () => Promise<string>;
	/** /cache-keeper-settings, opened. */
	menu: () => Promise<Menu>;
	/** The extension's footer as last set. */
	footer: () => string | undefined;
	/** The log's warm records. */
	warmLog: () => Any[];
}

// Pi's real session runtime with this extension in its TUI mode, Claude Sonnet 4.6 on Anthropic's API with the 5-minute
// cache. Each refresh the extension sends goes through the real Anthropic adapter to an in-memory provider that reads
// the whole cache; `refreshes` counts them.
async function inWindow(scenario: (w: Window) => Promise<void>, o: { persisted?: boolean; mode?: "tui" | "rpc" } = {}) {
	delete (globalThis as Record<symbol, unknown>)[STORE];
	delete (globalThis as Record<symbol, unknown>)[STOP_SEEN];
	rmSync(join(dir, "cache-keeper-stop.json"), { force: true });
	rmSync(join(dir, "cache-keeper.jsonl"), { force: true });
	const model = catalog.MODELS.anthropic["claude-sonnet-4-6"];
	const loader = {
		additionalExtensionPaths: [new URL("../index.ts", import.meta.url).pathname],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		disabledBuiltinExtensions: ["mcp", "codemode", "tool-search"],
		systemPrompt: "Review code.",
	};
	const factory = async ({ sessionManager, sessionStartEvent }: Any) => {
		const services = await servicesModule.createAgentSessionServices({ cwd, agentDir: dir, resourceLoaderOptions: loader });
		const { session } = await servicesModule.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model });
		return { session, services, diagnostics: services.diagnostics };
	};
	mock.timers.reset();
	mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 100_000_000 });
	const runtime = await runtimeModule.createAgentSessionRuntime(factory, {
		cwd,
		agentDir: dir,
		sessionManager: o.persisted ? sessionModule.SessionManager.create(cwd, join(dir, "sessions")) : sessionModule.SessionManager.inMemory(cwd),
	});
	const thrown: unknown[] = [];
	const onThrow = (error: unknown) => thrown.push(error);
	process.on("uncaughtException", onThrow);
	process.on("unhandledRejection", onThrow);
	let lastStatus: string | undefined;
	const notes: string[] = [];
	let shown: { component: Any; done: Promise<void> } | undefined;
	let refreshes = 0;
	const bind = async (session: Any) => {
		const runner = session.extensionRunner;
		const theme = { fg: (_tone: string, text: string) => text, bg: (_tone: string, text: string) => text, bold: (text: string) => text };
		const uiContext = {
			...runner.getUIContext(),
			theme,
			notify: (text: string) => notes.push(text),
			setStatus: (_key: string, text: string | undefined) => (lastStatus = text),
			custom: (build: Any) => {
				let finish: () => void = () => {};
				const done = new Promise<void>((resolve) => (finish = resolve));
				shown = { component: build({ requestRender() {} }, theme, null, () => finish()), done };
				return done;
			},
		};
		await session.bindExtensions({ mode: o.mode ?? "tui", uiContext, onError: () => {} });
		runner.createContext().modelRegistry.streamSimple = (m: Any, context: Any, options: Any) =>
			anthropic.streamSimple(m, context, { ...options, apiKey: "sk-fixture", maxRetries: 0, cacheRetention: "short", fetch: async () => (refreshes++, closed([messageStart(120_000, 0), ...end])) });
	};
	runtime.setRebindSession(bind);
	await bind(runtime.session);
	const runner = () => runtime.session.extensionRunner;
	const command = async (name: string) => {
		notes.length = 0;
		const ctx = runner().createCommandContext();
		await runner().getCommand(name).handler("", ctx);
		return notes.join("\n");
	};
	const window: Window = {
		runtime,
		manager: () => runtime.session.sessionManager,
		answer: async () => {
			const r = runner();
			const sessions = runtime.session.sessionManager;
			await r.emit({ type: "agent_start" });
			const prior = sessions.buildSessionProjection().messages;
			const ask = { role: "user", timestamp: Date.now(), content: [{ type: "text", text: prior.length ? "Continue." : "Read the change." }] };
			sessions.appendMessage(ask);
			const messages = await r.emitContext(transcript.normalizeContext({ systemPrompt: "Review code.", messages: [...prior, ask], tools }).messages);
			const answer = await anthropic
				.streamSimple(model, { messages }, {
					apiKey: "sk-fixture",
					maxTokens: 8192,
					cacheRetention: "short",
					onPayload: (payload: unknown) => r.emitBeforeProviderRequest(payload),
					fetch: async () => closed([messageStart(120_000, 0), ...end]),
				})
				.result();
			assert.equal(answer.stopReason, "stop");
			await r.emitMessageEnd({ type: "message_end", message: answer });
			sessions.appendMessage(answer);
			await r.emit({ type: "agent_settled", aborted: false });
		},
		ticks: async (seconds) => {
			for (let i = 0; i < seconds; i++) {
				mock.timers.tick(1000);
				await flush();
			}
		},
		decide: () => runner().emitCacheWarmingDecision({ type: "cache_warming_decision", action: "warm", timestamp: Date.now() }),
		status: () => command("cache-keeper"),
		menu: async () => {
			shown = undefined;
			const opened = command("cache-keeper-settings");
			await flush();
			const current = shown as { component: Any; done: Promise<void> } | undefined;
			assert.ok(current, "the settings menu");
			const { component, done } = current;
			const lines = () => component.render(400).map(plain);
			const selected = () => lines().find((line: string) => line.startsWith("→"));
			const row = (label: string) => lines().find((line: string) => line.replace(/^→?\s*/, "").startsWith(label));
			const goTo = (label: string) => {
				for (let i = 0; i < 20 && !selected()?.replace(/^→\s*/, "").startsWith(label); i++) component.handleInput("\x1b[B");
				assert.ok(selected()?.replace(/^→\s*/, "").startsWith(label), `the row ${label}`);
			};
			return {
				text: () => lines().join("\n"),
				press: (label) => {
					goTo(label);
					component.handleInput(" ");
				},
				set: (label, value) => {
					goTo(label);
					for (let i = 0; i < 20 && !row(label)?.endsWith(value); i++) component.handleInput(" ");
					assert.ok(row(label)?.endsWith(value), `${label}: ${value} (${row(label)})`);
				},
				close: async () => {
					component.handleInput("\x1b");
					await done;
					await opened;
				},
			};
		},
		footer: () => lastStatus,
		warmLog: () =>
			readFileSync(join(dir, "cache-keeper.jsonl"), "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
				.filter((r) => r.event === "warm"),
	};
	try {
		await scenario(window);
	} finally {
		mock.timers.reset();
		await runtime.dispose();
		process.off("uncaughtException", onThrow);
		process.off("unhandledRejection", onThrow);
	}
	return { thrown, refreshes };
}

const ownEntries = (manager: Any) => manager.getBranch().filter((e: Any) => e.type === "custom" && e.customType === SESSION_SETTINGS_TYPE);

const ownOf = (manager: Any) => ownEntries(manager).at(-1)?.data;
const settingsText = () => readFileSync(settingsFile, "utf8");
const KEEP_WARM = "Keep the cache warm when idle";
const FULL = "Compact when the context is";
const EXPIRY = "Compact before the cache expires";
const NO_OWN = "settings: the defaults (this session has none of its own) · /cache-keeper-settings";
const OWN = "settings: this session's own: compactAtPercent 80% (default off), keepWarmMinutes 4 h (default off); every other follows the defaults · /cache-keeper-settings";
const lineOf = (text: string, start: string) => text.split("\n").find((line) => line.startsWith(start));

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
			assert.match(status, /\nwhen full \(this session\): at 80%: 800k of 1000k on anthropic\/claude-sonnet-4-6/);
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
