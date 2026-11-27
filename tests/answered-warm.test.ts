// Keep-warm through Provimux when the gateway names the providers.dev entry of what answered (the review of 2026-11-27,
// its harness: route-clock-flow.test.ts's, every request built by Pi's real adapter and answered from an in-memory
// transport that keeps the provider's cache). An answer from an account the gateway fell back to is shown and never kept
// warm; one from the route's first account is kept warm, each refresh booked at that entry's prices. Nothing leaves the
// process: the global fetch throws.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "pck-answered-warm-"));
process.env.PI_CODING_AGENT_DIR = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const { default: cacheKeeper } = await import("../index.ts");
const { formatRemaining } = await import("../trace.ts");
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => {
	throw new Error("no network in tests");
}) as typeof fetch;
process.on("exit", () => (globalThis.fetch = realFetch));

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const catalogFile = new URL("../node_modules/@earendil-works/pi-ai/dist/models.generated.js", import.meta.url);
const warmerFile = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/cache-warmer.js", import.meta.url);
const { MODELS } = await import(catalogFile.href);
const { CacheWarmer } = await import(warmerFile.href);
// Pi's settings menu draws with Pi's theme.
const themeFile = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js", import.meta.url);
(await import(themeFile.href)).initTheme("dark", false);
const { normalizeContext } = (await import("@earendil-works/pi-ai/utils/transcript")) as { normalizeContext: (context: unknown) => { messages: unknown[] } };
const adapter = async (api: string) => (await import(`@earendil-works/pi-ai/api/${api}`)) as { streamSimple: (model: unknown, context: unknown, options: unknown) => { result: () => Promise<Any> } };

const flush = () => new Promise((resolve) => setImmediate(resolve));
const START = 10_000;
let sessions = 0;
const sec = () => (Date.now() - START) / 1000;
const user = { role: "user", content: [{ type: "text", text: "Explain the changes in detail." }], timestamp: START - 100 };
const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
const transcript = normalizeContext({ systemPrompt: "You are pi.", messages: [user], tools }).messages;

