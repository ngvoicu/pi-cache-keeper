// The harness of the session-settings tests: Pi's real session runtime with this extension, in a temporary agent
// directory (set before anything reads it), an in-memory provider and no network. Not a test file itself: the tests
// import it, and a test that needs a fresh process runs a script that imports it there.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";

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


const { SESSION_SETTINGS_TYPE } = await import("../config.ts");

const base = new URL("../node_modules/@earendil-works/", import.meta.url);
export type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const load = async (path: string): Promise<Any> => import(new URL(path, base).href).catch(() => undefined);
const runtimeModule = await load("pi-coding-agent/dist/core/agent-session-runtime.js");
const servicesModule = await load("pi-coding-agent/dist/core/agent-session-services.js");
const sessionModule = await load("pi-coding-agent/dist/core/session-manager.js");
const catalog = await load("pi-ai/dist/models.generated.js");
const anthropic = await load("pi-ai/dist/api/anthropic-messages.js");
const transcript = await load("pi-ai/dist/utils/transcript.js");
/** Pi's own pi-messages adapter: a provider that streams Pi's events, which can end a reply in any way. */
export const piMessages = await load("pi-ai/dist/api/pi-messages.js");
// Pi's settings menu draws with Pi's theme.
const themeModule = await load("pi-coding-agent/dist/modes/interactive/theme/theme.js");
themeModule?.initTheme("dark", false);
const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
export const skip = themeModule && runtimeModule && servicesModule && sessionModule && catalog && anthropic && transcript ? false : "the installed Pi has no session runtime to drive";

const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
const STORE = Symbol.for("pi-cache-keeper.warm-misses");
const STOP_SEEN = Symbol.for("pi-cache-keeper.stop-seen");
export const flush = () => new Promise((resolve) => setImmediate(resolve));
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
// An answer with this text, as the Anthropic API streams it, from the in-memory provider.
export const textAnswer = (text: string) =>
	closed([
		messageStart(0, 0),
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } as { type: string },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } as { type: string },
		{ type: "content_block_stop", index: 0 } as { type: string },
		...end,
	]);
export { anthropic };
export const settingsFile = join(dir, "settings.json");
export const writeDefaults = (cacheKeeper: Record<string, unknown>) =>
	writeFileSync(settingsFile, JSON.stringify({ cacheKeeper: { modelData: false, cacheRetention: "short", compactAtPercent: 0, ...cacheKeeper }, cacheWarming: "idle", packages: [] }));

interface Menu {
	/** The menu as drawn, at 400 columns or the given width. */
	text: (width?: number) => string;
	/** The menu's lines as drawn at this width, with their styles (the selected row is styled). */
	raw: (width: number) => string[];
	/** Moves to the row with this label and presses Enter until its value reads `value`. */
	set: (label: string, value: string) => void;
	/** Presses Enter on the row with this label once. */
	press: (label: string) => void;
	/** Closes the menu (Escape). */
	close: () => Promise<void>;
	/** Sends keys as typed (a list opened from a row takes them). */
	keys: (data: string) => void;
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
	/** When the extension started each compaction (Pi's compaction itself is not run). */
	compactAt: number[];
	/** The refreshes the extension has sent so far. */
	refreshCount: () => number;
}

// Pi's real session runtime with this extension in its TUI mode, Claude Sonnet 4.6 on Anthropic's API with the 5-minute
// cache. Each refresh the extension sends goes through the real Anthropic adapter to an in-memory provider that reads
// the whole cache; `refreshes` counts them.
export async function inWindow(scenario: (w: Window) => Promise<void>, o: { persisted?: boolean; mode?: "tui" | "rpc"; realCompact?: boolean } = {}) {
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
	const compactAt: number[] = [];
	const bind = async (session: Any) => {
		const runner = session.extensionRunner;
		// Pi's compaction itself is not run, unless the test asks for it.
		if (!o.realCompact) {
			session.compact = async () => {
				compactAt.push(Date.now());
			};
		}
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
		// The in-memory provider. Where the extension passes its own transport (it checks, then hands the request to the
		// global fetch), the request goes through it to this one, as it would to the network.
		const transport = async () => (refreshes++, closed([messageStart(120_000, 0), ...end]));
		const through = (own: Any) => (input: unknown, init: unknown) => {
			const real = globalThis.fetch;
			globalThis.fetch = transport as typeof fetch;
			try {
				return own(input, init);
			} finally {
				globalThis.fetch = real;
			}
		};
		runner.createContext().modelRegistry.streamSimple = (m: Any, context: Any, options: Any) =>
			anthropic.streamSimple(m, context, { ...options, apiKey: "sk-fixture", maxRetries: 0, cacheRetention: "short", fetch: options.fetch ? through(options.fetch) : transport });
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
		compactAt,
		refreshCount: () => refreshes,
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
			const lines = (width = 400) => component.render(width).map(plain);
			const selected = () => lines().find((line: string) => line.startsWith("→"));
			const row = (label: string) => lines().find((line: string) => line.replace(/^→?\s*/, "").startsWith(label));
			const goTo = (label: string) => {
				for (let i = 0; i < 20 && !selected()?.replace(/^→\s*/, "").startsWith(label); i++) component.handleInput("\x1b[B");
				assert.ok(selected()?.replace(/^→\s*/, "").startsWith(label), `the row ${label}`);
			};
			return {
				text: (width) => lines(width).join("\n"),
				raw: (width) => component.render(width),
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
				keys: (data) => {
					for (const key of data.match(/\x1b\[[A-D]|[\s\S]/g) ?? []) component.handleInput(key);
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

export const ownEntries = (manager: Any) => manager.getBranch().filter((e: Any) => e.type === "custom" && e.customType === SESSION_SETTINGS_TYPE);

export const ownOf = (manager: Any) => ownEntries(manager).at(-1)?.data;
export const settingsText = () => readFileSync(settingsFile, "utf8");
export const KEEP_WARM = "Keep the cache warm when idle";
export const FULL = "Compact when the context is";
export const EXPIRY = "Compact before the cache expires";
export const FALLBACK = "When the cache can't be used, compact with";
export const NO_OWN = "settings: the defaults (this session has none of its own) · /cache-keeper-settings";
export const OWN = "settings: this session's own: compactAtPercent 80% (default off), keepWarmMinutes 4 h (default off); every other follows the defaults · /cache-keeper-settings";
export const lineOf = (text: string, start: string) => text.split("\n").find((line) => line.startsWith(start));

export { dir };
