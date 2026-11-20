// The cache's clock through Pi's own adapters: the extension beside a gateway whose route changes, every request built by
// Pi's real adapter (Anthropic Messages, OpenAI Chat Completions) and answered from an in-memory transport that keeps the
// provider's cache as the provider would (what is read, what is written, how long it lasts). Pi's own warmer, where a
// case needs it, is Pi's real CacheWarmer. Nothing leaves the process: the global fetch throws.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "pck-route-clock-"));
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
const { MODELS } = existsSync(catalogFile) ? await import(catalogFile.href) : { MODELS: undefined };
const { CacheWarmer } = existsSync(warmerFile) ? await import(warmerFile.href) : { CacheWarmer: undefined };
// Pi's settings menu draws with Pi's theme.
const themeFile = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js", import.meta.url);
if (existsSync(themeFile)) (await import(themeFile.href)).initTheme("dark", false);
const skip = MODELS ? false : "the installed pi-ai has no model catalog";
const noWarmer = skip || (CacheWarmer ? false : "the installed Pi has no CacheWarmer");
const { normalizeContext } = (await import("@earendil-works/pi-ai/utils/transcript")) as { normalizeContext: (context: unknown) => { messages: unknown[] } };
const adapter = async (api: string) => (await import(`@earendil-works/pi-ai/api/${api}`)) as { streamSimple: (model: unknown, context: unknown, options: unknown) => { result: () => Promise<Any> } };

const flush = () => new Promise((resolve) => setImmediate(resolve));
const START = 10_000;
const sec = () => (Date.now() - START) / 1000;
const user = { role: "user", content: [{ type: "text", text: "Explain the changes in detail." }], timestamp: START - 100 };
const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
const transcript = normalizeContext({ systemPrompt: "You are pi.", messages: [user], tools }).messages;

// A provider's answer, as its stream reports it: what was read from the cache, what was written and into which cache
// (Anthropic reports the 1-hour part; Chat Completions only what was read).
function answer(api: string, prompt: number, read: number, write: number, oneHour: number, output: number): Response {
	const events: unknown[] =
		api === "anthropic-messages"
			? [
					{ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "m", content: [], usage: { input_tokens: prompt - read - write, output_tokens: 1, cache_read_input_tokens: read, cache_creation_input_tokens: write, cache_creation: { ephemeral_5m_input_tokens: write - oneHour, ephemeral_1h_input_tokens: oneHour } } } },
					{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
					{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checkpoint." } },
					{ type: "content_block_stop", index: 0 },
					{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: output } },
					{ type: "message_stop" },
				]
			: [
					{ id: "c", model: "m", object: "chat.completion.chunk", created: 0, choices: [{ index: 0, delta: { role: "assistant", content: "Checkpoint." }, finish_reason: "stop" }] },
					{ id: "c", model: "m", object: "chat.completion.chunk", created: 0, choices: [], usage: { prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output, prompt_tokens_details: { cached_tokens: read } } },
				];
	const text = events.map((e) => `${api === "anthropic-messages" ? `event: ${(e as { type: string }).type}\n` : ""}data: ${JSON.stringify(e)}\n\n`).join("") + (api === "anthropic-messages" ? "" : "data: [DONE]\n\n");
	return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

type Kind = "refresh" | "summary" | "pi";
interface Wire {
	at: number;
	kind: Kind;
	read: number;
	write: number;
	cap?: number;
}
interface Setup {
	model: Any;
	/** The proxy's routes and providers.dev's lifetimes for them (the extension's saved data). */
	store: Record<string, unknown>;
	settings: Record<string, unknown>;
	/** The prompt's size; the period's answer, as the provider reports it. */
	prompt: number;
	answered: { read: number; write: number; oneHour: number };
	/** The provider: given what is sent and when, what is read and written, and into which cache. */
	serve: (w: { kind: Kind; at: number }) => { read: number; write: number; oneHour: number };
	/** Called just before the extension's payload hook of a request it sends (a credential lookup, say). */
	beforeHook?: (kind: Kind) => void;
	/** Pi's own warmer runs beside the extension, started with the period's request, asking the extension each time. */
	piWarmer?: boolean;
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
		const used = s.serve({ kind, at: sec() });
		wires.push({ at: sec(), kind, read: used.read, write: used.write, cap: body.max_tokens ?? body.max_completion_tokens });
		return answer(s.model.api, s.prompt + 4, used.read, used.write, used.oneHour, kind === "summary" ? 20 : 1);
	};
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
			? new CacheWarmer({ streamSimple: (m: Any, context: unknown, options: Any) => streamSimple(m, context, { ...options, apiKey: "sk-fixture", maxRetries: 0, fetch: transport("pi") }) }, ctx.sessionManager, () => "idle", async (event: { action: string }) => {
					const result = emit("cache_warming_decision", event) as { action?: string } | undefined;
					decisions.push({ at: Math.round(sec()), answer: result?.action });
					return result?.action ?? event.action;
				})
			: undefined;
	// The period's run: its request, as Pi sends it, and its answer at 0 s.
	emit("agent_start");
	emit("context_with_system", { messages: transcript });
	let original: unknown;
	await streamSimple(s.model, { messages: transcript }, {
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
	warmer?.start({ model: s.model, context: { messages: transcript }, options: { cacheRetention: "short" } }, () => true);
	mock.timers.setTime(START);
	const { read, write, oneHour } = s.answered;
	const usage = { input: s.prompt - read - write, output: 5, cacheRead: read, cacheWrite: write, ...(s.model.api === "anthropic-messages" ? { cacheWrite1h: oneHour } : {}), totalTokens: s.prompt + 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, total: 0 } };
	const reply = { role: "assistant", content: [{ type: "text", text: "Here are the changes." }], api: s.model.api, provider: s.model.provider, model: s.model.id, timestamp: START, stopReason: "stop", usage };
	emit("message_end", { message: reply });
	branch.push({ type: "message", id: "u", parentId: null, timestamp: new Date(START - 100).toISOString(), message: user });
	branch.push({ type: "message", id: "a", parentId: "u", timestamp: new Date(START).toISOString(), message: reply });
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
		for (let i = 0; i < 3; i++) menu.handleInput("\x1b[B");
		for (let i = 0; i < 24 && JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).cacheKeeper.keepWarmMinutes !== 0; i++) menu.handleInput(" ");
		assert.equal(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).cacheKeeper.keepWarmMinutes, 0);
	};
	return { ctx, emit, wires, decisions, announceFor, switchOffInMenu, statuses, compactions, branch, until, decide, command, announce, traces, streamSimple, compaction: () => compaction, done: () => (warmer?.cancel(), emit("session_shutdown"), mock.timers.reset()) };
}