// A provider's answer, as its stream reports it: what was read from the cache, what was written and into which cache
// (Anthropic reports the 1-hour part; Chat Completions only what was read).
function answer(api: string, prompt: number, read: number, write: number, oneHour: number, output: number, toolCall = false): Response {
	const events: unknown[] =
		api === "anthropic-messages"
			? [
					{ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "m", content: [], usage: { input_tokens: prompt - read - write, output_tokens: 1, cache_read_input_tokens: read, cache_creation_input_tokens: write, cache_creation: { ephemeral_5m_input_tokens: write - oneHour, ephemeral_1h_input_tokens: oneHour } } } },
					...(toolCall
						? [
								{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} } },
								{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a.ts"}' } },
							]
						: [
								{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
								{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checkpoint." } },
							]),
					{ type: "content_block_stop", index: 0 },
					{ type: "message_delta", delta: { stop_reason: toolCall ? "tool_use" : "end_turn" }, usage: { output_tokens: output } },
					{ type: "message_stop" },
				]
			: [
					{ id: "c", model: "m", object: "chat.completion.chunk", created: 0, choices: [{ index: 0, delta: { role: "assistant", content: "Checkpoint." }, finish_reason: "stop" }] },
					{ id: "c", model: "m", object: "chat.completion.chunk", created: 0, choices: [], usage: { prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output, prompt_tokens_details: { cached_tokens: read } } },
				];
	const text = events.map((e) => `${api === "anthropic-messages" ? `event: ${(e as { type: string }).type}\n` : ""}data: ${JSON.stringify(e)}\n\n`).join("") + (api === "anthropic-messages" ? "" : "data: [DONE]\n\n");
	return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

type Kind = "refresh" | "summary" | "pi" | "answer";
interface Wire {
	at: number;
	kind: Kind;
	read: number;
	write: number;
	cap?: number;
	/** The provider rejected the request (a 400). */
	rejected?: true;
}
type Served = { read: number; write: number; oneHour: number; toolCall?: boolean } | { reject: string };
interface Setup {
	model: Any;
	/** The proxy's routes and providers.dev's lifetimes for them (the extension's saved data). */
	store: Record<string, unknown>;
	settings: Record<string, unknown>;
	/** The prompt's size; the period's answer, as the provider reports it. */
	prompt: number;
	answered: { read: number; write: number; oneHour: number };
	/** The provider: given what is sent and when (and the request's body), what is read and written, and into which
	 * cache; or that it rejects the request. */
	serve: (w: { kind: Kind; at: number; body: Any }) => Served;
	/** The tools in the period's context (the default: one plain `read` tool). */
	tools?: Any[];
	/** The period's run sends its request(s) to the provider through Pi's adapter, and its answer is the adapter's own
	 * message (with what the adapter noted on it): one request, or two where the first answer calls a tool. */
	send?: { legs: 1 | 2 };
	/** Called just before the extension's payload hook of a request it sends (a credential lookup, say). */
	beforeHook?: (kind: Kind) => void;
	/** Pi's own warmer runs beside the extension, started with the period's request, asking the extension each time. */
	piWarmer?: boolean;
	/** What happens while the period's request is out, after it was sent and before its answer ends (a proxy's report). */
	whileOut?: (announce: (upstreams: readonly unknown[]) => void) => void;
	/** What happens in the period's run after its answer, before Pi goes idle (a proxy's reports, say). */
	afterAnswer?: (run: { announce: (upstreams: readonly unknown[]) => void; until: (at: number) => Promise<void> }) => Promise<void> | void;
}

// One session: the period's request built by Pi's real adapter and answered at 0 s (Pi idle from then), the extension's
// refreshes and summaries through the same adapter, Pi's own warmer (when started) through it too.
async function session(s: Setup) {
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ cacheKeeper: { modelData: false, cacheRetention: "short", compactAtPercent: 0, minContextTokens: 140_000, ...s.settings } }));
	writeFileSync(join(dir, "cache-keeper-models.json"), JSON.stringify({ version: 1, written: {}, ...s.store }));
	writeFileSync(join(dir, "cache-keeper.jsonl"), "");
	delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-cache-keeper.warm-misses")];
	delete process.env.PI_CACHE_RETENTION;
	mock.timers.reset();
	mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: START - 100 });
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
	const bus = new Map<string, (payload: unknown) => void>();
	cacheKeeper({
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
		registerEntryRenderer: () => {},
		events: { on: (name: string, handler: (payload: unknown) => void) => (bus.set(name, handler), () => {}), emit: () => {} },
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => unknown }) => commands.set(name, command.handler),
		appendEntry: () => {},
		getThinkingLevel: () => "off",
	} as never);
	// What pi-provimux tells before an answer (its entry and account) reaches the extension's own handler.
	entryEvent = (payload) => bus.get("model-upstreams:answered-entry")?.(payload);
	const { streamSimple } = await adapter(s.model.api);
	const wires: Wire[] = [];
	const statuses: string[] = [];
	const notes: string[] = [];
	const branch: Any[] = [];
	let compaction: Promise<unknown> | undefined;
	const compactions: number[] = [];
	// Pi's settings menu, as /cache-keeper-settings builds it.
	let menu: Any;
	// The in-memory provider: what each request reads and writes.
	const transport = (kind: Kind) => async (_input: unknown, init?: { body?: unknown }) => {
		const body = JSON.parse(String(init?.body));
		const used = s.serve({ kind, at: sec(), body });
		const cap = body.max_tokens ?? body.max_completion_tokens;
		if ("reject" in used) {
			wires.push({ at: sec(), kind, read: 0, write: 0, cap, rejected: true });
			return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: used.reject } }), { status: 400, headers: { "content-type": "application/json" } });
		}
		wires.push({ at: sec(), kind, read: used.read, write: used.write, cap });
		return answer(s.model.api, s.prompt + 4, used.read, used.write, used.oneHour, kind === "summary" ? 20 : 1, used.toolCall);
	};
	// The session's id, for Pi's adapter: it remembers per session that strict tools were rejected.
	const sessionId = `route-clock-${++sessions}`;
	const sent = s.tools ? normalizeContext({ systemPrompt: "You are pi.", messages: [user], tools: s.tools }).messages : transcript;
	const ctx: Any = {
		hasUI: true,
		mode: "tui",
		cwd: dir,
		model: s.model,
		isIdle: () => true,
		hasPendingMessages: () => false,
		isProjectTrusted: () => false,
		getContextUsage: () => ({ tokens: s.prompt }),
		ui: {
			setStatus: (key: string, text: string) => key === "cache-keeper" && statuses.push(text),
			notify: (text: string) => notes.push(text),
			theme: { fg: (_c: string, text: string) => text, bold: (text: string) => text },
			custom: async (build: Any) => {
				menu = build({ requestRender() {} }, { fg: (_c: string, text: string) => text, bold: (text: string) => text }, null, () => {});
			},
		},
		sessionManager: {
			getBranch: () => branch,
			getSessionId: () => "s1",
			getSessionFile: () => undefined,
			appendUsage: (kind: string, provider: string, model: string, usage: unknown) => {
				const entry = { type: "usage", id: `w${branch.length}`, parentId: branch.at(-1)?.id ?? null, kind, provider, model, usage, timestamp: new Date().toISOString() };
				branch.push(entry);
				return entry;
			},
		},
		modelRegistry: {
			isUsingOAuth: () => false,
			getProvider: () => undefined,
			getAvailable: () => [s.model],
			streamSimple: (m: Any, context: unknown, options: Any) => {
				const kind: Kind = options.maxTokens === 1 ? "refresh" : "summary";
				return streamSimple(m, context, {
					...options,
					apiKey: "sk-fixture",
					maxRetries: 0,
					cacheRetention: "short",
					onPayload: async (params: unknown) => {
						s.beforeHook?.(kind);
						return options.onPayload(params);
					},
					fetch: transport(kind),
				});
			},
		},
		compact: () => {
			compactions.push(sec());
			compaction = emit("session_before_compact", {
				reason: "manual",
				branchEntries: [...branch],
				signal: new AbortController().signal,
				preparation: { tokensBefore: s.prompt, firstKeptEntryId: "u", messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false, fileOps: { read: new Set(), written: new Set(), edited: new Set() }, settings: { reserveTokens: 16_384, keepRecentTokens: 20_000 } },
			}) as Promise<unknown>;
		},
	};
	const emit = (event: string, payload: unknown = {}) => handlers.get(event)?.(payload, ctx);
	// What a proxy says served a request of a model (by default the period's).
	const announceFor = (model: string, upstreams: readonly unknown[]) => bus.get("model-upstreams:answered")?.({ provider: s.model.provider, model, upstreams });
	const announce = (upstreams: readonly unknown[]) => announceFor(s.model.id, upstreams);
	const until = async (at: number, each?: () => void | Promise<void>) => {
		while (sec() < at) {
			mock.timers.tick(1000);
			await flush();
			await flush();
			await each?.();
		}
		if (compaction) await compaction;
	};
	emit("session_start");
	// Pi's own warmer: its refreshes through the same adapter and provider; its questions to the extension, recorded.
	const decisions: { at: number; answer: string | undefined }[] = [];
	const warmer =
		s.piWarmer && CacheWarmer
			? new CacheWarmer({ streamSimple: (m: Any, context: unknown, options: Any) => streamSimple(m, context, { ...options, apiKey: "sk-fixture", maxRetries: 0, sessionId, fetch: transport("pi") }) }, ctx.sessionManager, () => "idle", async (event: { action: string }) => {
					const result = emit("cache_warming_decision", event) as { action?: string } | undefined;
					decisions.push({ at: Math.round(sec()), answer: result?.action });
					return result?.action ?? event.action;
				})
			: undefined;
	// The period's run: its request, as Pi sends it, and its answer at 0 s.
	emit("agent_start");
	emit("context_with_system", { messages: sent });
	// A request of Pi's, through its adapter and the extension's payload hook (each form the adapter builds).
	const ask = (messages: unknown[], kind: Kind) =>
		streamSimple(s.model, { messages }, {
			apiKey: "sk-fixture",
			maxTokens: 8192,
			cacheRetention: "short",
			maxRetries: 0,
			sessionId,
			onPayload: async (payload: Record<string, unknown>) => (await emit("before_provider_request", { payload })) ?? payload,
			fetch: transport(kind),
		}).result();
	if (s.send) {
		mock.timers.setTime(START);
		branch.push({ type: "message", id: "u", parentId: null, timestamp: new Date(START - 100).toISOString(), message: user });
		let messages: unknown[] = sent;
		for (let leg = 1; leg <= s.send.legs; leg++) {
			const reply = await ask(messages, "answer");
			assert.notEqual(reply.stopReason, "error", reply.errorMessage);
			if (leg === s.send.legs) s.whileOut?.(announce);
			emit("message_end", { message: reply });
			branch.push({ type: "message", id: leg === s.send.legs ? "a" : `a${leg}`, parentId: branch.at(-1).id, timestamp: new Date(START).toISOString(), message: reply });
			if (leg === s.send.legs) break;
			const result = { role: "toolResult", toolCallId: "toolu_1", toolName: "read", content: [{ type: "text", text: "export {};" }], isError: false, timestamp: START };
			branch.push({ type: "message", id: `r${leg}`, parentId: branch.at(-1).id, timestamp: new Date(START).toISOString(), message: result });
			messages = [...messages, reply, result];
			emit("context_with_system", { messages });
		}
		warmer?.start({ model: s.model, context: { messages: sent }, options: { cacheRetention: "short", sessionId } }, () => true);
	} else {
		let original: unknown;
		await streamSimple(s.model, { messages: sent }, {
			apiKey: "sk-fixture",
			maxTokens: 8192,
			cacheRetention: "short",
			maxRetries: 0,
			onPayload: async (payload: Record<string, unknown>) => {
				original = (await emit("before_provider_request", { payload })) ?? payload;
				throw new Error("captured without transport");
			},
		}).result();
		assert.ok(original, "the adapter built the period's request");
		warmer?.start({ model: s.model, context: { messages: sent }, options: { cacheRetention: "short" } }, () => true);
		mock.timers.setTime(START);
		const { read, write, oneHour } = s.answered;
		const usage = { input: s.prompt - read - write, output: 5, cacheRead: read, cacheWrite: write, ...(s.model.api === "anthropic-messages" ? { cacheWrite1h: oneHour } : {}), totalTokens: s.prompt + 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, total: 0 } };
		const reply = { role: "assistant", content: [{ type: "text", text: "Here are the changes." }], api: s.model.api, provider: s.model.provider, model: s.model.id, timestamp: START, stopReason: "stop", usage };
		s.whileOut?.(announce);
		emit("message_end", { message: reply });
		branch.push({ type: "message", id: "u", parentId: null, timestamp: new Date(START - 100).toISOString(), message: user });
		branch.push({ type: "message", id: "a", parentId: "u", timestamp: new Date(START).toISOString(), message: reply });
	}
	await s.afterAnswer?.({ announce, until });
	emit("agent_settled", { aborted: false });
	warmer?.onAgentSettled();
	const decide = () => emit("cache_warming_decision", { type: "cache_warming_decision", warmCost: 0.18, missCost: 2.07, continuationProbability: 0.15, action: "warm" }) as { action?: string } | undefined;
	const command = async () => {
		notes.length = 0;
		await commands.get("cache-keeper")?.("", ctx);
		return notes.join("\n");
	};
	const traces = () => readFileSync(join(dir, "cache-keeper.jsonl"), "utf8").split("\n").filter(Boolean).map((line: string) => JSON.parse(line));
	// Keep-warm switched off in this window's settings menu: down to it, then through its values to off.
	const switchOffInMenu = async () => {
		await commands.get("cache-keeper-settings")?.("", ctx);
		assert.ok(menu, "Pi's settings menu");
		// The menu opens on this session: the first row switches it to the defaults for all sessions.
		menu.handleInput(" ");
		// Past compacting when full, its cap, the fallback compaction model (0.10.0) and compacting before expiry.
		for (let i = 0; i < 5; i++) menu.handleInput("\x1b[B");
		for (let i = 0; i < 24 && JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).cacheKeeper.keepWarmMinutes !== 0; i++) menu.handleInput(" ");
		assert.equal(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).cacheKeeper.keepWarmMinutes, 0);
	};
	// The next real message at `at`: what the provider reads for it (sent through Pi's adapter, outside the extension).
	const continueAt = async (at: number) => {
		await until(at);
		return streamSimple(s.model, { messages: sent }, { apiKey: "sk-fixture", maxTokens: 8192, cacheRetention: "short", maxRetries: 0, sessionId, fetch: transport("answer") }).result();
	};
	return { ctx, emit, wires, decisions, announceFor, switchOffInMenu, statuses, compactions, branch, until, decide, command, announce, traces, streamSimple, continueAt, compaction: () => compaction, done: () => (warmer?.cancel(), emit("session_shutdown"), mock.timers.reset()) };
}