const claudeGateway = (promptCache = { short: 3600, long: 3600 }) => ({ ...MODELS.anthropic["claude-sonnet-4-6"], provider: "gateway-fixture", baseUrl: "https://fixture.invalid", promptCache });
// The values models.json holds for a proxy configured with an API key: the key's.
const keyValues = { short: 300, long: 3600 };
const deepseek = (provider: string, promptCache: { short: number; long: number }) => ({ ...MODELS.openrouter["deepseek/deepseek-v4-pro"], provider, baseUrl: "https://gateway.invalid/v1", promptCache });
const CLAUDE_ID = "claude-sonnet-4-6";
const DEEPSEEK_ID = "deepseek/deepseek-v4-pro";

// ----------------------------------------------------------------------------- the first review's finding 1, and 2's first

for (const on of [11, 1]) {
	test(`an end for good, then a summary: the Anthropic gateway's refresh ${on} reads 570,000 and writes 30,000 into the five-minute cache`, { skip }, async (t) => {
		const N = 600_000;
		let expires = 3600;
		let life = 3600;
		let refreshes = 0;
		const s = await session({
			model: claudeGateway(),
			store: { providers: {}, upstreams: {} },
			settings: { keepWarmMinutes: 720, compactBeforeExpiry: true },
			prompt: N,
			answered: { read: 0, write: N, oneHour: N },
			serve: ({ kind, at }) => {
				if (kind === "refresh") refreshes++;
				// The gateway fell over to a route whose cache lasts five minutes: 95% of the prompt is still read there.
				const switched = kind === "refresh" && refreshes === on;
				if (switched) life = 300;
				const read = switched ? 570_000 : at < expires ? N : 0;
				expires = at + life;
				return { read, write: N - read, oneHour: life === 3600 ? N - read : 0 };
			},
		});
		t.after(() => s.done());
		const step = 3420;
		const refreshedAt = Array.from({ length: on }, (_, i) => (i + 1) * step);
		const last = refreshedAt.at(-1)!;
		await s.until(last + 30);
		assert.deepEqual(s.wires.map((w) => [w.kind, w.at, w.cap]), refreshedAt.map((at) => ["refresh", at, 1]), "every refresh capped at one token");
		const stops = s.traces().filter((r: Any) => r.stop);
		if (on === 11) {
			assert.deepEqual(stops.map((r: Any) => r.stop), ["budget"], "warming ended on its budget");
			assert.deepEqual(s.decide(), { action: "stop" }, "Pi's warming stays stopped");
		} else {
			assert.deepEqual(stops.map((r: Any) => [r.stop, r.reason]), [["unable", "the extension's refresh reports a 5 min cache write; the request's cache lasts 60 min by the route's data"]], "handed over");
			assert.equal(s.decide(), undefined, "Pi's warming decides");
		}
		// The countdown runs to five minutes after that refresh left.
		const expiry = last + 300;
		assert.ok(s.statuses.at(-1)?.startsWith(`cache warm · ${formatRemaining((expiry - sec()) * 1000)} left`), s.statuses.at(-1));
		assert.match(await s.command(), new RegExp(`cache: ${formatRemaining((expiry - sec()) * 1000)} left \\(lifetime 5 min, the shortest lifetime read since\\)`));
		await s.until(41_300);
		const summaries = s.wires.filter((w) => w.kind === "summary");
		assert.deepEqual(summaries.map((w) => [w.at, w.read, w.write]), [[expiry - 20, N, 0]], "the summary leaves 20 s before that expiry and reads the whole prompt");
		assert.ok(s.wires.every((w) => w.at < expiry), "nothing leaves at or after it (41,200 s on the second review)");
		assert.deepEqual(s.wires.filter((w) => w.kind === "refresh").length, on, `no refresh after it (6,840 s)`);
	});
}