const claudeGateway = (promptCache = { short: 3600, long: 3600 }) => ({ ...MODELS.anthropic["claude-sonnet-4-6"], provider: "gateway-fixture", baseUrl: "https://fixture.invalid", promptCache });
// The values models.json holds for a proxy configured with an API key: the key's.
const keyValues = { short: 300, long: 3600 };
const deepseek = (provider: string, promptCache: { short: number; long: number }, cost?: Record<string, number>) => ({ ...MODELS.openrouter["deepseek/deepseek-v4-pro"], provider, baseUrl: "https://gateway.invalid/v1", promptCache, ...(cost ? { cost } : {}) });
// The prices (dollars per million tokens) Pi 1.5.2's catalog gave this model, which the sequences with Pi's own warmer
// were written for: Pi's warmer weighs a refresh by them, so they are stated here and no later catalog change moves them.
const DEEPSEEK_PRICES = { input: 0.95526, output: 1.91052, cacheRead: 0.079605, cacheWrite: 0 };
const CLAUDE_ID = "claude-sonnet-4-6";
const DEEPSEEK_ID = "deepseek/deepseek-v4-pro";


const N = 4000;
const START_ID = "a.cccccccccccccccccccc";
const FALLBACK_ID = "a.dddddddddddddddddddd";
const OPENROUTER = "openrouter/anthropic/claude-fable-5.2";
const OPUS = "claude-subscription/claude-opus-5-5";
// The gateway's figures as the extension saved them with the routes (`gateway` in cache-keeper-models.json).
const gateway = {
	provimux: {
		state: "held",
		entries: {
			[OPENROUTER]: { facts: { short: 300, long: 3600, cost: { input: 10, output: 50, cacheRead: 0.5, cacheWrite: 12.5 } }, basis: {} },
			[OPUS]: { facts: { short: 300, long: 3600, cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 } }, basis: {} },
		},
	},
};
const login = { provider: "anthropic", subscription: true };
const key = { provider: "openrouter", subscription: false };
/** What pi-provimux tells of an answer: its entry and account, then the answer (while its request is out). */
const named = (entry: string, account: string, upstream: Record<string, unknown>) => (announce: (upstreams: readonly unknown[]) => void) => {
	entryEvent?.({ provider: "provimux", model: currentId, entry, account });
	announce([upstream]);
};
let entryEvent: ((payload: unknown) => void) | undefined;
let currentId = "";

async function run(id: string, route: Record<string, unknown>, said: { entry: string; account: string; upstream: Record<string, unknown> }, cost: Record<string, number>, minutes = 30) {
	currentId = id;
	const model = { ...claudeGateway(), provider: "provimux", id, cost, promptCache: undefined };
	const store = { version: 1, checkedAt: START, providers: { "claude-subscription": {}, anthropic: {} }, upstreams: { provimux: { [id]: route } }, gateway };
	return session({
		model,
		store,
		prompt: N,
		settings: { keepWarmMinutes: minutes, modelData: true, compactBeforeExpiry: false },
		answered: { read: N, write: 0, oneHour: 0 },
		whileOut: (announce) => named(said.entry, said.account, said.upstream)(announce),
		serve: () => ({ read: N, write: 0, oneHour: 0 }),
	});
}

test("after a fallback to another account: shown with its lifetime and price, and never kept warm (as released: no refresh)", async () => {
	const route = { upstreams: [{ ...login, accounts: [START_ID] }], fallbacks: [{ ...key, entry: OPENROUTER, accounts: [FALLBACK_ID] }] };
	const s = await run("claude-fable-5-2", route, { entry: OPENROUTER, account: FALLBACK_ID, upstream: key }, { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10 });
	try {
		assert.match(s.statuses.at(-1)!, /^cache warm · 5m left · ⚠ answered by openrouter \(API key\) · not kept warm · short 5m \(in use\) · long 1h · sent short · api \$10\/\$50 per M/);
		await s.until(600);
		assert.deepEqual(s.wires, [], "no refresh after the fallback");
		const note = (await s.command()).split("\n").find((line) => line.startsWith("keep warm while you are away"))!;
		assert.match(note, /this session is left to Pi's own warming: the last answer came from openrouter \(API key\), not an account your server tries first, so this extension does not keep that cache warm: you did not choose that account, and it may be paid by the token/);
	} finally {
		s.done();
	}
});

test("an answer from the route's first account (an alias, `opus`) is kept warm, each refresh booked at its entry's prices", async () => {
	const route = { upstreams: [{ ...login, model: "opus", entry: OPUS, accounts: [START_ID] }] };
	// pi-provimux registers no price for a name models.dev does not know: Pi counts a refresh at $0.
	const s = await run("opus", route, { entry: OPUS, account: START_ID, upstream: { ...login, model: "opus" } }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, 180);
	try {
		await s.until(1200);
		assert.ok(s.wires.length >= 3, `${s.wires.length} refreshes`);
		const warmed = s.traces().filter((record: Any) => record.event === "warm" && record.action === "warm" && record.usage);
		assert.equal(warmed.length, s.wires.length);
		// One refresh at the entry's rates: 4 input, 4,000 read from the cache, 1 out.
		const each = (4 * 4 + N * 0.4 + 1 * 20) / 1_000_000;
		for (const [i, record] of warmed.entries()) {
			assert.ok(Math.abs(record.usage.cost - each) < 1e-12, `refresh ${i + 1} booked ${record.usage.cost}, not ${each}`);
			assert.ok(Math.abs(record.budget.spent - each * (i + 1)) < 1e-9, `spent ${record.budget.spent} after ${i + 1}`);
		}
		// The limit is one cache miss at the same rates: writing the 4,000 tokens again (5 $/M) less the cached read.
		assert.ok(Math.abs(warmed[0].budget.limit - (N * 5 - N * 0.4) / 1_000_000) < 1e-9, `limit ${warmed[0].budget.limit}`);
		assert.doesNotMatch(s.statuses.at(-1)!, /not kept warm/);
	} finally {
		s.done();
	}
});