// A Chat Completions gateway whose period runs on the private account's hour; its public fallback's cache lasts 150 s.
const chatStore = (fallbackShort: number) => ({
	upstreams: { "switchable-gateway": { [DEEPSEEK_ID]: { upstreams: [{ provider: "private-account", model: DEEPSEEK_ID, subscription: false }] } } },
	providers: { "private-account": { [DEEPSEEK_ID]: { short: 3600, long: 3600 } }, openrouter: { [DEEPSEEK_ID]: { short: fallbackShort } } },
});
const FALLBACK = [{ provider: "openrouter", model: DEEPSEEK_ID, subscription: false }];

test("a refresh that misses while the gateway announces its 150-second route: no summary at 3,580 s, as on 0.5.3", { skip }, async (t) => {
	const N = 180_000;
	let expires = 3600;
	let life = 3600;
	let s: Awaited<ReturnType<typeof session>>;
	s = await session({
		model: deepseek("switchable-gateway", { short: 3600, long: 3600 }),
		store: chatStore(150),
		settings: { keepWarmMinutes: 120, compactBeforeExpiry: true },
		prompt: N,
		answered: { read: N, write: 0, oneHour: 0 },
		serve: ({ kind, at }) => {
			if (kind === "refresh") {
				// The private account failed: the public route answers, without the cache, and says so.
				life = 150;
				expires = at;
				s.announce(FALLBACK);
			}
			const read = at < expires ? N : 0;
			expires = at + life;
			return { read, write: 0, oneHour: 0 };
		},
	});
	t.after(() => s.done());
	await s.until(4000);
	assert.deepEqual(s.wires.map((w) => [w.kind, w.at, w.read]), [["refresh", 3420, 0]], "the refresh missed; nothing after it");
	assert.deepEqual(s.compactions, [], "no summary: the route changed, so the cache's expiry is unknown");
	assert.match(await s.command(), /cache: expired \(lifetime 3 min, the shortest lifetime read since\), counted as expired: the route changed/);
	assert.match(s.statuses.at(-1) ?? "", /^cache cold/);
});

for (const route of ["the 150-second route is announced just before the summary's payload hook", "the route stays"] as const) {
	test(`a covered period, compacting before expiry at 3,580 s: ${route}`, { skip }, async (t) => {
		const N = 180_000;
		let expires = 3600;
		let life = 3600;
		let s: Awaited<ReturnType<typeof session>>;
		const changes = route.startsWith("the 150");
		s = await session({
			model: deepseek("switchable-gateway", { short: 3600, long: 3600 }),
			store: chatStore(150),
			settings: { keepWarmMinutes: 30, compactBeforeExpiry: true },
			prompt: N,
			answered: { read: N, write: 0, oneHour: 0 },
			serve: ({ at }) => {
				const read = at < expires ? N : 0;
				expires = at + life;
				return { read, write: 0, oneHour: 0 };
			},
			// The credential lookup: the gateway fell over meanwhile, and says so before the payload hook.
			beforeHook: (kind) => {
				if (kind !== "summary" || !changes) return;
				life = 150;
				expires = sec();
				s.announce(FALLBACK);
			},
		});
		t.after(() => s.done());
		await s.until(4000);
		assert.deepEqual(s.traces().filter((r: Any) => r.stop).map((r: Any) => r.stop), ["limit"], "the hour covers the 30 minutes");
		assert.deepEqual(s.compactions, [3580]);
		const record = s.traces().find((r: Any) => r.event === "compact");
		if (changes) {
			assert.deepEqual(s.wires, [], "nothing reaches the transport");
			assert.deepEqual([record.outcome, record.reason], ["cancelled", "the prompt cache's expiry became unknown before the summary request left: the route changed"]);
			assert.deepEqual(await s.compaction(), { cancel: true });
		} else {
			assert.deepEqual(s.wires.map((w) => [w.kind, w.at, w.read]), [["summary", 3580, N]], "the summary reads the whole prompt");
			assert.equal(record.outcome, "cached");
		}
	});
}

// ------------------------------------------------------------------------------- the third review's finding 2: routes

// A gateway with two accounts, each with its own cache: account A (the period's, an hour) and account B (five minutes for
// the short tier). From 3,400 s the gateway serves B; the refresh at 3,420 s hits B's own copy, and B is announced. At
// 3,450 s a helper request with another prefix is served by A, and A is announced again.
const A = { provider: "account-a", model: CLAUDE_ID, subscription: true };
const B = { provider: "account-b", model: CLAUDE_ID, subscription: false };
const accounts = (bShort: number) => ({
	upstreams: { "gateway-fixture": { [CLAUDE_ID]: { upstreams: [A] } } },
	providers: { "account-a": { [CLAUDE_ID]: { short: 3600, long: 3600 } }, "account-b": { [CLAUDE_ID]: { short: bShort, long: 3600 } } },
});
for (const variant of ["reads everything", "reads 570,000 and writes 30,000 into the five-minute cache"] as const) {
	test(`a route that returns: the refresh at 3,420 s on route B ${variant}, route A is reported again at 3,450 s: no summary, no refresh, cold`, { skip }, async (t) => {
		const N = 600_000;
		const expires = { a: 3600, b: 3500 };
		let active: "a" | "b" = "a";
		let s: Awaited<ReturnType<typeof session>>;
		s = await session({
			model: claudeGateway(),
			store: accounts(300),
			settings: { keepWarmMinutes: 120, compactBeforeExpiry: true },
			prompt: N,
			answered: { read: 0, write: N, oneHour: N },
			serve: ({ at }) => {
				const life = active === "a" ? 3600 : 300;
				let read = at < expires[active] ? N : 0;
				if (active === "b" && variant.startsWith("reads 570") && read) read -= 30_000;
				expires[active] = at + life;
				if (active === "b") s.announce([B]);
				return { read, write: N - read, oneHour: life === 3600 ? N - read : 0 };
			},
		});
		t.after(() => s.done());
		await s.until(3400);
		active = "b";
		await s.until(3450);
		active = "a";
		s.announce([A]);
		await s.until(7100);
		assert.deepEqual(s.wires.map((w) => [w.kind, w.at]), [["refresh", 3420]], "no summary at 3,700 s or 7,000 s, no refresh at 6,840 s");
		assert.deepEqual(s.compactions, []);
		assert.match(s.statuses.at(-1) ?? "", /^cache cold · next message full price · keep-warm: Pi's \(/, "cold, and the period is Pi's");
		assert.match(await s.command(), /\ncache: expired \(lifetime 5 min, the shortest lifetime read since\), counted as expired: the route changed\n/);
	});
}

// Another route with the same hour, then the first one again: the evidence's judge still agrees, the route changed.
test("another route with the same hour announced at 100 s, the first again at 130 s: no summary at 3,580 s, the route changed", { skip }, async (t) => {
	const N = 600_000;
	const s = await session({
		model: claudeGateway(),
		store: accounts(3600),
		settings: { keepWarmMinutes: 120, compactBeforeExpiry: true },
		prompt: N,
		answered: { read: 0, write: N, oneHour: N },
		serve: ({ at }) => ({ read: at < 3600 ? N : 0, write: 0, oneHour: 0 }),
	});
	t.after(() => s.done());
	await s.until(100);
	s.announce([B]);
	await s.until(130);
	s.announce([A]);
	await s.until(3700);
	assert.deepEqual(s.wires, [], "no refresh, no summary");
	assert.deepEqual(s.compactions, []);
	const stops = s.traces().filter((r: Any) => r.stop);
	assert.deepEqual(stops.map((r: Any) => r.stop), ["unable"]);
	// The two reports, whole, as the proxy sent them.
	assert.match(stops[0].reason, /^the period's answer was served by \{.*"provider":"account-a","subscription":true\}\]\}, and a request of the model was served by \{.*"provider":"account-b","subscription":false\}\]\} since: a cache on one route says nothing about the other's$/);
	assert.match(s.statuses.at(-1) ?? "", /^cache cold · next message full price · keep-warm: Pi's \(the route changed\)/);
	assert.match(await s.command(), /\ncache: expired \(lifetime 60 min, declared by the model\), counted as expired: the route changed\n/);
});

// ------------------------------------------------------------------------------- the third review's finding 3: Pi's question

// A Chat Completions gateway whose 300-second route gives way at 100 s to another, announced, with a 150-second or a
// 600-second cache; a 1,000,000-token prompt. Pi's own warmer keeps the 270-second cadence of the first route. The
// period is Pi's from the announcement; Pi is stopped only once nothing seen says the cache is alive.
for (const [label, ttl] of [["150-second", 150], ["600-second", 600]] as const) {
	test(`Pi's real warmer after a hand-over: the ${label} route announced at 100 s`, { skip: noWarmer }, async (t) => {
		const N = 1_000_000;
		let expires = 300;
		const s = await session({
			model: deepseek("test-gateway", { short: 300, long: 300 }),
			store: {
				upstreams: { "test-gateway": { [DEEPSEEK_ID]: { upstreams: [{ provider: "ordinary-account", model: DEEPSEEK_ID, subscription: false }] } } },
				providers: { "ordinary-account": { [DEEPSEEK_ID]: { short: 300 } }, openrouter: { [DEEPSEEK_ID]: { short: ttl } } },
			},
			settings: { keepWarmMinutes: 120, compactBeforeExpiry: false },
			prompt: N,
			answered: { read: N, write: 0, oneHour: 0 },
			piWarmer: true,
			serve: ({ at }) => {
				const read = at < expires ? N : 0;
				expires = at + ttl;
				return { read, write: 0, oneHour: 0 };
			},
		});
		t.after(() => s.done());
		await s.until(100);
		expires = 100 + ttl;
		s.announce([{ provider: "openrouter", model: DEEPSEEK_ID, subscription: false }]);
		await s.until(1850);
		assert.deepEqual(s.wires.filter((w) => w.kind !== "pi"), [], "the extension sends nothing");
		const pi = s.wires.filter((w) => w.kind === "pi");
		if (ttl === 150) {
			// Gone by 150 s: Pi's six full-price refreshes ($5.73 on the third review) are stopped at the first.
			assert.deepEqual(s.decisions, [{ at: 270, answer: "stop" }]);
			assert.deepEqual(pi, []);
		} else {
			// Gone by 300 s, then by 300 s after each of Pi's own refreshes: none is stopped, and each reads the cache.
			assert.deepEqual(s.decisions, [270, 540, 810, 1080, 1350, 1620].map((at) => ({ at, answer: undefined })));
			assert.deepEqual(pi.map((w) => [Math.round(w.at), w.read]), [270, 540, 810, 1080, 1350, 1620].map((at) => [at, N]));
		}
	});
}

// The second review's covered period: the hour covers a 30-minute goal, so warming ended on its time limit at the start.
// Pi's refresh from the run is recorded at 273 s with a five-minute write, and the gateway names its API key's route. Pi
// asks at 543 s: its own refresh kept the cache alive until 573 s, so it is not stopped. Its refresh, recorded at 544 s,
// keeps it alive until 844 s; only after that is Pi stopped.
test("a covered period handed over: Pi's question at 543 s is not stopped, its own receipts count; stopped once nothing says the cache is alive", { skip }, async (t) => {
	const N = 600_000;
	const s = await session({
		model: claudeGateway(),
		store: {
			upstreams: { "gateway-fixture": { [CLAUDE_ID]: { upstreams: [{ provider: "claude-subscription", model: CLAUDE_ID, subscription: true }] } } },
			providers: { "claude-subscription": { [CLAUDE_ID]: { short: 3600, long: 3600 } }, anthropic: { [CLAUDE_ID]: { short: 300, long: 3600 } } },
		},
		settings: { keepWarmMinutes: 30, compactBeforeExpiry: false },
		prompt: N,
		answered: { read: 0, write: N, oneHour: N },
		serve: () => ({ read: N, write: 0, oneHour: 0 }),
	});
	t.after(() => s.done());
	const receipt = (fields: Record<string, number>) => s.ctx.sessionManager.appendUsage("cache_warm", s.ctx.model.provider, s.ctx.model.id, { input: 5, output: 1, cacheRead: N, cacheWrite: 0, cacheWrite1h: 0, totalTokens: N + 6, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, ...fields });
	await s.until(10);
	assert.deepEqual(s.traces().filter((r: Any) => r.stop).map((r: Any) => r.stop), ["limit"]);
	assert.deepEqual(s.decide(), { action: "stop" }, "Pi stays stopped while the period holds");
	await s.until(273);
	receipt({ cacheRead: 570_000, cacheWrite: 30_000 });
	s.announce([{ provider: "anthropic", model: CLAUDE_ID, subscription: false }]);
	await s.until(543);
	assert.equal(s.decide(), undefined, "Pi's request at 543 s goes out");
	await s.until(544);
	receipt({});
	await s.until(843);
	assert.equal(s.decide(), undefined, "alive until 844 s by Pi's own refresh");
	await s.until(845);
	assert.deepEqual(s.decide(), { action: "stop" }, "nothing seen says the cache is alive any more");
	assert.deepEqual(s.wires, [], "the extension sends nothing");
});

// ------------------------------------------------------------- the route's identity: per model, the whole report

// A Claude model behind a proxy configured with an API key; this session's requests are served by a subscription login,
// as the proxy reports during the run. The login's cache lasts an hour; the key's short tier five minutes.
const LOGIN = { provider: "claude-subscription", model: CLAUDE_ID, subscription: true };
const KEY = { provider: "anthropic", model: CLAUDE_ID, subscription: false };
const loginOverKey = () => ({
	upstreams: { "gateway-fixture": { [CLAUDE_ID]: { upstreams: [KEY] } } },
	providers: { anthropic: { [CLAUDE_ID]: { short: 300, long: 3600 } }, "claude-subscription": { [CLAUDE_ID]: { short: 3600, long: 3600 } } },
});
// A provider, each account with a cache of its own; `account` says which one serves now.
const accountCaches = (N: number) => {
	const caches: Record<string, number> = { login: 3600 };
	let account = "login";
	return {
		use: (name: string) => (account = name),
		serve: ({ at }: { at: number }) => {
			const read = at < (caches[account] ?? 0) ? N : 0;
			caches[account] = at + 3600;
			return { read, write: N - read, oneHour: N - read };
		},
	};
};

test("a report about another model never touches the period: a helper's request on another model at 600 s, and the refresh at 3,420 s reads the hour cache", { skip }, async (t) => {
	const N = 600_000;
	const provider = accountCaches(N);
	const s = await session({
		model: claudeGateway(keyValues),
		store: loginOverKey(),
		settings: { keepWarmMinutes: 120, compactBeforeExpiry: false },
		prompt: N,
		answered: { read: 0, write: N, oneHour: N },
		serve: provider.serve,
		afterAnswer: ({ announce }) => announce([LOGIN]),
	});
	t.after(() => s.done());
	await s.until(270);
	assert.deepEqual(s.decide(), { action: "stop" }, "the extension keeps it warm");
	await s.until(600);
	s.announceFor("different-model", [KEY]);
	await s.until(615);
	assert.match(await s.command(), /\ncache: 49m left \(lifetime 60 min, /, "the hour cache, 49 minutes left");
	await s.until(3500);
	assert.deepEqual(s.wires.map((w) => [w.kind, w.at, w.read]), [["refresh", 3420, N]], "the refresh reads the whole prompt (on the third review it was not sent; the next turn paid $3.60)");
});

test("a reported switch from a subscription to an API key of one upstream is a change of route: no refresh into the key's empty cache", { skip }, async (t) => {
	const N = 600_000;
	const provider = accountCaches(N);
	const login = { provider: "compat-upstream", model: CLAUDE_ID, subscription: true };
	const key = { provider: "compat-upstream", model: CLAUDE_ID, subscription: false };
	const s = await session({
		model: claudeGateway(),
		store: { upstreams: { "gateway-fixture": { [CLAUDE_ID]: { upstreams: [key] } } }, providers: { "compat-upstream": { [CLAUDE_ID]: { short: 3600, long: 3600 } } } },
		settings: { keepWarmMinutes: 120, compactBeforeExpiry: false },
		prompt: N,
		answered: { read: 0, write: N, oneHour: N },
		serve: provider.serve,
		afterAnswer: ({ announce }) => announce([login]),
	});
	t.after(() => s.done());
	await s.until(600);
	provider.use("key");
	s.announce([key]);
	await s.until(615);
	assert.equal(s.decide(), undefined, "the period is Pi's");
	// Nothing is known of the key's cache: cold, whatever Pi sent (it read "49m left by Pi's own warming").
	assert.match(s.statuses.at(-1) ?? "", /^cache cold · /);
	assert.match(await s.command(), /\ncache: expired \(lifetime 60 min, [^)]*\), counted as expired: the route changed\n/);
	await s.until(3700);
	assert.deepEqual(s.wires, [], "no refresh (on the third review one wrote 600,000 into the key's cache for $3.60)");
});

for (const [label, reports] of [
	["the API key is reported at 10 s, before Pi goes idle", [[LOGIN], [KEY]]],
	["the API key at 1 s, then the login again at 2 s, before Pi goes idle", [[LOGIN], [KEY], [LOGIN]]],
] as const) {
	test(`the answer's run reports two routes: ${label}: the period is Pi's, the route changed`, { skip }, async (t) => {
		const N = 600_000;
		const provider = accountCaches(N);
		const s = await session({
			model: claudeGateway(keyValues),
			store: loginOverKey(),
			settings: { keepWarmMinutes: 120, compactBeforeExpiry: false },
			prompt: N,
			answered: { read: 0, write: N, oneHour: N },
			serve: provider.serve,
			afterAnswer: async ({ announce, until }) => {
				announce(reports[0]);
				for (let i = 1; i < reports.length; i++) {
					await until(reports.length === 2 ? 10 : i);
					announce(reports[i]);
				}
			},
		});
		t.after(() => s.done());
		await s.until(270);
		assert.equal(s.decide(), undefined, "not taken: Pi's warming decides");
		assert.match(await s.command(), /left to Pi's own warming: the proxy reported different routes for this model during the run of the last answer/);
		await s.until(3700);
		assert.deepEqual(s.wires, [], "no refresh at 3,420 s");
	});
}

test("a model switch away and back keeps the route's report: 58 min on return, Pi's 26 min at 3,601 s", { skip: noWarmer }, async (t) => {
	const N = 600_000;
	const s = await session({
		model: claudeGateway(keyValues),
		store: loginOverKey(),
		settings: { keepWarmMinutes: 120, compactBeforeExpiry: false },
		prompt: N,
		answered: { read: 0, write: N, oneHour: N },
		serve: () => ({ read: N, write: 0, oneHour: 0 }),
		piWarmer: true,
		afterAnswer: ({ announce }) => announce([LOGIN]),
	});
	t.after(() => s.done());
	await s.until(60);
	const own = s.ctx.model;
	s.ctx.model = { ...own, provider: "google", id: "gemini-3.8-pro", api: "google-generative-ai" };
	s.emit("model_select");
	await s.until(61);
	s.ctx.model = own;
	s.emit("model_select");
	const shown = await s.command();
	assert.match(shown, /\ncache: 58m left \(lifetime 60 min, /, "the hour cache, as on 0.5.3");
	assert.doesNotMatch(shown, /the route changed/);
	// Pi's warming keeps it (its six refreshes, the last at 1,620 s); the answer's own hour has passed.
	await s.until(3601);
	assert.deepEqual(s.wires.filter((w) => w.kind === "pi").map((w) => Math.round(w.at)), [270, 540, 810, 1080, 1350, 1620]);
	assert.match(await s.command(), /\ncache: 26m left by Pi's own warming \(lifetime 60 min, /);
});

// The second look's old-account receipt: the period was let go (a model switch away and back); Pi's refresh at 270 s
// hit the login's hour cache; at 400 s the proxy reports the API key. Nothing is known of the key's cache: the footer and
// /cache-keeper say none is warm (they claimed 57 minutes, and the next message wrote 600,000).
test("after a reported change of route, neither the footer nor /cache-keeper claims a warm cache, whatever Pi refreshed before it", { skip }, async (t) => {
	const N = 600_000;
	const s = await session({
		model: claudeGateway(keyValues),
		store: loginOverKey(),
		settings: { keepWarmMinutes: 120, compactBeforeExpiry: false },
		prompt: N,
		answered: { read: 0, write: N, oneHour: N },
		serve: () => ({ read: N, write: 0, oneHour: 0 }),
		afterAnswer: ({ announce }) => announce([LOGIN]),
	});
	t.after(() => s.done());
	await s.until(60);
	const own = s.ctx.model;
	s.ctx.model = { ...own, provider: "google", id: "gemini-3.8-pro", api: "google-generative-ai" };
	s.emit("model_select");
	s.ctx.model = own;
	s.emit("model_select");
	await s.until(270);
	s.ctx.sessionManager.appendUsage("cache_warm", own.provider, own.id, { input: 2, output: 1, cacheRead: N, cacheWrite: 0, cacheWrite1h: 0, totalTokens: N + 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
	await s.until(400);
	s.announce([KEY]);
	await s.until(415);
	assert.doesNotMatch(s.statuses.at(-1) ?? "", /cache warm/, "the footer claims no warm cache");
	assert.match(await s.command(), /\ncache: expired \(lifetime 5 min, [^)]*\), counted as expired: the route changed\n/);
	assert.deepEqual(s.wires, []);
});

// Keep-warm off throughout: a report changes nothing until the countdown's next ordinary read, every 15 s, exactly as on
// 0.5.3. A 1,000,000-token Chat Completions prompt on the private account's hour; the public route's cache lasts 150 s.
// Pi goes idle at 1 s, so the countdown reads at 15 s, 30 s, … as 0.5.3's does in the reviewer's runs.
const offPeriod = async (t: { after: (fn: () => void) => void }) => {
	const N = 1_000_000;
	const expiry: Record<string, number> = { A: 3600, B: 0 };
	let current = "A";
	const s = await session({
		model: deepseek("switchable-gateway", { short: 3600, long: 3600 }),
		store: chatStore(150),
		settings: { keepWarmMinutes: 0, compactBeforeExpiry: true },
		prompt: N,
		answered: { read: N, write: 0, oneHour: 0 },
		serve: ({ at }) => {
			const read = at < expiry[current] ? N : 0;
			expiry[current] = at + (current === "A" ? 3600 : 150);
			return { read, write: N - read, oneHour: 0 };
		},
		afterAnswer: ({ until }) => until(1),
	});
	t.after(() => s.done());
	const to = (account: "A" | "B") => {
		current = account;
		s.announce(account === "A" ? [{ provider: "private-account", model: DEEPSEEK_ID, subscription: false }] : FALLBACK);
	};
	return { s, N, to };
};

test("keep-warm off: the 150-second route reported at 143 s sends nothing, as on 0.5.3 (no cold summary at 144 s)", { skip }, async (t) => {
	const { s, to } = await offPeriod(t);
	await s.until(143);
	to("B");
	await s.until(400);
	assert.deepEqual(s.wires, [], "no summary (a cold million-token one cost $0.96)");
	assert.deepEqual(s.compactions, []);
});

test("keep-warm off: route B reported at 600 s and A again at 602 s: the summary at 3,580 s reads the cache, as on 0.5.3", { skip }, async (t) => {
	const { s, N, to } = await offPeriod(t);
	await s.until(600);
	to("B");
	await s.until(602);
	to("A");
	await s.until(3600);
	assert.deepEqual(s.wires.map((w) => [w.kind, w.at, w.read]), [["summary", 3580, N]]);
});

// ------------------------------------------------------------------------------- keep-warm switched off mid-period

// The third review's sequence: a 1,000,000-token Chat Completions prompt on a 300-second route; at 50 s the gateway
// reports another account (its cache empty), so the period's expiry is unknown and it is Pi's; at 100 s keep-warm is
// switched off. From then on the cache is read as with keep-warm off: Pi's six refreshes keep it to 1,920 s, and the
// summary leaves at 1,900 s reading all of it, as on 0.5.3.
for (const how of ["in this window's settings menu", "saved from another window"] as const) {
	test(`keep-warm switched off ${how} after the route changed: the countdown runs again, the summary at 1,900 s reads the cache`, { skip: noWarmer }, async (t) => {
		const N = 1_000_000;
		const expiry: Record<string, number> = { A: 300, B: 0 };
		let current = "A";
		const original = { provider: "private-account", model: DEEPSEEK_ID, subscription: false };
		const other = { provider: "openrouter", model: DEEPSEEK_ID, subscription: false };
		const s = await session({
			model: deepseek("switchable-gateway", { short: 300, long: 300 }),
			store: { upstreams: { "switchable-gateway": { [DEEPSEEK_ID]: { upstreams: [original] } } }, providers: { "private-account": { [DEEPSEEK_ID]: { short: 300, long: 300 } }, openrouter: { [DEEPSEEK_ID]: { short: 300, long: 300 } } } },
			settings: { keepWarmMinutes: 120, compactBeforeExpiry: true },
			prompt: N,
			answered: { read: N, write: 0, oneHour: 0 },
			piWarmer: true,
			serve: ({ at }) => {
				const read = at < expiry[current] ? N : 0;
				expiry[current] = at + 300;
				return { read, write: 0, oneHour: 0 };
			},
		});
		t.after(() => s.done());
		await s.until(50);
		current = "B";
		s.announce([other]);
		await s.until(100);
		if (how === "in this window's settings menu") await s.switchOffInMenu();
		else writeFileSync(join(dir, "settings.json"), JSON.stringify({ cacheKeeper: { modelData: false, cacheRetention: "short", compactAtPercent: 0, minContextTokens: 140_000, keepWarmMinutes: 0, compactBeforeExpiry: true } }));
		await s.until(1800);
		assert.match(s.statuses.at(-1) ?? "", /^cache warm · 2m left/, "the footer counts Pi's last refresh, as /cache-keeper does");
		assert.match(await s.command(), /\ncache: 2m left \(/);
		await s.until(1930);
		assert.deepEqual(s.wires.map((w) => [w.kind, Math.round(w.at), w.read]), [
			...[270, 540, 810, 1080, 1350, 1620].map((at, i) => ["pi", at, i === 0 ? 0 : N]),
			["summary", 1900, N],
		]);
		assert.deepEqual(s.compactions, [1900]);
	});
}

// ------------------------------------------------------------------------- the summary's last check, on the live branch

// The third review's late receipt: an hour period covering a 30-minute goal; compacting before expiry starts at 3,580 s;
// during the summary's 3-second preparation Pi's refresh is recorded, reporting a write into the five-minute cache. The
// last check reads the branch as it is then: the cache counted five minutes from the answer is long gone, so nothing
// leaves (on the third review the summary wrote 600,000 for $2.25).
test("a receipt of Pi's recorded during the summary's preparation is read at its last check: nothing leaves", { skip }, async (t) => {
	const N = 600_000;
	let s: Awaited<ReturnType<typeof session>>;
	s = await session({
		model: claudeGateway(),
		store: {},
		settings: { keepWarmMinutes: 30, compactBeforeExpiry: true },
		prompt: N,
		answered: { read: 0, write: N, oneHour: N },
		serve: () => ({ read: 0, write: N, oneHour: 0 }),
		beforeHook: (kind) => {
			if (kind !== "summary") return;
			mock.timers.tick(2000);
			s.ctx.sessionManager.appendUsage("cache_warm", s.ctx.model.provider, s.ctx.model.id, { input: 5, output: 1, cacheRead: 570_000, cacheWrite: 30_000, cacheWrite1h: 0, totalTokens: N + 6, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
			mock.timers.tick(1000);
		},
	});
	t.after(() => s.done());
	await s.until(3600);
	assert.deepEqual(s.compactions, [3580]);
	assert.deepEqual(s.wires, [], "nothing reaches the transport");
	const record = s.traces().find((r: Any) => r.event === "compact");
	assert.deepEqual([record.outcome, record.reason], ["cancelled", "the prompt cache expired before the summary request left"]);
});
