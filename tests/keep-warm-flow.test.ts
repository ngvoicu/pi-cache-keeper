import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { calculateCost } from "@earendil-works/pi-ai";

// The trace path and settings are read from the agent directory, so it is set before the extension loads.
const dir = mkdtempSync(join(tmpdir(), "pcc-warm-"));
process.env.PI_CODING_AGENT_DIR = dir;
const settings = (cacheKeeper: Record<string, unknown>) => writeFileSync(join(dir, "settings.json"), JSON.stringify({ cacheKeeper }));
const readSettings = () => JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
settings({ keepWarmMinutes: 120, minContextTokens: 100_000 });
const { default: cacheKeeper } = await import("../index.ts");
const { clockText } = await import("../footer.ts");
const { formatRemaining } = await import("../trace.ts");

const HOUR = 3_600_000;
const flush = () => new Promise((resolve) => setImmediate(resolve));

// Prices per million tokens: Claude-like with a cache-write price, GPT-like without one, and a subscription login.
const WITH_WRITE = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const WITHOUT_WRITE = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 };
const NO_PRICES = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
// The harness's request carries no cache marker, on Anthropic Messages, whose default for it is five minutes: on a route
// whose data gives the request another lifetime, only the period's own answer writing all of it into the cache of that
// lifetime confirms it (lifetime-evidence.ts), and a 150-second or 30-minute cache can't be confirmed at all. Where a
// test is about a period kept warm on such a lifetime, its route is one whose answers report no write breakdown (OpenAI
// Chat Completions), which goes by the data; or, on the hour, its answer confirms it.
const NO_BREAKDOWN = { api: "openai-completions" } as const;
// The answer that confirms the hour: 120,000 of its 600,000-token prompt written, all of it to the 1-hour cache.
const CONFIRMING_HOUR = { cacheRead: 480_000, cacheWrite: 120_000, cacheWrite1h: 120_000 };
// 600,002 prompt tokens at WITH_WRITE: a refresh is expected at $0.1800156 and reports $0.180021 (2 input tokens, the
// cached read and one output token); a miss costs $2.0700069. Without a cache-write price a miss costs $1.6200054.
const EXPECTED = 0.1800156;
const REPORTED = 0.180021;
const MISS = 2.0700069;
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

type Fields = Partial<Record<"input" | "cacheRead" | "cacheWrite" | "output", number>>;
interface Options {
	lifetime?: number;
	cost?: typeof WITH_WRITE;
	/** What the last answer read from the cache; the context size follows it. */
	cached?: number;
	thinking?: unknown;
	/** The model is Claude through pi-claude-bridge: no payload is ever seen. */
	bridge?: boolean;
	/** What the provider answers to the n-th refresh (from 1): another usage, or an error; by default a full read. */
	respond?: (n: number) => { stopReason?: string; errorMessage?: string; usage?: Fields };
	/** Which refreshes stay in flight until released or aborted. */
	hold?: (n: number) => boolean;
	/** Footer statuses and notices are recorded (Pi's UI is there). */
	ui?: boolean;
	/** Overrides of the model (api, provider, id, compat, promptCache, …). */
	model?: Record<string, unknown>;
	/** The payload of the first request, as the provider adapter built it. */
	sent?: Record<string, unknown>;
	/** What the provider adapter builds for a refresh (maxTokens 1), handed to the extension's payload hook. */
	params?: unknown;
	/** Replaces the fake transport: given the extension's stream options, returns the stream (a real adapter). */
	stream?: (options: Record<string, unknown> & { onPayload: (p: unknown) => unknown; signal: AbortSignal }) => { result: () => Promise<unknown> };
	/** The first answer's usage, over a full read of the cache (cacheWrite1h: the 1-hour writes Anthropic reports). */
	answer?: Fields & { cacheWrite1h?: number };
	/** Entries on the branch before the first request. */
	before?: unknown[];
	/** Pi's thinking level when the first request is sent (later changed through `thinkingLevel.value`). */
	level?: string;
}

function harness(options: Options = {}) {
	const respond = options.respond;
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
	// Events between extensions (a proxy saying what served a request): `signal` delivers one.
	const bus = new Map<string, (payload: unknown) => void>();
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
		registerEntryRenderer: () => {},
		events: { on: (name: string, handler: (payload: unknown) => void) => (bus.set(name, handler), () => {}), emit: () => {} },
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => unknown }) => commands.set(name, command.handler),
		appendEntry: () => {},
		getThinkingLevel: () => thinkingLevel.value,
	};
	const thinkingLevel = { value: options.level ?? "high" };
	cacheKeeper(pi as never);

	const lifetime = options.lifetime ?? 3600;
	const cached = options.cached ?? 600_000;
	const model = {
		provider: "cliproxyapi",
		id: "sub/claude",
		api: options.bridge ? "claude-bridge" : "anthropic-messages",
		promptCache: { short: lifetime, long: lifetime },
		contextWindow: 1_000_000,
		maxTokens: 64_000,
		cost: options.cost ?? NO_PRICES,
		...options.model,
	} as Record<string, unknown> & { provider: string; id: string; api: string };
	const user = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 };
	const by = { provider: model.provider, model: model.id };
	const reply = { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 1_000, stopReason: "stop", ...by, usage: { input: 2, output: 5, cacheRead: cached, cacheWrite: 0, ...options.answer } };
	const branch = [
		...((options.before ?? []) as { type: string; id: string; parentId: null; timestamp: string; message: unknown }[]),
		{ type: "message", id: "u", parentId: null, timestamp: new Date(0).toISOString(), message: user },
		{ type: "message", id: "a", parentId: "u", timestamp: new Date(1_000).toISOString(), message: reply },
	];
	const sent: Record<string, unknown> & { messages: unknown[] } = (options.sent as never) ?? { model: "claude", max_tokens: 64_000, system: "s", messages: [{ role: "user", content: "hi" }], thinking: options.thinking ?? { type: "adaptive" } };
	const warms: { payload: unknown; options: Record<string, unknown>; at: number; attempt?: number }[] = [];
	// What the provider reports for a refresh: the cached prompt read back, priced at the model's prices.
	const refreshUsage = (fields: Fields = {}) => {
		const usage = { input: 2, output: 1, cacheRead: cached, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, ...fields };
		usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		calculateCost(model as never, usage as never);
		return usage;
	};
	let pending: (() => void) | undefined;
	const state = { compacts: 0, compactedAt: 0, idle: true, pending: false, abortReports: true, ignoresAbort: false, attempts: 0, beforePayload: undefined as (() => void) | undefined };
	const statuses: { at: number; text: string | undefined }[] = [];
	const notes: string[] = [];
	const ctx = {
		hasUI: options.ui === true,
		mode: "print",
		ui: {
			setStatus: (key: string, text: string | undefined) => key === "cache-keeper" && statuses.push({ at: Date.now(), text }),
			notify: (text: string) => notes.push(text),
			theme: { fg: (_color: string, text: string) => text },
		},
		cwd: dir,
		model,
		isIdle: () => state.idle,
		hasPendingMessages: () => state.pending,
		isProjectTrusted: () => false,
		getContextUsage: () => ({ tokens: cached }),
		sessionManager: {
			getBranch: () => branch,
			getSessionId: () => "s1",
			getSessionFile: () => undefined,
			// Pi's own warming records its refreshes as usage entries.
			appendUsage: (kind: string, provider: string, modelId: string, usage: unknown) => {
				const entry = { type: "usage", id: `w${branch.length}`, parentId: null, kind, provider, model: modelId, usage, timestamp: new Date().toISOString() };
				branch.push(entry as never);
				return entry;
			},
		},
		modelRegistry: {
			isUsingOAuth: () => false,
			getProvider: () => undefined,
			streamSimple: (_model: unknown, _context: unknown, options2: Record<string, unknown> & { onPayload: (p: unknown) => unknown; signal: AbortSignal }) => {
				state.attempts++;
				state.beforePayload?.();
				if (options.stream) {
					return options.stream({
						...options2,
						onPayload: async (params: unknown) => {
							const out = await options2.onPayload(params);
							warms.push({ payload: out, options: options2, at: Date.now(), attempt: state.attempts });
							return out;
						},
					});
				}
				let payload: unknown;
				let thrown: unknown;
				try {
					payload = options2.onPayload(options.params ?? { model: "rebuilt", max_tokens: 1, messages: [] });
				} catch (error) {
					thrown = error;
				}
				if (thrown) return { result: () => Promise.reject(thrown) };
				warms.push({ payload, options: options2, at: Date.now(), attempt: state.attempts });
				const n = warms.length;
				const answer = respond?.(n) ?? {};
				const usage = refreshUsage(answer.usage);
				const response = { stopReason: answer.stopReason ?? "stop", errorMessage: answer.errorMessage, usage };
				return {
					result: () =>
						options.hold?.(n)
							? new Promise((resolve) => {
									pending = () => resolve(response);
									// A transport that does not pass the cancellation on keeps the request open.
									if (!state.ignoresAbort) options2.signal.addEventListener("abort", () => resolve({ stopReason: "aborted", usage: state.abortReports ? usage : refreshUsage({ input: 0, output: 0, cacheRead: 0 }) }));
								})
							: Promise.resolve(response),
				};
			},
		},
		compact: () => {
			state.compacts++;
			state.compactedAt = Date.now();
		},
	};
	const emit = (event: string, payload: unknown = {}) => handlers.get(event)?.(payload, ctx);
	// One real request: Pi builds the context, sends the payload (the bridge sends none), the answer lands.
	const request = (messages: unknown[], payload: unknown, answer: unknown) => {
		emit("context_with_system", { messages });
		if (options.bridge) emit("message_start", { message: answer });
		else emit("before_provider_request", { payload });
		emit("message_end", { message: answer });
	};
	request([user], sent, reply);
	// A run after the first: false is cancelled before any request goes out; true sends one whose answer reads the
	// cache; "aborted" sends one that is aborted after reading the cache; "error" sends one that fails before using it;
	// "uncached" sends one answered successfully without using the cache.
	let runs = 0;
	const run = (answer: boolean | "aborted" | "error" | "uncached", beforeSettled?: () => void) => {
		state.idle = false;
		emit("agent_start");
		runs++;
		const message = { role: "user", content: [{ type: "text", text: `more ${runs}` }], timestamp: Date.now() };
		branch.push({ type: "message", id: `u${runs}`, parentId: null, timestamp: new Date().toISOString(), message } as never);
		if (answer) {
			const used = answer === "error" ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : answer === "uncached" ? { input: 900, output: 5, cacheRead: 0, cacheWrite: 0 } : { input: 2, output: 5, cacheRead: cached, cacheWrite: 0 };
			const reply2 = { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: Date.now(), stopReason: answer === true || answer === "uncached" ? "stop" : answer, ...by, usage: used };
			const list = Array.isArray(sent.messages) ? "messages" : "input";
			request([user, message], { ...sent, [list]: [...((sent as Record<string, unknown[]>)[list] ?? []), { role: "user", content: `more ${runs}` }] }, reply2);
			branch.push({ type: "message", id: `a${runs}`, parentId: null, timestamp: new Date().toISOString(), message: reply2 } as never);
		}
		beforeSettled?.();
		state.idle = true;
		emit("agent_settled", { aborted: answer !== true && answer !== "uncached" });
	};
	// Runs the idle clock second by second, letting each refresh land, until a compaction starts or `ms` passed.
	const idle = async (ms: number) => {
		// A refresh started before (by agent_settled, say) lands before the clock moves on, as it would in Pi.
		await flush();
		for (let elapsed = 0; elapsed < ms && state.compacts === 0; elapsed += 1000) {
			const before = state.attempts;
			mock.timers.tick(1000);
			if (state.attempts > before) await flush();
		}
	};
	const decide = (action = "warm") => emit("cache_warming_decision", { type: "cache_warming_decision", warmCost: 0.18, missCost: 2.07, continuationProbability: 0.15, action });
	const command = async (name: string) => {
		notes.length = 0;
		await commands.get(name)?.("", ctx);
		return notes.join("\n");
	};
	const signal = (name: string, payload: unknown) => bus.get(name)?.(payload);
	return { emit, idle, warms, state, sent, model, branch, statuses, notes, command, decide, run, usage: refreshUsage, ctx, thinkingLevel, release: () => pending?.(), signal };
}

const allTraces = () =>
	readFileSync(join(dir, "cache-keeper.jsonl"), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
const traces = () => allTraces().filter((record) => record.event === "warm" || record.event === "expiry");
// The models a missed refresh left to Pi belong to the Pi process (R9); each test starts as a new process.
const newProcess = () => delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-cache-keeper.warm-misses")];
// The footer as it reads without PI_OFFLINE (with it, it adds that no model data was fetched).
const online = (t: { after: (fn: () => void) => void }) => {
	const saved = process.env.PI_OFFLINE;
	delete process.env.PI_OFFLINE;
	t.after(() => {
		if (saved !== undefined) process.env.PI_OFFLINE = saved;
	});
};
const fresh = (keepWarm: Record<string, unknown> = {}) => {
	newProcess();
	settings({ keepWarmMinutes: 120, minContextTokens: 100_000, ...keepWarm });
	writeFileSync(join(dir, "cache-keeper.jsonl"), "");
};
const clock = (now = 1_000) => {
	mock.timers.reset();
	mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now });
};

// Pi's own warmer, as Pi 1.5.2 runs it (not exported from the package root; skipped where the installed Pi has none),
// beside the extension with a fake transport. Its decisions go through the extension's cache_warming_decision handler,
// as Pi's extension runner sends them.
const warmerFile = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/cache-warmer.js", import.meta.url);
const { CacheWarmer } = existsSync(warmerFile) ? await import(warmerFile.href) : { CacheWarmer: undefined };
const noWarmer = CacheWarmer ? false : "the installed Pi has no CacheWarmer";

function withPiWarmer(h: ReturnType<typeof harness>) {
	const piRefreshes: number[] = [];
	const decisions: { at: number; pi: string; answer: unknown }[] = [];
	const answer = () => ({ stopReason: "stop", provider: h.model.provider, model: h.model.id, usage: h.usage() });
	const transport = {
		streamSimple: () => {
			piRefreshes.push(Date.now());
			return { result: () => Promise.resolve(answer()) };
		},
	};
	const warmer = new CacheWarmer(transport, h.ctx.sessionManager, () => "idle", async (event: { action: string }) => {
		const result = h.emit("cache_warming_decision", event) as { action?: string } | undefined;
		decisions.push({ at: Date.now(), pi: event.action, answer: result });
		return result?.action ?? event.action;
	});
	// Pi starts its warmer with each real request.
	const start = () => warmer.start({ model: h.model, context: { messages: [] }, options: {} }, () => true);
	const advance = async (ms: number) => {
		for (let elapsed = 0; elapsed < ms && h.state.compacts === 0; elapsed += 1000) {
			mock.timers.tick(1000);
			await flush();
			await flush();
		}
	};
	return { warmer, start, piRefreshes, decisions, advance };
}

// ---------------------------------------------------------------------------------------------------------------- R0

test("R0: with keep-warm off, an idle period beside Pi's own warmer sends and logs what 0.4.1 does; the decision handler returns nothing", { skip: noWarmer }, async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	fresh({ keepWarmMinutes: 0 });
	const h = harness({ lifetime: 300, cost: WITH_WRITE });
	const pi = withPiWarmer(h);
	t.after(() => pi.warmer.cancel());
	pi.start();
	h.emit("agent_settled");
	pi.warmer.onAgentSettled();
	await pi.advance(2 * HOUR);
	// Pi refreshes at 90% of each lifetime until its 30-minute idle limit; then the cache is compacted 20 s before expiry.
	assert.deepEqual(pi.piRefreshes, [271_000, 541_000, 811_000, 1_081_000, 1_351_000, 1_621_000]);
	assert.ok(pi.decisions.every((d) => d.answer === undefined), "the handler returns nothing");
	assert.deepEqual(h.warms, [], "the extension sends nothing of its own");
	assert.equal(h.state.compacts, 1);
	assert.equal(h.state.compactedAt, 1_901_000);
	// The whole log, as 0.4.1 writes it (no model or lifetime on the expiry record).
	assert.deepEqual(allTraces(), [{ event: "expiry", action: "compact", secondsLeft: 20, contextTokens: 600_000, at: new Date(1_901_000).toISOString(), session: "s1" }]);
});

// ---------------------------------------------------------------------------------------------------------------- R1

test("R1: in a period the extension owns, Pi's idle decisions are answered stop and Pi sends nothing; the extension keeps it warm", { skip: noWarmer }, async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	fresh({ compactBeforeExpiry: false });
	const h = harness({ lifetime: 300, cost: WITH_WRITE });
	const pi = withPiWarmer(h);
	t.after(() => pi.warmer.cancel());
	pi.start();
	h.emit("agent_settled");
	pi.warmer.onAgentSettled();
	await pi.advance(HOUR);
	assert.deepEqual(pi.piRefreshes, [], "Pi sends nothing");
	assert.deepEqual(pi.decisions, [{ at: 271_000, pi: "warm", answer: { action: "stop" } }], "its one idle decision was answered stop, which ends Pi's warming");
	assert.deepEqual(h.warms.map((w) => w.at).slice(0, 3), [276_000, 551_000, 826_000], "the extension refreshes 25 s before each expiry");
	assert.equal(h.warms.length, 11, "until the budget ends it");
	const stopped = traces().find((r) => r.action === "pi-stopped");
	assert.equal(stopped.model, "cliproxyapi/sub/claude");
	assert.match(stopped.reason, /^this extension keeps this idle period's cache warm/);

	// Every decision that arrives while idle is answered stop, also once warming ended: it is the period's, not Pi's.
	for (const action of ["warm", "stop"]) assert.deepEqual(h.decide(action), { action: "stop" });
});

test("R1: during a run, and between Pi marking the run active and agent_start, the handler returns nothing", { skip: noWarmer }, async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	fresh();
	const h = harness({ lifetime: 300, cost: WITH_WRITE });
	h.emit("agent_settled");
	assert.deepEqual(h.decide(), { action: "stop" });
	// Pi marks the run active (isIdle false) before agent_start reaches the extension.
	h.state.idle = false;
	assert.equal(h.decide(), undefined);
	h.emit("agent_start");
	assert.equal(h.decide(), undefined);
	// Idle again, but agent_start came and agent_settled did not yet: still nothing.
	h.state.idle = true;
	assert.equal(h.decide(), undefined);

	// With Pi's real warmer: a decision during a run stands, and Pi refreshes.
	const pi = withPiWarmer(h);
	t.after(() => pi.warmer.cancel());
	h.state.idle = false;
	pi.start();
	await pi.advance(275_000);
	assert.deepEqual(pi.piRefreshes, [271_000]);
	assert.equal(pi.decisions[0].answer, undefined);
	assert.equal(h.warms.length, 0);
	// The run settles with no new answer: the period goes on, and Pi's next idle decision is answered stop.
	h.state.idle = true;
	h.emit("agent_settled");
	pi.warmer.onAgentSettled();
	await pi.advance(300_000);
	assert.deepEqual(pi.piRefreshes, [271_000]);
	assert.deepEqual(pi.decisions.at(-1)?.answer, { action: "stop" });
	assert.ok(h.warms.length >= 1, "the extension refreshes");
	// The period's expiry comes from its own facts (its answer at 1 s), not Pi's refresh during the run: the refresh due at
	// 276 s goes out as soon as the run settles, a few seconds after Pi's, on the safe side.
	assert.equal(h.warms[0].at, 276_000, "25 s before the expiry counted from the period's answer");
});

for (const [label, options] of [
	["a 30-second lifetime", { lifetime: 30 }],
	["a request without a payload (pi-claude-bridge)", { lifetime: 300, bridge: true }],
	["a request that cannot be replayed (budget-based thinking)", { lifetime: 300, thinking: { type: "enabled", budget_tokens: 8000 } }],
	// Output limits under keys the extension does not cap (pi 1.5.2's Bedrock and Mistral adapters, as the review captured
	// them): a refresh would keep the captured 8,192 and could generate a full answer.
	["Amazon Bedrock: inferenceConfig.maxTokens", { lifetime: 300, model: { api: "bedrock-converse-stream" }, sent: { modelId: "m", messages: [{ role: "user", content: [{ text: "hi" }] }], inferenceConfig: { maxTokens: 8192 } }, params: { inferenceConfig: { maxTokens: 1 } } }],
	["Mistral: maxTokens", { lifetime: 300, model: { api: "mistral-conversations" }, sent: { model: "m", stream: true, messages: [{ role: "user", content: "hi" }], maxTokens: 8192 }, params: { maxTokens: 1 } }],
	// Gemini's `contents`, which the send path does not accept.
	["Gemini: contents", { lifetime: 300, model: { api: "google-generative-ai" }, sent: { model: "g", contents: [{ role: "user", parts: [{ text: "hi" }] }], config: { maxOutputTokens: 8192 } }, params: { config: { maxOutputTokens: 1 } } }],
	// Codex sends no output limit at all.
	["Codex: no output limit", { lifetime: 300, model: { api: "openai-codex-responses" }, sent: { model: "c", instructions: "s", input: [{ role: "user", content: "hi" }] }, params: {} }],
	// An API the extension re-sends, whose request carried no limit (OpenAI Responses without supportsMaxOutputTokens).
	["OpenAI Responses without an output limit", { lifetime: 300, model: { api: "openai-responses" }, sent: { model: "o", input: [{ role: "user", content: "hi" }] }, params: {} }],
] as Array<readonly [string, Options]>) {
	test(`R1: a period the extension cannot own (${label}) is Pi's: the handler returns nothing, the extension sends nothing, Pi refreshes as with keep-warm off`, { skip: noWarmer }, async (t) => {
		const runOnce = async (keepWarmMinutes: number) => {
			clock();
			fresh({ keepWarmMinutes, compactBeforeExpiry: false });
			const h = harness({ ...options, cost: WITH_WRITE });
			const pi = withPiWarmer(h);
			pi.start();
			h.emit("agent_settled");
			pi.warmer.onAgentSettled();
			await pi.advance(40 * 60_000);
			pi.warmer.cancel();
			mock.timers.reset();
			return { pi: pi.piRefreshes, answers: pi.decisions.map((d) => d.answer), warms: h.warms.length };
		};
		t.after(() => mock.timers.reset());
		const off = await runOnce(0);
		const on = await runOnce(120);
		assert.ok(on.pi.length > 0, "Pi refreshes");
		assert.deepEqual(on.pi, off.pi, "exactly as with keep-warm off");
		assert.ok(on.answers.every((a) => a === undefined));
		assert.equal(on.warms, 0);
		assert.deepEqual(traces().filter((r) => r.event === "warm"), [], "and logs no refresh of its own");
	});
}

test("R1: /cache-keeper says why a period is left to Pi's own warming", async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	fresh();
	let h = harness({ lifetime: 30, cost: WITH_WRITE });
	h.emit("agent_settled");
	assert.match(await h.command("cache-keeper"), /keep warm: up to 2 h after Pi goes idle; stops once refreshing has cost as much as one cache miss; this session is left to Pi's own warming: the cache lifetime \(30 s\) is under a minute/);
	h = harness({ lifetime: 300, bridge: true, cost: WITH_WRITE });
	h.emit("agent_settled");
	assert.match(await h.command("cache-keeper"), /left to Pi's own warming: claude-bridge requests cannot be re-sent/);
	h = harness({ lifetime: 300, thinking: { type: "enabled", budget_tokens: 8000 } });
	h.emit("agent_settled");
	assert.match(await h.command("cache-keeper"), /at most 10 refreshes \(this model has no prices, so the cost of a miss is unknown\); this session is left to Pi's own warming: the request turns thinking on \(thinking: \{ type: "enabled" \} with a budget of 8000 tokens\)/);
	h = harness({ lifetime: 300, model: { api: "bedrock-converse-stream" }, sent: { modelId: "m", messages: [], inferenceConfig: { maxTokens: 8192 } } });
	h.emit("agent_settled");
	assert.match(await h.command("cache-keeper"), /left to Pi's own warming: this API's requests are not re-sent by the extension \(bedrock-converse-stream\)/);
	h = harness({ lifetime: 300, model: { api: "openai-responses" }, sent: { model: "o", input: [] } });
	h.emit("agent_settled");
	assert.match(await h.command("cache-keeper"), /left to Pi's own warming: the request carries no output limit the extension can cap/);
});

test("R1: a run whose last request failed before using the cache: the period is its earlier answer's, owned, and that request is re-sent", async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	fresh({ compactBeforeExpiry: false });
	const h = harness({ lifetime: 300, cost: WITH_WRITE });
	h.emit("agent_settled");
	await h.idle(100_000);
	// One run, two requests: the first is answered from the cache (a tool call), the second fails before using it.
	h.state.idle = false;
	h.emit("agent_start");
	const ask = { role: "user", content: [{ type: "text", text: "go" }], timestamp: Date.now() };
	const turn = { role: "assistant", content: [{ type: "text", text: "calling" }], timestamp: Date.now(), stopReason: "toolUse", usage: { input: 2, output: 5, cacheRead: 600_000, cacheWrite: 0 } };
	const tool = { role: "toolResult", toolCallId: "t", toolName: "x", content: [{ type: "text", text: "done" }], isError: false, timestamp: Date.now() };
	const failed = { role: "assistant", content: [], timestamp: Date.now() + 1, stopReason: "error", errorMessage: "overloaded", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	const first = { ...h.sent, messages: [...h.sent.messages, { role: "user", content: "go" }] };
	h.emit("context_with_system", { messages: [ask] });
	h.emit("before_provider_request", { payload: first });
	h.emit("message_end", { message: turn });
	h.emit("context_with_system", { messages: [ask, turn, tool] });
	h.emit("before_provider_request", { payload: { ...first, messages: [...first.messages, { role: "assistant", content: "calling" }, { role: "user", content: "done" }] } });
	h.emit("message_end", { message: failed });
	for (const [id, message] of [["u1", ask], ["a1", turn], ["t1", tool], ["e1", failed]] as const) {
		h.branch.push({ type: "message", id, parentId: null, timestamp: new Date().toISOString(), message } as never);
	}
	h.state.idle = true;
	h.emit("agent_settled");
	assert.deepEqual(h.decide(), { action: "stop" }, "owned");
	await h.idle(300_000);
	assert.equal(h.warms.length, 1);
	assert.deepEqual(h.warms[0].payload, { ...first, max_tokens: 1 }, "the request of the real answer, not the failed one");
});

test("R1: an answer that used the cache, then a successful one that used none: the new period is Pi's, as with keep-warm off", { skip: noWarmer }, async (t) => {
	const runOnce = async (keepWarmMinutes: number) => {
		clock();
		fresh({ keepWarmMinutes, compactBeforeExpiry: false });
		const h = harness({ lifetime: 300, cost: WITH_WRITE });
		const pi = withPiWarmer(h);
		pi.start();
		h.emit("agent_settled");
		pi.warmer.onAgentSettled();
		await pi.advance(100_000);
		// Pi starts its warmer with the new request; it settles after the answer.
		h.run("uncached", () => pi.start());
		pi.warmer.onAgentSettled();
		await pi.advance(40 * 60_000);
		const shown = await h.command("cache-keeper");
		pi.warmer.cancel();
		mock.timers.reset();
		return { pi: pi.piRefreshes, decisions: pi.decisions, warms: h.warms.length, shown, traces: traces() };
	};
	t.after(() => mock.timers.reset());
	const off = await runOnce(0);
	const on = await runOnce(120);
	assert.ok(on.decisions.length > 0, "Pi decided");
	assert.ok(on.decisions.every((d) => d.answer === undefined), "the handler returns nothing");
	assert.deepEqual(on.pi, off.pi, "Pi refreshes exactly as with keep-warm off");
	assert.deepEqual(on.decisions.map((d) => [d.at, d.pi]), off.decisions.map((d) => [d.at, d.pi]));
	assert.equal(on.warms, 0, "the extension sends nothing");
	assert.deepEqual(on.traces.filter((r) => r.event === "warm"), []);
	assert.match(on.shown, /this session is left to Pi's own warming: the last answer did not use the prompt cache/);
});

// ---------------------------------------------------------------------------------------------------------------- R2

test("R2: a 1-hour cache is refreshed twice inside a 2-hour idle window; the time limit is said with the refresh that reaches it; then compacted", async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	fresh();
	const { emit, warms, state, sent } = harness({ model: NO_BREAKDOWN });
	emit("agent_settled");

	// Pi's own warming would refresh at 54 min; the extension waits until 3 min before expiry (57 min).
	mock.timers.tick(HOUR - 181_000);
	assert.equal(warms.length, 0);
	mock.timers.tick(2_000);
	assert.equal(warms.length, 1);
	assert.deepEqual(warms[0].payload, { ...sent, max_tokens: 1 }, "the request is re-sent exactly as sent, with a one-token answer");
	assert.equal(warms[0].options.maxTokens, 1);
	assert.equal(warms[0].options.disableContinuation, true);
	await flush();

	// The refresh at ~57 min carries the cache to ~117 min, still inside the 121-min window: one more at ~114 min.
	mock.timers.tick(HOUR - 181_000);
	assert.equal(warms.length, 1);
	mock.timers.tick(2_000);
	assert.equal(warms.length, 2);
	await flush();

	// That one carries it to ~174 min, past the window: no third refresh, and it compacts 20 s before expiry.
	mock.timers.tick(HOUR - 21_000);
	assert.equal(warms.length, 2);
	assert.equal(state.compacts, 0);
	mock.timers.tick(2_000);
	assert.equal(state.compacts, 1);
	const records = traces();
	assert.deepEqual(records.map((r) => `${r.event}:${r.action}${r.stop ? `:${r.stop}` : ""}`), ["warm:warm", "warm:warm:limit", "expiry:compact"]);
	assert.equal(records[1].reason, "the cache lasts to the end of the 2 h limit after Pi went idle");
	assert.deepEqual(records[1].budget, { unit: "refreshes", spent: 2, limit: 10 }, "a subscription model counts refreshes");
	for (const record of records) {
		assert.equal(record.model, "cliproxyapi/sub/claude");
		assert.equal(record.lifetimeSeconds, 3600);
		assert.equal(record.lifetimeSource, "declared by the model");
	}
});

test("R2: no size threshold: a 20k-token context is refreshed (minContextTokens applies only to compacting)", async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	fresh({ keepWarmMinutes: 1440 });
	const h = harness({ lifetime: 300, cost: WITH_WRITE, cached: 20_000 });
	h.emit("agent_settled");
	await h.idle(3 * HOUR);
	assert.equal(h.warms.length, 11, "a $0.0060 refresh against a $0.069 miss");
	assert.equal(h.warms[0].at, 276_000);
	assert.equal(h.state.compacts, 0, "under minContextTokens (100k here) it is not compacted when warming ends");
	const expiry = traces().at(-1);
	assert.equal(expiry.event, "expiry");
	assert.match(expiry.reason, /under minContextTokens/);
});

test("R2: a message queued at the refresh moment that clears before the last safe moment: the refresh still goes out, once", async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	fresh();
	const h = harness({ lifetime: 300, cost: WITH_WRITE });
	h.emit("agent_settled");
	// The refresh moment is 276 s (25 s before the 301 s expiry); the last safe moment 288.5 s.
	await h.idle(270_000);
	h.state.pending = true;
	await h.idle(14_000);
	assert.equal(h.warms.length, 0);
	h.state.pending = false;
	await h.idle(3_000);
	assert.deepEqual(h.warms.map((w) => w.at), [286_000]);
	await h.idle(100_000);
	assert.equal(h.warms.length, 1, "once");
	const records = traces();
	assert.deepEqual(
		records.map((r) => `${r.event}:${r.action}`),
		["warm:skip", "expiry:skip", "warm:warm"],
		"the hold-up logged once; compacting before expiry had its one try meanwhile (Pi was busy)",
	);
	assert.match(records[0].reason, /^Pi is busy or has queued messages/);

	// Still queued at the last safe moment: nothing goes out for that expiry.
	fresh();
	clock();
	const late = harness({ lifetime: 300, cost: WITH_WRITE });
	late.emit("agent_settled");
	await late.idle(270_000);
	late.state.pending = true;
	await late.idle(25_000);
	late.state.pending = false;
	await late.idle(60_000);
	assert.equal(late.state.attempts, 0);
	assert.match(traces().filter((r) => r.event === "warm").at(-1).reason, /^too late/);
});

// ---------------------------------------------------------------------------------------------------------------- R3

for (const [label, cost, allowed] of [
	["a cache-write price", WITH_WRITE, 11],
	["no cache-write price", WITHOUT_WRITE, 8],
	["no prices", NO_PRICES, 10],
] as const) {
	for (const lifetime of [150, 300, 1800, 3600]) {
		test(`R3: with ${label}, a ${lifetime} s cache is refreshed ${allowed} times, then the budget ends it and compacting before expiry takes over`, async (t) => {
			clock();
			t.after(() => mock.timers.reset());
			fresh({ keepWarmMinutes: 1440 });
			const { emit, idle, warms, state } = harness({ lifetime, cost, ...(lifetime === 300 ? {} : { model: NO_BREAKDOWN }) });
			emit("agent_settled");
			await idle(24 * HOUR);
			assert.equal(warms.length, allowed);
			assert.equal(state.compacts, 1);
			const records = traces();
			const stops = records.filter((r) => r.stop);
			assert.equal(stops.length, 1, "said once");
			const [stop] = stops;
			assert.equal(stop.stop, "budget");
			if (cost === NO_PRICES) {
				// Ends when the 10th refresh settles.
				assert.equal(stop.action, "warm");
				assert.deepEqual(stop.budget, { unit: "refreshes", spent: 10, limit: 10 });
				assert.match(stop.reason, /^10 refreshes since the last answer, the most without prices/);
			} else {
				// Ends when the next one would pass the gate.
				assert.equal(stop.action, "skip");
				assert.equal(stop.budget.unit, "usd");
				assert.ok(near(stop.budget.spent, allowed * REPORTED), "what the refreshes reported they cost");
				assert.ok(stop.budget.spent <= stop.budget.limit && stop.budget.spent + stop.budget.next > stop.budget.limit);
				assert.match(stop.reason, /^refreshing has cost \$1\.\d\d since the last answer; another refresh \(\$0\.18\) would pass the \$\d\.\d\d one cache miss costs$/);
			}
			assert.deepEqual(records.at(-1).event, "expiry");
		});
	}
}

test("R3: a refresh that cost more than expected raises the gate for the next one, and that amount is reserved", async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	// The 10th read 95% ($0.283521): the 11th is reserved at that, and $1.90 + $0.28 passes the budget, so it is not sent.
	fresh({ keepWarmMinutes: 1440, compactBeforeExpiry: false });
	let h = harness({ lifetime: 300, cost: WITH_WRITE, respond: (n) => (n === 10 ? { usage: { cacheRead: 570_000, cacheWrite: 30_000 } } : {}) });
	h.emit("agent_settled");
	await h.idle(3 * HOUR);
	assert.equal(h.warms.length, 10);
	const stop = traces().find((r) => r.stop);
	assert.equal(stop.reason, "refreshing has cost $1.90 since the last answer; another refresh ($0.28) would pass the $2.07 one cache miss costs");
	assert.ok(near(stop.budget.next, 0.283521));

	// The 2nd read 95%: the 3rd is reserved at $0.283521 when it goes out. It is cancelled by a run that sends nothing:
	// without a reported cost the reserve stays counted, and as what it cost is unknown, warming ends for the period.
	fresh({ keepWarmMinutes: 1440, compactBeforeExpiry: false });
	clock();
	h = harness({ lifetime: 300, cost: WITH_WRITE, respond: (n) => (n === 2 ? { usage: { cacheRead: 570_000, cacheWrite: 30_000 } } : {}), hold: (n) => n === 3 });
	h.state.abortReports = false;
	h.emit("agent_settled");
	await h.idle(830_000);
	assert.equal(h.warms.length, 3);
	h.run(false);
	await flush();
	const cancelled = traces().find((r) => r.action === "cancelled");
	assert.ok(near(cancelled.budget.spent, REPORTED + 2 * 0.283521), `${cancelled.budget.spent}`);
	assert.equal(cancelled.usage, undefined);
	assert.deepEqual([cancelled.stop, cancelled.reason], ["unknown", "a new request or a change of session cancelled it"]);
	assert.equal(traces().find((r) => r.stop)?.stop, "unknown");
	await h.idle(HOUR);
	assert.equal(h.warms.length, 3, "a refresh that left is never sent again, and none follows it");
});

test("R3: an error or an abort leaves the reported cost, or else the reserve, in what was spent", async (t) => {
	t.after(() => mock.timers.reset());
	for (const [reports, spent] of [
		[true, REPORTED],
		[false, EXPECTED],
	] as const) {
		// An error: after a reported hit the period waits for the next expiry (warm-period.ts); without reported usage
		// warming ends ("failed").
		clock();
		fresh({ compactBeforeExpiry: false });
		let h = harness({ lifetime: 300, cost: WITH_WRITE, respond: () => ({ stopReason: "error", errorMessage: "stream broke", usage: reports ? {} : { input: 0, output: 0, cacheRead: 0 } }) });
		h.emit("agent_settled");
		await h.idle(HOUR);
		assert.equal(h.warms.length, reports ? 11 : 1, reports ? "each reported a hit, so the next went out, until the budget" : "one, then ended");
		const failed = traces().find((r) => r.action === "failed");
		assert.equal(failed.reason, "stream broke");
		assert.equal(failed.stop, reports ? undefined : "failed");
		assert.ok(near(failed.budget.spent, spent));
		assert.equal(failed.usage?.cost, reports ? REPORTED : undefined);

		// An abort by a run that sent nothing: counted, and never sent again for that expiry. With a reported hit the period
		// waits for the next expiry, counted from the cancelled refresh's send time; without reported usage what it cost is
		// unknown, and warming ends for the period.
		clock();
		fresh({ compactBeforeExpiry: false });
		h = harness({ lifetime: 300, cost: WITH_WRITE, hold: (n) => n === 1 });
		h.state.abortReports = reports;
		h.emit("agent_settled");
		await h.idle(280_000);
		h.run(false);
		await flush();
		const cancelled = traces().find((r) => r.action === "cancelled");
		assert.ok(near(cancelled.budget.spent, spent));
		assert.equal(cancelled.stop, reports ? undefined : "unknown");
		await h.idle(HOUR);
		if (reports) assert.deepEqual(h.warms.map((w) => w.at).slice(0, 2), [276_000, 551_000], "the next one 275 s after the cancelled hit, as after an answered one");
		else assert.equal(h.warms.length, 1, "a refresh that left is not sent again");
	}
});

test("R3: a settlement that reaches the miss ends warming with \"budget\", whatever its outcome", async (t) => {
	t.after(() => mock.timers.reset());
	const fullWrite = { usage: { cacheRead: 0, cacheWrite: 600_000 } };
	for (const [outcome, respond, hold] of [
		["missed", () => fullWrite, false],
		["failed", () => ({ ...fullWrite, stopReason: "error", errorMessage: "cut off" }), false],
		["cancelled", () => fullWrite, true],
	] as const) {
		clock();
		fresh({ compactBeforeExpiry: false });
		const h = harness({ lifetime: 300, cost: WITH_WRITE, respond, hold: () => hold });
		h.emit("agent_settled");
		await h.idle(280_000);
		if (hold) {
			h.run(false);
			await flush();
		}
		await h.idle(HOUR);
		assert.equal(h.warms.length, 1, `${outcome}: no further refresh`);
		const records = traces().filter((r) => r.event === "warm");
		assert.equal(records.length, 1);
		assert.equal(records[0].action, outcome);
		assert.equal(records[0].stop, "budget");
		assert.ok(near(records[0].budget.spent, 2.250021));
	}
});

test("R3: a run that sent nothing does not reset the spending; a new real answer does, also one that was aborted after using the cache", async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	fresh({ keepWarmMinutes: 1440, compactBeforeExpiry: false });
	const h = harness({ lifetime: 300, cost: WITH_WRITE });
	h.emit("agent_settled");
	await h.idle(51 * 60_000);
	assert.equal(h.warms.length, 11);
	h.run(false);
	await h.idle(2 * HOUR);
	assert.equal(h.warms.length, 11, "no new budget for the same period");
	h.run(true);
	await h.idle(2 * HOUR);
	assert.equal(h.warms.length, 22, "a new answer, a new period");
	h.run("aborted");
	await h.idle(2 * HOUR);
	assert.equal(h.warms.length, 33, "an aborted answer that read the cache starts one too");
	assert.equal(traces().filter((r) => r.stop === "budget").length, 3);

	// The time limit counts from when Pi went idle after the period's answer: an empty run 20 minutes into a 30-minute
	// window does not move it.
	fresh({ keepWarmMinutes: 30, compactBeforeExpiry: false });
	clock();
	const w = harness({ lifetime: 300, cost: WITH_WRITE });
	w.emit("agent_settled");
	await w.idle(20 * 60_000);
	assert.equal(w.warms.length, 4);
	w.run(false);
	await w.idle(2 * HOUR);
	assert.equal(w.warms.length, 6);
	const limit = traces().find((r) => r.stop === "limit");
	assert.ok(near(limit.budget.spent, 6 * REPORTED), "the refreshes before the empty run are still counted");
});

// ---------------------------------------------------------------------------------------------------------------- R4

test("R4: each end reason is recorded once, with the amounts, in the log, the footer and /cache-keeper", async (t) => {
	online(t);
	t.after(() => mock.timers.reset());
	const ended = async (options: Options, act?: (h: ReturnType<typeof harness>) => Promise<void> | void, minutes = 120) => {
		clock();
		fresh({ keepWarmMinutes: minutes, compactBeforeExpiry: false });
		const h = harness({ ui: true, ...options });
		h.emit("agent_settled");
		if (act) await act(h);
		await h.idle(3 * HOUR);
		const stops = traces().filter((r) => r.stop);
		assert.equal(stops.length, 1, `${JSON.stringify(stops)}`);
		const footer = h.statuses.map((s) => s.text).filter((text) => text?.includes("keep-warm ended"));
		return { h, stop: stops[0], footer: footer[0], shown: await h.command("cache-keeper") };
	};
	// After the countdown and why warming ended, the values in use: the period's tier and lifetime, the request as sent
	// (no cache marker, Pi's default cache, which is the short tier the period counts), and the price.
	const values = (lifetime: string, price = "api $3/$15 per M") => ` · short ${lifetime} (in use) · long ${lifetime} · sent default cache · ${price}`;

	// budget: with prices (gate) and without (count).
	let r = await ended({ lifetime: 300, cost: WITH_WRITE }, undefined, 1440);
	assert.equal(r.stop.stop, "budget");
	assert.equal(r.footer, `cache warm · 0:24 left · keep-warm ended (budget reached): $1.98 spent, a miss costs $2.07${values("5m")}`);
	assert.match(r.shown, /keep warm: up to 24 h after Pi goes idle; stops once refreshing has cost as much as one cache miss; keep-warm ended \(budget reached\): \$1\.98 spent, a miss costs \$2\.07, until your next message \(refreshing has cost/);
	r = await ended({ lifetime: 300 }, undefined, 1440);
	assert.equal(r.footer, `cache warm · 5m left · keep-warm ended (budget reached): 10 of 10 refreshes${values("5m", "api, price unknown")}`, "ended when the 10th refresh settled");

	// limit: the last refresh carries the cache past the window; or the answer's own lifetime already covers it.
	r = await ended({ lifetime: 3600, cost: WITH_WRITE, model: NO_BREAKDOWN });
	assert.deepEqual([r.stop.action, r.stop.stop, r.h.warms.length], ["warm", "limit", 2]);
	assert.equal(r.footer, `cache warm · 60m left · keep-warm ended (2 h limit): $0.36 spent, a miss costs $2.07${values("1h")}`);
	r = await ended({ lifetime: 3600, cost: WITH_WRITE, model: NO_BREAKDOWN }, undefined, 30);
	assert.deepEqual([r.stop.action, r.stop.stop, r.h.warms.length], ["skip", "limit", 0]);
	assert.equal(r.stop.idleMinutes, 0, "recorded when the period starts");
	assert.equal(r.footer, `cache warm · 60m left · keep-warm ended (30 min limit): $0 spent, a miss costs $2.07${values("1h")}`);

	// missed: a refresh read under 90% from the cache.
	r = await ended({ lifetime: 300, cost: WITH_WRITE, respond: () => ({ usage: { cacheRead: 300_000, cacheWrite: 300_000 } }) });
	assert.deepEqual([r.stop.action, r.stop.stop, r.h.warms.length], ["missed", "missed", 1]);
	assert.equal(r.stop.reason, "the refresh read only 49% from the cache, so it wrote the context again");
	// Something gone wrong is marked, right after the countdown. Only a hit moves the period's expiry, so the countdown
	// still counts from the answer (the miss wrote the cache again; the earlier time is the safe side).
	assert.equal(r.footer, `cache warm · 0:25 left · ⚠ keep-warm ended (a refresh missed the cache): $1.22 spent, a miss costs $2.07${values("5m")}`);

	// failed: a refresh ended in an error before it reported usage (one that reported a hit first is waiting again).
	r = await ended({ lifetime: 300, cost: WITH_WRITE, respond: () => ({ stopReason: "error", errorMessage: "overloaded", usage: { input: 0, output: 0, cacheRead: 0 } }) });
	assert.deepEqual([r.stop.action, r.stop.stop, r.h.warms.length], ["failed", "failed", 1]);
	assert.equal(r.footer, `cache warm · 0:25 left · ⚠ keep-warm ended (a refresh failed): $0.18 spent, a miss costs $2.07${values("5m")}`);

	// unknown: a refresh came back without a prompt in its usage, so what it cost is unknown.
	r = await ended({ lifetime: 300, cost: WITH_WRITE, respond: () => ({ usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 } }) });
	assert.deepEqual([r.stop.action, r.stop.stop, r.h.warms.length, r.stop.reason], ["warm", "unknown", 1, "the refresh reported no usage, so what it cost is unknown"]);
	// Not a hit, so the expiry still counts from the answer.
	assert.equal(r.footer, `cache warm · 0:25 left · ⚠ keep-warm ended (a refresh reported no usage): $0.18 spent, a miss costs $2.07${values("5m")}`);
	assert.match(r.shown, /keep-warm ended \(a refresh reported no usage\): \$0\.18 spent, a miss costs \$2\.07, until your next message \(the refresh reported no usage, so what it cost is unknown\)/);

	// unable: a branch move made the extension forget the request, so it can't refresh the period: it ends there, said
	// once, and the period is Pi's from then on (R7: no "stop" where the extension knows it will not send).
	r = await ended({ lifetime: 300, cost: WITH_WRITE }, async (h) => {
		await h.idle(200_000);
		h.emit("session_tree");
		// Let go at 201 s, the five-minute cache alive until 301 s: Pi's warming is not stopped.
		assert.equal(h.decide(), undefined, "Pi's warming decides while the cache can be alive");
	});
	assert.deepEqual([r.stop.action, r.stop.stop, r.h.warms.length], ["skip", "unable", 0]);
	assert.match(r.stop.reason, /^the extension no longer holds the period's request \(the model, the branch or the conversation changed\), so it can't refresh it$/);
	assert.equal(r.footer, undefined, "no 'keep-warm ended': the period is Pi's");
	// The branch move forgot the request, so the footer no longer says what was sent.
	assert.equal(lastFooter(r.h), "cache cold · next message full price · keep-warm: Pi's (request let go) · short 5m (in use) · long 5m · api $3/$15 per M");
	// Three hours on, nothing seen says the period's cache is alive (Pi's refreshes included): Pi's refresh would write it.
	assert.deepEqual(r.h.decide(), { action: "stop" });
});

test("R4: an abort by a real request ends nothing; the new answer starts a new period", async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	fresh({ compactBeforeExpiry: false });
	const h = harness({ lifetime: 300, cost: WITH_WRITE, hold: (n) => n === 1 });
	h.emit("agent_settled");
	await h.idle(280_000);
	h.run(true);
	await flush();
	await h.idle(HOUR);
	assert.equal(traces().filter((r) => r.stop).length, 1, "only the new period's budget end");
	assert.equal(h.warms.length, 12);
});

// ---------------------------------------------------------------------------------------------------------------- R5

test("R5: never after expiry: a payload held up past the last safe moment is withheld; a countdown past expiry sends nothing", async (t) => {
	clock();
	t.after(() => mock.timers.reset());

	// The request was slow to go out (a login being renewed): at onPayload less than half the lead is left.
	fresh({ compactBeforeExpiry: false });
	let h = harness({ lifetime: 300, cost: WITH_WRITE });
	h.state.beforePayload = () => mock.timers.setTime(Date.now() + 20_000);
	h.emit("agent_settled");
	mock.timers.tick(276_000);
	await flush();
	assert.equal(h.state.attempts, 1);
	assert.equal(h.warms.length, 0, "the payload was never released");
	mock.timers.tick(60_000);
	assert.equal(h.state.attempts, 1, "not tried again for that expiry");
	let records = traces();
	assert.deepEqual(records.map((r) => `${r.action}:${r.stop ?? ""}`), ["skip:"], "no end reason: the period is not over");
	assert.match(records[0].reason, /^too late: the cache was about to expire before the refresh went out/);

	// The computer slept through the expiry: the countdown wakes after it and stops, with nothing sent or compacted.
	fresh();
	clock();
	h = harness({ lifetime: 300, cost: WITH_WRITE });
	h.emit("agent_settled");
	mock.timers.setTime(1_000 + 305_000);
	mock.timers.tick(1000);
	mock.timers.tick(60_000);
	assert.equal(h.state.attempts, 0);
	assert.equal(h.state.compacts, 0);
	assert.deepEqual(traces(), []);

	// It woke 5 s before expiry, past half the 25-s lead: too late to refresh.
	fresh({ compactBeforeExpiry: false });
	clock();
	h = harness({ lifetime: 300, cost: WITH_WRITE });
	h.emit("agent_settled");
	mock.timers.setTime(1_000 + 295_000);
	mock.timers.tick(1000);
	assert.equal(h.state.attempts, 0);
	records = traces();
	assert.match(records.at(-1).reason, /^too late: less than half the warm lead is left/);
});

// ---------------------------------------------------------------------------------------------------------------- R6

test("R6: what the settings and /cache-keeper say", async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	fresh();
	const h = harness({ lifetime: 300, cost: WITH_WRITE });
	h.emit("agent_settled");
	assert.match(await h.command("cache-keeper-settings"), /\nkeepWarmMinutes: 120 \(up to 2 h after Pi goes idle; stops once refreshing has cost as much as one cache miss; so far \$0 spent, a miss costs \$2\.07\)\n/);
	assert.match(await h.command("cache-keeper"), /\nkeep warm: up to 2 h after Pi goes idle; stops once refreshing has cost as much as one cache miss; so far \$0 spent/);
	fresh({ keepWarmMinutes: 0 });
	const off = harness({ lifetime: 300, cost: WITH_WRITE });
	off.emit("agent_settled");
	assert.match(await off.command("cache-keeper"), /\nkeep warm: off\n/);
});

// ----------------------------------------------------------------- R7: when in doubt, do not send and do not stop Pi

test("R7/1: at the last moment, a refresh whose payload would not carry the provider-built capped limit is withheld, and warming ends (unable)", async (t) => {
	t.after(() => mock.timers.reset());
	for (const [label, params] of [
		["no known key from the provider", { model: "rebuilt", messages: [], inferenceConfig: { maxTokens: 1 } }],
		["the captured value", { model: "rebuilt", max_tokens: 64_000, messages: [] }],
	] as const) {
		clock();
		fresh({ compactBeforeExpiry: false });
		const h = harness({ lifetime: 300, cost: WITH_WRITE, params });
		h.emit("agent_settled");
		await h.idle(HOUR);
		assert.equal(h.state.attempts, 1, label);
		assert.equal(h.warms.length, 0, `${label}: nothing went out`);
		const stops = traces().filter((r) => r.stop);
		assert.equal(stops.length, 1);
		assert.equal(stops[0].stop, "unable");
		assert.match(stops[0].reason, /no output limit the extension knows|above the 1 a refresh of anthropic-messages may/);
		assert.equal(stops[0].budget.spent, 0, "nothing reserved");
	}
});

test("R7/2: a lifetime that reads differently during a period ends warming (unable) without another refresh, and the period is Pi's", async (t) => {
	t.after(() => mock.timers.reset());
	const saved = process.env.PI_CACHE_RETENTION;
	t.after(() => (saved === undefined ? delete process.env.PI_CACHE_RETENTION : (process.env.PI_CACHE_RETENTION = saved)));
	delete process.env.PI_CACHE_RETENTION;
	const cases: [string, (h: ReturnType<typeof harness>) => void, RegExp, Record<string, unknown>?][] = [
		// The model's declared lifetime for the request's tier changed (new model data).
		["model data changed", (h) => (h.model.promptCache = { short: 3600, long: 3600 }), /^the request's cache now lasts 60 min by the route's data, the cached request was written with 5 min$/],
		// A proxy said another upstream answered, whose lifetime is unknown. On a route whose answers report no write
		// breakdown, nothing else gives the request a lifetime (on Anthropic Messages, a request without a marker has
		// five minutes as its default, which still holds).
		["lifetime unknown", (h) => delete h.model.promptCache, /^the request's cache now lasts an unknown time, the cached request was written with 5 min$/, NO_BREAKDOWN],
		// The declared lifetime fell from 300 s to 30 s.
		["lifetime lowered", (h) => (h.model.promptCache = { short: 30, long: 30 }), /^the request's cache now lasts 30 s by the route's data, the cached request was written with 5 min$/],
	];
	for (const [label, change, reason, route] of cases) {
		clock();
		fresh({ compactBeforeExpiry: false });
		delete process.env.PI_CACHE_RETENTION;
		const h = harness({ lifetime: 300, cost: WITH_WRITE, model: { promptCache: { short: 300, long: 3600 }, ...route } });
		h.emit("agent_settled");
		await h.idle(60_000);
		change(h);
		if (label === "model data changed") {
			// Handed over at once, its five minutes counted from the answer at 1 s: until 301 s Pi's warming is not stopped.
			await h.idle(15_000);
			assert.equal(h.decide(), undefined, `${label}: Pi's warming decides while the cache can be alive`);
		}
		await h.idle(2 * HOUR);
		assert.equal(h.state.attempts, 0, `${label}: no refresh`);
		const stops = traces().filter((r) => r.stop);
		assert.equal(stops.length, 1, label);
		assert.equal(stops[0].stop, "unable");
		assert.match(stops[0].reason, reason);
		assert.equal(stops[0].lifetimeSeconds, 300, "logged with the period's lifetime");
		// The extension knows it will not send: Pi's warming decides, and is stopped only once nothing seen says the cache is
		// alive (two hours on, past the shortest lifetime read); where no lifetime can be read, never.
		assert.deepEqual(h.decide(), label === "lifetime unknown" ? undefined : { action: "stop" }, "Pi's warming decides from then on");
	}
});

test("R7/2: another model's reported tier does not set the lifetime of the period's request", async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	fresh({ compactBeforeExpiry: false });
	// A Claude bridge answer wrote a 1-hour cache; then this model answered, writing its short (5-min) one.
	const bridge = { role: "assistant", content: [], timestamp: 500, stopReason: "stop", provider: "claude-bridge", model: "opus", usage: { input: 2, output: 5, cacheRead: 0, cacheWrite: 900, cacheWrite1h: 900 } };
	const h = harness({ lifetime: 300, cost: WITH_WRITE, model: { promptCache: { short: 300, long: 3600 } }, before: [{ type: "message", id: "b", parentId: null, timestamp: new Date(500).toISOString(), message: bridge }] });
	h.emit("agent_settled");
	await h.idle(400_000);
	assert.equal(h.warms[0]?.at, 276_000, "25 s before the 5-minute expiry, not the 1-hour one");
});

test("R7/3: an answer that streamed past its cache's last safe refresh moment: the period is Pi's, so Pi's warmer goes on and the extension sends nothing", { skip: noWarmer }, async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	fresh({ compactBeforeExpiry: false });
	const h = harness({ lifetime: 300, cost: WITH_WRITE, ui: true });
	h.emit("agent_settled");
	await h.idle(100_000);
	// A run at 101 s: the answer, stamped when it started streaming (101 s), is appended when it ends, at 420 s. Pi's
	// warmer, started with the request, refreshes it at 371 s while the answer streams.
	const pi = withPiWarmer(h);
	t.after(() => pi.warmer.cancel());
	h.state.idle = false;
	h.emit("agent_start");
	pi.start();
	const ask = { role: "user", content: [{ type: "text", text: "go" }], timestamp: Date.now() };
	const payload = { ...h.sent, messages: [...h.sent.messages, { role: "user", content: "go" }] };
	h.branch.push({ type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(), message: ask } as never);
	h.emit("context_with_system", { messages: [ask] });
	h.emit("before_provider_request", { payload });
	const answer = { role: "assistant", content: [{ type: "text", text: "long" }], timestamp: Date.now(), stopReason: "stop", provider: h.model.provider, model: h.model.id, usage: { input: 2, output: 5, cacheRead: 600_000, cacheWrite: 0 } };
	await pi.advance(319_000);
	assert.deepEqual(pi.piRefreshes, [371_000], "Pi refreshed during the run");
	h.emit("message_end", { message: answer });
	h.branch.push({ type: "message", id: "a1", parentId: null, timestamp: new Date().toISOString(), message: answer } as never);
	h.state.idle = true;
	h.emit("agent_settled");
	pi.warmer.onAgentSettled();
	// The period's own expiry is 101 + 300 = 401 s; its last safe moment, 401 - 12.5 = 388.5 s, passed before Pi went idle
	// at 420 s: not owned.
	assert.match(lastFooter(h) ?? "", /keep-warm: Pi's \(no time to refresh\)/);
	await pi.advance(600_000);
	assert.deepEqual(h.warms, [], "the extension sends nothing in this period");
	assert.deepEqual(pi.piRefreshes.slice(0, 3), [371_000, 641_000, 911_000], "Pi's warmer goes on, as with keep-warm off");
	assert.ok(pi.decisions.filter((d) => d.at > 420_000).every((d) => d.answer === undefined), "Pi is not told to stop");
});

test("R7/5: a refresh cancelled while it was being prepared reserves nothing and is tried again; ten really go out", async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	fresh({ keepWarmMinutes: 1440, compactBeforeExpiry: false });
	const h = harness({ lifetime: 300 });
	// An empty run starts while the tenth refresh is being prepared: the adapter calls the payload hook with the
	// refresh's signal already aborted.
	h.state.beforePayload = () => {
		if (h.state.attempts !== 10) return;
		h.state.idle = false;
		h.emit("agent_start");
	};
	h.emit("agent_settled");
	for (let i = 0; i < 5000 && h.state.attempts < 10; i++) await h.idle(1000);
	await flush();
	assert.equal(h.warms.length, 9);
	h.state.idle = true;
	h.emit("agent_settled");
	await h.idle(HOUR);
	assert.equal(h.warms.length, 10, "the tenth went out after the run");
	assert.equal(traces().filter((r) => r.action === "cancelled").length, 0, "nothing went out, nothing was counted");
	const stop = traces().find((r) => r.stop);
	assert.deepEqual([stop.stop, stop.budget], ["budget", { unit: "refreshes", spent: 10, limit: 10 }]);
});

test("R7/5: a message queued while the refresh was being prepared: withheld, then sent once the queue clears", async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	fresh({ compactBeforeExpiry: false });
	const h = harness({ lifetime: 300, cost: WITH_WRITE });
	h.state.beforePayload = () => {
		if (h.state.attempts === 1) h.state.pending = true;
	};
	h.emit("agent_settled");
	await h.idle(278_000);
	assert.equal(h.state.attempts, 1);
	assert.equal(h.warms.length, 0, "withheld with the message queued");
	h.state.pending = false;
	await h.idle(5_000);
	assert.deepEqual(h.warms.map((w) => w.at), [280_000], "sent on the first tick the queue was clear");
	const records = traces().filter((r) => r.event === "warm");
	assert.match(records[0].reason, /^Pi got busy or a message was queued while the refresh was being prepared/);
	assert.ok(near(records[1].budget.spent, REPORTED), "only what went out is counted");
});

// pi 1.5.2's own adapters, driven for each API the extension re-sends: the captured request is what the adapter built
// for an answer of up to 8,192 tokens; the refresh goes through the extension and the same adapter, which calls the
// payload hook (stopped there: nothing is sent). The outgoing limit must be the one the adapter built for a 1-token
// answer, in the key the captured request carried it in.
const catalogFile = new URL("../node_modules/@earendil-works/pi-ai/dist/models.generated.js", import.meta.url);
const { MODELS } = existsSync(catalogFile) ? await import(catalogFile.href) : { MODELS: undefined };
const noCatalog = MODELS ? false : "the installed pi-ai has no model catalog";
const adapterUser = { role: "user", content: [{ type: "text", text: "Explain the changes in detail." }], timestamp: 1000 };
// As every Pi session sends a request: a system prompt and at least one tool, carried by the leading system message the
// way Pi 1.5.2 builds it (normalizeContext). A leading system message in `messages` gives the system prompt.
const piTools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
const { normalizeContext } = (await import("@earendil-works/pi-ai/utils/transcript")) as { normalizeContext: (context: unknown) => { messages: unknown[] } };
const piContext = (messages: unknown[] = [adapterUser], tools: unknown[] = piTools) => {
	const [first, ...rest] = messages as { role: string; content: unknown }[];
	const system = first?.role === "system" && typeof first.content === "string" ? first.content : undefined;
	return { messages: normalizeContext({ systemPrompt: system ?? "You are pi.", messages: system === undefined ? messages : rest, tools }).messages };
};
const realAdapter = async (model: { api: string }) => (await import(`@earendil-works/pi-ai/api/${model.api}`)) as { streamSimple: (model: unknown, context: unknown, options: unknown) => { result: () => Promise<unknown> } };
async function adapterPayload(model: { api: string }, options: Record<string, unknown>, messages: unknown[] = [adapterUser], tools: unknown[] = piTools): Promise<Record<string, unknown>> {
	const { streamSimple } = await realAdapter(model);
	let got: Record<string, unknown> | undefined;
	await streamSimple(model, piContext(messages, tools), {
		apiKey: "sk-fixture",
		cacheRetention: "short",
		sessionId: "s1",
		maxRetries: 0,
		...options,
		onPayload: (payload: Record<string, unknown>) => {
			got = payload;
			throw new Error("captured without transport");
		},
	}).result();
	assert.ok(got, "the adapter built a payload");
	return got;
}
// A provider's stream, in memory: server-sent events from objects (or a literal like "[DONE]").
const sse = (events: unknown[]) =>
	new Response(events.map((e) => (typeof e === "string" ? `data: ${e}\n\n` : `${(e as { type?: string }).type ? `event: ${(e as { type: string }).type}\n` : ""}data: ${JSON.stringify(e)}\n\n`)).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
// The extension's refresh through Pi's real adapter to an in-memory transport (nothing leaves the process).
function inMemory(model: { api: string }, cacheRetention: string, reply: () => Response) {
	return (options: Record<string, unknown> & { onPayload: (p: unknown) => unknown; signal: AbortSignal }) => ({
		result: async () => {
			const { streamSimple } = await realAdapter(model);
			return streamSimple(model, piContext(), { ...options, apiKey: "sk-fixture", cacheRetention, maxRetries: 0, fetch: async () => reply() }).result();
		},
	});
}
function viaRealAdapter(model: { api: string }) {
	return (options: Record<string, unknown> & { onPayload: (p: unknown) => unknown }) => {
		let stream: { result: () => Promise<unknown> } | undefined;
		return {
			result: async () => {
				const { streamSimple } = await realAdapter(model);
				stream = streamSimple(model, piContext(), {
					...options,
					apiKey: "sk-fixture",
					cacheRetention: "short",
					onPayload: async (params: unknown) => {
						await options.onPayload(params);
						throw new Error("captured without transport");
					},
				});
				return stream.result();
			},
		};
	};
}

for (const [provider, id, key, capped] of [
	["anthropic", "claude-sonnet-4-6", "max_tokens", 1],
	["moonshotai", "kimi-k3", "max_tokens", 1],
	["cerebras", "gpt-oss-120b", "max_completion_tokens", 1],
	["openai", "gpt-6.1-sol", "max_output_tokens", 16],
] as const) {
	test(`R7/1 allow-list: pi 1.5.2's ${provider}/${id} adapter builds the refresh's limit in ${key}, and it goes out capped (${capped})`, { skip: noCatalog }, async (t) => {
		clock();
		t.after(() => mock.timers.reset());
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			throw new Error("no network in tests");
		}) as typeof fetch;
		t.after(() => (globalThis.fetch = realFetch));
		fresh({ compactBeforeExpiry: false });
		const real = MODELS[provider]?.[id];
		assert.ok(real, `${provider}/${id} in pi's catalog`);
		const sent = await adapterPayload(real, { maxTokens: 8192, reasoning: "high" });
		assert.equal(sent[key], 8192);
		// The catalog's prices may have no cache discount (a miss then costs nothing to avoid): priced as Claude here.
		const h = harness({ lifetime: 300, model: { ...real, cost: WITH_WRITE, promptCache: { short: 300, long: 300 } }, sent, stream: viaRealAdapter(real) });
		h.emit("agent_settled");
		assert.deepEqual(h.decide(), { action: "stop" }, `${real.api} is owned`);
		await h.idle(280_000);
		await flush();
		assert.equal(h.warms.length, 1);
		const out = h.warms[0].payload as Record<string, unknown>;
		assert.equal(out[key], capped);
		assert.deepEqual(out, { ...sent, [key]: capped }, "otherwise exactly the captured request");
	});
}

test("R7/1: a refresh is built with the thinking level its request was sent with, so a level raised since does not lift the limit", { skip: noCatalog }, async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () => {
		throw new Error("no network in tests");
	}) as typeof fetch;
	t.after(() => (globalThis.fetch = realFetch));
	fresh({ compactBeforeExpiry: false });
	// Claude with budget-based thinking: with thinking on, the adapter builds 16,385 tokens for a "1-token" answer.
	const real = MODELS.anthropic["claude-sonnet-4-5"];
	assert.equal((await adapterPayload(real, { maxTokens: 1, reasoning: "high" })).max_tokens, 16_385);
	const sent = await adapterPayload(real, { maxTokens: 8192 });
	const h = harness({ lifetime: 300, cost: WITH_WRITE, level: "off", model: { ...real, promptCache: { short: 300, long: 300 } }, sent, stream: viaRealAdapter(real) });
	h.emit("agent_settled");
	h.thinkingLevel.value = "high";
	await h.idle(280_000);
	await flush();
	assert.equal(h.warms.length, 1);
	assert.equal((h.warms[0].payload as Record<string, unknown>).max_tokens, 1);
});

// ------------------------------------------------- R7, second look: money is safe by construction at the door

const noNetwork = (t: { after: (fn: () => void) => void }) => {
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () => {
		throw new Error("no network in tests");
	}) as typeof fetch;
	t.after(() => (globalThis.fetch = realFetch));
};
test("R7b/1: Shift+Tab while the request awaited credentials: the refresh is built with the thinking its payload shows, and leaves capped at 1", { skip: noCatalog }, async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	noNetwork(t);
	fresh({ compactBeforeExpiry: false });
	// Claude Sonnet 4.5 (budget-based thinking): the request went out with thinking off, but Pi's level read "minimal"
	// when the extension captured it.
	const real = MODELS.anthropic["claude-sonnet-4-5"];
	const sent = await adapterPayload(real, { maxTokens: 64_000 });
	assert.deepEqual(sent.thinking, { type: "disabled" });
	const h = harness({ lifetime: 300, level: "minimal", model: { ...real, cost: WITH_WRITE, promptCache: { short: 300, long: 300 } }, sent, stream: viaRealAdapter(real) });
	h.emit("agent_settled");
	await h.idle(280_000);
	await flush();
	assert.equal(h.warms.length, 1);
	const out = h.warms[0].payload as Record<string, unknown>;
	assert.equal(out.max_tokens, 1, "not 1,025");
	assert.deepEqual(out.thinking, { type: "disabled" });
});

test("R7b/1: a limit of 1,025 or 16,385 never leaves: withheld at the door, warming ends (unable), nothing reserved", { skip: noCatalog }, async (t) => {
	t.after(() => mock.timers.reset());
	noNetwork(t);
	const real = MODELS.anthropic["claude-sonnet-4-5"];
	const cases: [string, Options][] = [
		["the provider built 1,025", { params: { model: "rebuilt", max_tokens: 1025, messages: [] } }],
		["the provider built 16,385", { params: { model: "rebuilt", max_tokens: 16_385, messages: [] } }],
		[
			"pi's real adapter built 16,385 (thinking read as high from the payload)",
			{
				model: { ...real, promptCache: { short: 300, long: 300 } },
				sent: { model: real.id, max_tokens: 8192, thinking: { type: "adaptive" }, output_config: { effort: "high" }, messages: [{ role: "user", content: "hi" }] },
				stream: viaRealAdapter(real),
			},
		],
	];
	for (const [label, options] of cases) {
		clock();
		fresh({ compactBeforeExpiry: false });
		const h = harness({ lifetime: 300, ...options, model: { ...(options.model ?? {}), cost: WITH_WRITE } });
		h.emit("agent_settled");
		await h.idle(280_000);
		await flush();
		assert.equal(h.state.attempts, 1, label);
		assert.equal(h.warms.length, 0, `${label}: nothing reached the transport`);
		const stop = traces().find((r) => r.stop);
		assert.equal(stop?.stop, "unable", label);
		assert.match(stop.reason, /above the 1 a refresh of anthropic-messages may/);
		assert.equal(stop.budget.spent, 0, "nothing reserved");
		await h.idle(HOUR);
		assert.equal(h.state.attempts, 1, "never tried again");
	}
});

test("R7b/1: an OpenAI Responses request already at 16 output tokens is refreshed", { skip: noCatalog }, async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	noNetwork(t);
	fresh({ compactBeforeExpiry: false });
	const real = MODELS.openai["gpt-6.1-sol"];
	const sent = await adapterPayload(real, { maxTokens: 16 });
	assert.equal(sent.max_output_tokens, 16);
	const h = harness({ lifetime: 300, model: { ...real, cost: WITH_WRITE, promptCache: { short: 300, long: 300 } }, sent, stream: viaRealAdapter(real) });
	h.emit("agent_settled");
	await h.idle(280_000);
	await flush();
	assert.equal(h.warms.length, 1);
	assert.deepEqual(h.warms[0].payload, sent);
});

test("R7b/2: retention switched to long while the answer streamed: the request was sent for 5 min, and is refreshed at that lifetime", async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	const saved = process.env.PI_CACHE_RETENTION;
	t.after(() => (saved === undefined ? delete process.env.PI_CACHE_RETENTION : (process.env.PI_CACHE_RETENTION = saved)));
	delete process.env.PI_CACHE_RETENTION;
	fresh({ compactBeforeExpiry: false });
	// The harness sends the request (retention short) and its answer lands; the switch comes before the run settles.
	const h = harness({ lifetime: 300, cost: WITH_WRITE, model: { promptCache: { short: 300, long: 3600 } } });
	process.env.PI_CACHE_RETENTION = "long";
	h.emit("agent_settled");
	await h.idle(400_000);
	assert.equal(h.warms[0]?.at, 276_000, "25 s before the 5-minute expiry, not the 1-hour one");
	assert.equal(traces().find((r) => r.event === "warm" && r.action === "warm").lifetimeSeconds, 300);
	// Later in the period the setting moves no fact of the request: warming goes on at 5 min.
	await h.idle(HOUR);
	assert.deepEqual(h.warms.slice(0, 3).map((w) => w.at), [276_000, 551_000, 826_000]);
	assert.equal(traces().filter((r) => r.stop === "unable").length, 0);
});

test("R7b/2: an Anthropic payload shows its tier: a 1-hour cache_control is refreshed at the 1-hour lifetime whatever the setting", async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	const saved = process.env.PI_CACHE_RETENTION;
	t.after(() => (saved === undefined ? delete process.env.PI_CACHE_RETENTION : (process.env.PI_CACHE_RETENTION = saved)));
	delete process.env.PI_CACHE_RETENTION;
	fresh({ compactBeforeExpiry: false });
	const sent = { model: "claude", max_tokens: 64_000, system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", ttl: "1h" } }], messages: [{ role: "user", content: "hi" }] };
	const h = harness({ lifetime: 300, cost: WITH_WRITE, model: { promptCache: { short: 300, long: 3600 } }, sent });
	h.emit("agent_settled");
	await h.idle(2 * HOUR);
	assert.equal(h.warms[0]?.at, 3_421_000, "3 min before the 1-hour expiry");
});

test("R7b/3: upstream or keepWarmMinutes changed while the refresh was being prepared: nothing leaves, nothing is reserved, warming ends", async (t) => {
	t.after(() => mock.timers.reset());
	const cases: [string, (h: ReturnType<typeof harness>) => void, RegExp][] = [
		// On a route whose answers report no write breakdown: nothing else gives the request a lifetime.
		["the proxy's upstream now has no lifetime", (h) => delete h.model.promptCache, /^the request's cache now lasts an unknown time, the cached request was written with 5 min$/],
		["keepWarmMinutes set to 0", () => settings({ keepWarmMinutes: 0, minContextTokens: 100_000, compactBeforeExpiry: false }), /^keep-warm was turned off$/],
	];
	for (const [label, change, reason] of cases) {
		clock();
		fresh({ compactBeforeExpiry: false });
		const h = harness({ lifetime: 300, cost: WITH_WRITE, model: NO_BREAKDOWN });
		h.state.beforePayload = () => {
			if (h.state.attempts === 1) change(h);
		};
		h.emit("agent_settled");
		await h.idle(280_000);
		await flush();
		assert.equal(h.state.attempts, 1, label);
		assert.equal(h.warms.length, 0, `${label}: nothing reached the transport`);
		const stop = traces().find((r) => r.stop);
		assert.equal(stop?.stop, "unable", label);
		assert.match(stop.reason, reason);
		assert.equal(stop.budget.spent, 0, "nothing reserved");
		await h.idle(HOUR);
		assert.equal(h.state.attempts, 1, `${label}: not tried again`);
	}
});

test("R7b/3: retention switched while the refresh was being prepared changes nothing the period reads: the 5-minute request leaves, capped", async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	const saved = process.env.PI_CACHE_RETENTION;
	t.after(() => (saved === undefined ? delete process.env.PI_CACHE_RETENTION : (process.env.PI_CACHE_RETENTION = saved)));
	delete process.env.PI_CACHE_RETENTION;
	fresh({ compactBeforeExpiry: false });
	const h = harness({ lifetime: 300, cost: WITH_WRITE, model: { promptCache: { short: 300, long: 3600 } } });
	h.state.beforePayload = () => {
		if (h.state.attempts === 1) process.env.PI_CACHE_RETENTION = "long";
	};
	h.emit("agent_settled");
	await h.idle(280_000);
	assert.deepEqual(h.warms.map((w) => w.at), [276_000]);
	assert.equal((h.warms[0].payload as Record<string, unknown>).max_tokens, 1);
});

test("R7b/3: the last gate is the only path: with each single condition broken, the hook makes no transport call and reserves nothing", async (t) => {
	t.after(() => mock.timers.reset());
	const own = (h: ReturnType<typeof harness>, usage: Record<string, number>) => ({ role: "assistant", content: [], timestamp: 1_000, stopReason: "stop", provider: h.model.provider, model: h.model.id, usage });
	const cases: [string, (h: ReturnType<typeof harness>) => void, Options?][] = [
		["the refresh was cancelled", (h) => {
			h.state.idle = false;
			h.emit("agent_start");
		}],
		["keep-warm is off in the current settings", () => settings({ keepWarmMinutes: 0 })],
		["the period is not the one the refresh was started for", (h) => h.emit("session_start")],
		["the model changed", (h) => (h.ctx.model = { ...h.model, id: "another" })],
		["the lifetime changed", (h) => (h.model.promptCache = { short: 60, long: 60 })],
		// An answer of the model's now reports a 1-hour write; both tiers last 5 min by the data, so it lasts otherwise.
		["a write of another lifetime", (h) => h.branch.splice(1, 0, { type: "message", id: "x", parentId: null, timestamp: new Date(500).toISOString(), message: own(h, { input: 1, output: 1, cacheRead: 0, cacheWrite: 10, cacheWrite1h: 10 }) } as never)],
		// Pi's refresh reports a write of another lifetime (an hour, for the five-minute request) while the refresh
		// is being prepared.
		["Pi's refresh wrote otherwise", (h) => h.ctx.sessionManager.appendUsage("cache_warm", h.model.provider, h.model.id, { input: 1, output: 1, cacheRead: 0, cacheWrite: 10, cacheWrite1h: 10 })],
		["Pi is busy", (h) => (h.state.idle = false)],
		["a message is queued", (h) => (h.state.pending = true)],
		["the last safe moment passed", () => mock.timers.setTime(Date.now() + 20_000)],
		["the limit is above the cap", () => {}, { params: { model: "rebuilt", max_tokens: 2, messages: [] } }],
	];
	for (const [label, breakIt, options] of cases) {
		clock();
		fresh({ compactBeforeExpiry: false });
		const h = harness({ lifetime: 300, cost: WITH_WRITE, ...options });
		h.state.beforePayload = () => {
			if (h.state.attempts === 1) breakIt(h);
		};
		h.emit("agent_settled");
		await h.idle(276_000);
		await flush();
		assert.ok(h.state.attempts >= 1, `${label}: the hook was reached`);
		assert.ok(!h.warms.some((w) => w.attempt === 1), `${label}: no transport call`);
		if (label === "the period is not the one the refresh was started for") {
			// The old period ends there, with nothing reserved; the new one (session_start) refreshes for itself.
			const ended = traces().find((r) => r.reason === "a new idle period started");
			assert.equal(ended?.budget.spent, 0, `${label}: nothing reserved`);
			continue;
		}
		assert.equal(h.state.attempts, 1, label);
		assert.ok(traces().every((r) => (r.budget?.spent ?? 0) === 0 && r.action !== "cancelled"), `${label}: nothing reserved`);
		// While a run is active /cache-keeper shows no amounts; otherwise it shows what the period has spent, or, where the
		// period's facts no longer hold (model, lifetime, a write of another lifetime), that the period is Pi's from then on.
		if (label !== "the refresh was cancelled") {
			const drift = ["the model changed", "the lifetime changed", "a write of another lifetime", "Pi's refresh wrote otherwise"].includes(label);
			assert.match((await h.command("cache-keeper")).match(/keep warm: .*/)?.[0] ?? "", drift ? /left to Pi's own warming: / : /^keep warm: (off|.*\$0 spent.*)$/, `${label}: nothing counted`);
			// Pi's decision stands while anything seen says the cache can be alive; the 60-second lifetime read last has passed.
			if (drift) assert.deepEqual(h.decide(), label === "the lifetime changed" ? { action: "stop" } : undefined, `${label}: Pi's decision stands`);
		}
	}
});

// --------------------------------------------- R7, third look: narrower, never more (one lifetime; one setting)

const withRetention = (t: { after: (fn: () => void) => void }, value: string | undefined) => {
	const saved = process.env.PI_CACHE_RETENTION;
	t.after(() => (saved === undefined ? delete process.env.PI_CACHE_RETENTION : (process.env.PI_CACHE_RETENTION = saved)));
	if (value === undefined) delete process.env.PI_CACHE_RETENTION;
	else process.env.PI_CACHE_RETENTION = value;
};
// GPT-6.1 Sol with the values providers.dev gives it: a 30-minute conversation cache, and 12 hours with long retention.
const GPT_DATA = { short: 1800, long: 43_200 };
const systemAndUser = [{ role: "system", content: "You are pi.", timestamp: 0 }, adapterUser];

for (const windowMinutes of [120, 1440]) {
	test(`R7c/1: GPT Responses with long retention and the shared 12-hour prefix (two lifetimes) is Pi's, with a ${windowMinutes / 60} h window`, { skip: noCatalog || noWarmer }, async (t) => {
		t.after(() => mock.timers.reset());
		noNetwork(t);
		withRetention(t, "long");
		// With Pi's tools only a model whose request starts with the system prompt gets the shared prefix: gpt-5.6-cyber.
		const real = MODELS.openai["gpt-5.6-cyber"];
		const sent = await adapterPayload(real, { maxTokens: 8192, cacheRetention: "long" }, systemAndUser);
		assert.deepEqual(sent.prompt_cache_options, { ttl: "30m" }, "the conversation: 30 minutes");
		assert.equal((sent.input as { role?: string }[])[0].role, "developer", "the request starts with the system prompt");
		const runOnce = async (keepWarmMinutes: number) => {
			clock();
			fresh({ keepWarmMinutes, compactBeforeExpiry: false });
			const h = harness({ model: { ...real, cost: WITH_WRITE, promptCache: GPT_DATA }, sent, stream: viaRealAdapter(real) });
			const pi = withPiWarmer(h);
			pi.start();
			h.emit("agent_settled");
			pi.warmer.onAgentSettled();
			const decided = h.decide();
			// 13 h covers the 2-hour window and the 11 h 24 min at which a 12-hour lifetime would be refreshed.
			await pi.advance(Math.min(windowMinutes * 60_000 + HOUR, 13 * HOUR));
			const shown = await h.command("cache-keeper");
			pi.warmer.cancel();
			mock.timers.reset();
			return { pi: pi.piRefreshes, answers: pi.decisions.map((d) => d.answer), decided, attempts: h.state.attempts, shown };
		};
		const off = await runOnce(0);
		const on = await runOnce(windowMinutes);
		assert.equal(on.decided, undefined, "the handler returns nothing");
		assert.ok(on.answers.every((a) => a === undefined));
		assert.deepEqual(on.pi, off.pi, "Pi decides as with keep-warm off");
		assert.equal(on.attempts, 0, "the extension sends nothing");
		assert.match(on.shown, /left to Pi's own warming: the request carries more than one cache lifetime/);
	});
}

test("R7c/1: with the default settings (long retention) and Pi's tools, Claude on the Anthropic API, Kimi K3 on Moonshot and GPT-6.1 Sol on OpenAI are kept warm; GPT with the shared prefix (gpt-5.6-cyber) is left to Pi", { skip: noCatalog }, async (t) => {
	t.after(() => mock.timers.reset());
	noNetwork(t);
	withRetention(t, "long");
	const cases: [string, string, unknown, string | undefined][] = [
		["anthropic", "claude-sonnet-4-6", { action: "stop" }, "lifetime 60 min"],
		["moonshotai", "kimi-k3", { action: "stop" }, "lifetime 60 min"],
		// With tools first in its request, no shared prefix: the conversation's 30 minutes only.
		["openai", "gpt-6.1-sol", { action: "stop" }, "lifetime 30 min, OpenAI's minimum"],
		["openai", "gpt-5.6-cyber", undefined, undefined],
	];
	for (const [provider, id, decision, source] of cases) {
		clock();
		fresh({ compactBeforeExpiry: false });
		const real = MODELS[provider][id];
		const sent = await adapterPayload(real, { maxTokens: 8192, cacheRetention: "long" }, systemAndUser);
		const h = harness({ model: { ...real, promptCache: real.promptCache ?? (provider === "openai" ? undefined : { short: 3600, long: 3600 }) }, sent, stream: viaRealAdapter(real) });
		h.emit("agent_settled");
		assert.deepEqual(h.decide(), decision, id);
		const shown = await h.command("cache-keeper");
		if (source) assert.match(shown, new RegExp(source), id);
		else assert.match(shown, /left to Pi's own warming: the request carries more than one cache lifetime/, id);
	}
});

test("R7c/1: GPT Responses with short retention states no lifetime: owned at 30 min, refreshed before the conversation's cache expires", { skip: noCatalog }, async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	noNetwork(t);
	withRetention(t, undefined);
	fresh({ compactBeforeExpiry: false });
	const real = MODELS.openai["gpt-6.1-sol"];
	const sent = await adapterPayload(real, { maxTokens: 8192, cacheRetention: "short" }, systemAndUser);
	assert.equal(sent.prompt_cache_options, undefined, "the payload states no lifetime");
	assert.ok(!JSON.stringify(sent).includes("prompt_cache_breakpoint"), "and has no shared prefix");
	for (const promptCache of [GPT_DATA, undefined]) {
		clock();
		fresh({ compactBeforeExpiry: false });
		const h = harness({ model: { ...real, cost: WITH_WRITE, promptCache }, sent, stream: viaRealAdapter(real) });
		h.emit("agent_settled");
		assert.deepEqual(h.decide(), { action: "stop" }, "owned");
		await h.idle(1_800_000);
		await flush();
		assert.equal(h.warms[0]?.at, 1_711_000, "90 s before the 30-minute expiry at 1,801 s");
		const warm = traces().find((r) => r.event === "warm" && r.action !== "pi-stopped");
		assert.equal(warm.lifetimeSeconds, 1800);
		assert.equal(warm.lifetimeSource, promptCache ? "declared by the model" : "OpenAI's minimum");
	}
});

test("R7c/1: a payload that states its own lifetime: owned only where it matches the period's", async (t) => {
	t.after(() => mock.timers.reset());
	const cases: [string, Record<string, unknown>, { short: number; long: number }, RegExp | undefined][] = [
		["the conversation's lifetime differs from the model data", { prompt_cache_options: { ttl: "30m" } }, { short: 3600, long: 3600 }, /the request's cache lifetime does not match the model data/],
		["the conversation's lifetime matches", { prompt_cache_options: { ttl: "60m" } }, { short: 3600, long: 3600 }, undefined],
		["a part with its own lifetime", { prompt_cache_options: { ttl: "60m" }, input: [{ role: "developer", content: [{ type: "input_text", text: "s", prompt_cache_breakpoint: { mode: "explicit", ttl: "12h" } }] }, { role: "user", content: "hi" }] }, { short: 3600, long: 3600 }, /the request carries more than one cache lifetime/],
		["a lifetime the extension does not read", { prompt_cache_options: { ttl: "1d" } }, { short: 3600, long: 3600 }, /carries a cache marker the extension does not read \(prompt_cache_options/],
	];
	for (const [label, extra, promptCache, reason] of cases) {
		clock();
		fresh({ compactBeforeExpiry: false });
		const sent = { model: "o", input: [{ role: "user", content: "hi" }], max_output_tokens: 8192, ...extra };
		const h = harness({ cost: WITH_WRITE, model: { api: "openai-responses", promptCache }, sent, params: { max_output_tokens: 16 } });
		h.emit("agent_settled");
		if (reason) {
			assert.equal(h.decide(), undefined, label);
			assert.match(await h.command("cache-keeper"), reason, label);
		} else assert.deepEqual(h.decide(), { action: "stop" }, label);
	}
});

test("R7c/2: keep-warm saved off in another window before the request: the handler returns nothing, Pi refreshes as on main, the extension sends nothing", { skip: noWarmer }, async (t) => {
	t.after(() => mock.timers.reset());
	const runOnce = async (otherWindow: boolean) => {
		clock();
		fresh({ keepWarmMinutes: otherWindow ? 1440 : 0, compactBeforeExpiry: false });
		// Window A loaded its settings with keep-warm on; window B then saved it off.
		const h = harness({ lifetime: 300, cost: WITH_WRITE });
		if (otherWindow) settings({ keepWarmMinutes: 0, minContextTokens: 100_000, compactBeforeExpiry: false });
		const pi = withPiWarmer(h);
		pi.start();
		h.emit("agent_settled");
		pi.warmer.onAgentSettled();
		await pi.advance(40 * 60_000);
		pi.warmer.cancel();
		mock.timers.reset();
		return { pi: pi.piRefreshes, answers: pi.decisions.map((d) => d.answer), attempts: h.state.attempts };
	};
	const main = await runOnce(false);
	const twoWindows = await runOnce(true);
	assert.equal(twoWindows.pi[0], 271_000, "Pi refreshes at 270 s after the request");
	assert.deepEqual(twoWindows.pi, main.pi);
	assert.ok(twoWindows.answers.length > 0 && twoWindows.answers.every((a) => a === undefined));
	assert.equal(twoWindows.attempts, 0);
	assert.deepEqual(traces(), []);
});

test("R7c/2: keep-warm saved off in another window during a period it owns: warming ends there, the handler returns nothing from then on", { skip: noWarmer }, async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	fresh({ keepWarmMinutes: 1440, compactBeforeExpiry: false });
	const h = harness({ lifetime: 300, cost: WITH_WRITE });
	h.emit("agent_settled");
	assert.deepEqual(h.decide(), { action: "stop" });
	await h.idle(100_000);
	settings({ keepWarmMinutes: 0, minContextTokens: 100_000, compactBeforeExpiry: false });
	assert.equal(h.decide(), undefined, "from the next decision on");
	await h.idle(HOUR);
	assert.equal(h.state.attempts, 0);
	const stops = traces().filter((r) => r.stop);
	assert.deepEqual(stops.map((r) => [r.stop, r.reason]), [["unable", "keep-warm was turned off"]], "said once");
	// Back on: the period started while it read on, but warming ended; a period started while it read off is never owned.
	settings({ keepWarmMinutes: 1440, minContextTokens: 100_000, compactBeforeExpiry: false });
	assert.deepEqual(h.decide(), { action: "stop" }, "the period's own facts, as decided for after forget()");
	settings({ keepWarmMinutes: 0, minContextTokens: 100_000, compactBeforeExpiry: false });
	h.run(true);
	settings({ keepWarmMinutes: 1440, minContextTokens: 100_000, compactBeforeExpiry: false });
	assert.equal(h.decide(), undefined, "started while off: never owned");
	await h.idle(HOUR);
	assert.equal(h.state.attempts, 0);
});

test("R7c/2: settings that cannot be read: no refresh is sent and the handler returns nothing", async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	fresh({ compactBeforeExpiry: false });
	const h = harness({ lifetime: 300, cost: WITH_WRITE });
	h.emit("agent_settled");
	writeFileSync(join(dir, "settings.json"), "{ not json");
	assert.equal(h.decide(), undefined);
	await h.idle(HOUR);
	assert.equal(h.state.attempts, 0);
	assert.ok(traces().some((r) => r.reason === "the settings could not be read"));
});

test("R7c/3: a refresh limit must be a positive integer: -1 never leaves", async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	fresh({ compactBeforeExpiry: false });
	const h = harness({ lifetime: 300, cost: WITH_WRITE, params: { model: "rebuilt", max_tokens: -1, messages: [] } });
	h.emit("agent_settled");
	await h.idle(HOUR);
	assert.equal(h.state.attempts, 1);
	assert.equal(h.warms.length, 0);
	const stop = traces().find((r) => r.stop);
	assert.deepEqual([stop.stop, stop.budget.spent], ["unable", 0]);
	assert.match(stop.reason, /up to -1 output tokens/);
});

// --------------------------------------------- R8: the request as sent, never the setting

const FIVE_AND_HOUR = { short: 300, long: 3600 };
// Pi's real warmer beside the extension, keep-warm off and on: what Pi decided, what the handler answered, what the
// extension sent, and what /cache-keeper says.
async function besidePi(make: () => ReturnType<typeof harness>, keepWarmMinutes: number, span: number) {
	clock();
	fresh({ keepWarmMinutes, compactBeforeExpiry: false });
	const h = make();
	const pi = withPiWarmer(h);
	pi.start();
	h.emit("agent_settled");
	pi.warmer.onAgentSettled();
	const decided = h.decide();
	await pi.advance(span);
	const shown = await h.command("cache-keeper");
	pi.warmer.cancel();
	mock.timers.reset();
	return { pi: pi.piRefreshes, answers: pi.decisions.map((d) => d.answer), decided, attempts: h.state.attempts, shown };
}
async function leftToPi(make: () => ReturnType<typeof harness>, reason: RegExp, span = 2 * HOUR) {
	const off = await besidePi(make, 0, span);
	const on = await besidePi(make, 120, span);
	assert.equal(on.decided, undefined, "the handler returns nothing");
	assert.ok(on.answers.every((a) => a === undefined));
	assert.deepEqual(on.pi, off.pi, "Pi decides as with keep-warm off");
	assert.equal(on.attempts, 0, "the extension sends nothing");
	assert.match(on.shown, new RegExp(`left to Pi's own warming: ${reason.source}`));
}
// Owned, and when the first refresh goes out (the answer is at 1 s).
async function ownedRefresh(h: ReturnType<typeof harness>, within = 2 * HOUR) {
	h.emit("agent_settled");
	assert.deepEqual(h.decide(), { action: "stop" }, "owned");
	await h.idle(within);
	await flush();
	return h.warms[0]?.at;
}
const claude = () => MODELS.anthropic["claude-sonnet-4-6"];
// The reviewer's request: 1 hour on the system prompt, Anthropic's default marker (no ttl: 5 minutes) on the conversation.
async function mixedClaude() {
	const sent = await adapterPayload(claude(), { maxTokens: 8192, cacheRetention: "long" }, systemAndUser);
	const last = (sent.messages as { content: { cache_control?: Record<string, unknown> }[] }[]).at(-1)!.content.at(-1)!;
	assert.deepEqual(last.cache_control, { type: "ephemeral", ttl: "1h" });
	last.cache_control = { type: "ephemeral" };
	return sent;
}
const openRouterClaude = (control: Record<string, unknown>) => ({
	...MODELS.openrouter["anthropic/claude-sonnet-5.5"],
	api: "openai-responses",
	baseUrl: "https://openrouter.ai/api/v1",
	compat: { supportsLongCacheRetention: false },
	samplingParams: { cache_control: control },
	promptCache: FIVE_AND_HOUR,
	cost: WITH_WRITE,
});

test("R8: the reviewer's Claude request (1 h on the system prompt, the default marker on the conversation) is Pi's, whatever the answer reports", { skip: noCatalog || noWarmer }, async (t) => {
	t.after(() => mock.timers.reset());
	noNetwork(t);
	withRetention(t, "long");
	const sent = await mixedClaude();
	for (const answer of [{ cacheWrite: 120_000, cacheWrite1h: 8_000 }, {}]) {
		await leftToPi(() => harness({ model: { ...claude(), cost: WITH_WRITE }, sent, answer, stream: viaRealAdapter(claude()) }), /the request carries more than one cache lifetime/);
	}
});

test("R8: variants of mixed Claude markers are Pi's: the default on the system prompt with 1 h on the conversation; a tools marker", { skip: noCatalog || noWarmer }, async (t) => {
	t.after(() => mock.timers.reset());
	noNetwork(t);
	withRetention(t, "long");
	const flipped = await adapterPayload(claude(), { maxTokens: 8192, cacheRetention: "long" }, systemAndUser);
	(flipped.system as { cache_control?: unknown }[])[0].cache_control = { type: "ephemeral" };
	await leftToPi(() => harness({ model: { ...claude(), cost: WITH_WRITE }, sent: flipped, stream: viaRealAdapter(claude()) }), /the request carries more than one cache lifetime/);
	const tools = { ...(await adapterPayload(claude(), { maxTokens: 8192, cacheRetention: "long" }, systemAndUser)), tools: [{ name: "read", description: "d", input_schema: { type: "object" }, cache_control: { type: "ephemeral", ttl: "5m" } }] };
	await leftToPi(() => harness({ model: { ...claude(), cost: WITH_WRITE }, sent: tools, stream: viaRealAdapter(claude()) }), /the request carries more than one cache lifetime/);
});

test("R8: the reviewer's OpenRouter Claude on Responses with a top-level default marker is the 5-minute cache, refreshed before it expires; with 1 h it is the 1-hour one", { skip: noCatalog }, async (t) => {
	t.after(() => mock.timers.reset());
	noNetwork(t);
	withRetention(t, "long");
	for (const [control, at, lifetime] of [
		[{ type: "ephemeral" }, 276_000, 300],
		[{ type: "ephemeral", ttl: "5m" }, 276_000, 300],
		[{ type: "ephemeral", ttl: "1h" }, 3_421_000, 3600],
	] as const) {
		clock();
		fresh({ compactBeforeExpiry: false });
		const model = openRouterClaude(control);
		const sent = await adapterPayload(model, { maxTokens: 8192, cacheRetention: "long" }, systemAndUser);
		assert.deepEqual(sent.cache_control, control, "the adapter put the marker at the top level");
		const h = harness({ model, sent, stream: viaRealAdapter(model) });
		assert.equal(await ownedRefresh(h), at, JSON.stringify(control));
		assert.equal(h.warms.length, 1);
		assert.equal(traces().find((r) => r.event === "warm" && r.action !== "pi-stopped").lifetimeSeconds, lifetime);
	}
});

test("R8: the tier is the one the request asks for, not the setting", { skip: noCatalog }, async (t) => {
	t.after(() => mock.timers.reset());
	noNetwork(t);
	const cases: [string, string | undefined, string, number][] = [
		["setting long, default markers only", "long", "short", 276_000],
		["setting short, 1-hour markers", undefined, "long", 3_421_000],
	];
	for (const [label, setting, built, at] of cases) {
		withRetention(t, setting);
		clock();
		fresh({ compactBeforeExpiry: false });
		const sent = await adapterPayload(claude(), { maxTokens: 8192, cacheRetention: built }, systemAndUser);
		const h = harness({ model: { ...claude(), cost: WITH_WRITE, promptCache: FIVE_AND_HOUR }, sent, stream: viaRealAdapter(claude()) });
		assert.equal(await ownedRefresh(h), at, label);
	}
	// No marker at all, model data for both tiers, the setting long: the default cache.
	withRetention(t, "long");
	clock();
	fresh({ compactBeforeExpiry: false });
	const plain = harness({ lifetime: 300, cost: WITH_WRITE, model: { promptCache: FIVE_AND_HOUR } });
	assert.equal(await ownedRefresh(plain), 276_000, "no marker: short");
});

test("R8: an answer that reports cache writes in both buckets, or a bucket whose lifetime is not the request's, is Pi's", async (t) => {
	t.after(() => mock.timers.reset());
	withRetention(t, "long");
	const oneHour = { model: "claude", max_tokens: 64_000, system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", ttl: "1h" } }], messages: [{ role: "user", content: "hi" }], thinking: { type: "adaptive" } };
	const cases: [string, Record<string, unknown> | undefined, Record<string, number>, RegExp][] = [
		["both tiers", oneHour, { cacheWrite: 120_000, cacheWrite1h: 8_000 }, /the answer reports cache writes in both tiers/],
		["the 5-minute bucket for a 1-hour request", oneHour, { cacheWrite: 120_000, cacheWrite1h: 0 }, /an answer of this model reports a 5 min cache write; the request's cache lasts 60 min as it states/],
		["the 1-hour bucket for a request with no marker", undefined, { cacheWrite: 120_000, cacheWrite1h: 120_000 }, /an answer of this model reports a 60 min cache write; the request's cache lasts 5 min by the route's data/],
	];
	for (const [label, sent, answer, reason] of cases) {
		clock();
		fresh({ compactBeforeExpiry: false });
		const h = harness({ cost: WITH_WRITE, model: { promptCache: FIVE_AND_HOUR }, sent, answer });
		h.emit("agent_settled");
		assert.equal(h.decide(), undefined, label);
		assert.match(await h.command("cache-keeper"), reason, label);
		await h.idle(2 * HOUR);
		assert.equal(h.state.attempts, 0, label);
	}
	// The same tier reported: owned.
	clock();
	fresh({ compactBeforeExpiry: false });
	const same = harness({ cost: WITH_WRITE, model: { promptCache: FIVE_AND_HOUR }, sent: oneHour, answer: { cacheWrite: 120_000, cacheWrite1h: 120_000 } });
	assert.equal(await ownedRefresh(same), 3_421_000);
});

test("R8: without declared data, the tier the answer reports gives the lifetime; owned when the request asked for that tier", async (t) => {
	t.after(() => mock.timers.reset());
	withRetention(t, "long");
	const marked = (control: Record<string, unknown>) => ({ model: "claude", max_tokens: 64_000, system: [{ type: "text", text: "s", cache_control: control }], messages: [{ role: "user", content: "hi" }], thinking: { type: "adaptive" } });
	for (const [control, answer, at] of [
		[{ type: "ephemeral", ttl: "1h" }, { cacheWrite: 120_000, cacheWrite1h: 120_000 }, 3_421_000],
		[{ type: "ephemeral" }, { cacheWrite: 120_000, cacheWrite1h: 0 }, 276_000],
	] as const) {
		clock();
		fresh({ compactBeforeExpiry: false });
		const h = harness({ cost: WITH_WRITE, model: { provider: "gateway", promptCache: undefined }, sent: marked(control), answer });
		assert.equal(await ownedRefresh(h), at);
		assert.equal(traces().find((r) => r.event === "warm" && r.action !== "pi-stopped").lifetimeSource, "reported by the provider");
	}
	clock();
	fresh({ compactBeforeExpiry: false });
	const other = harness({ cost: WITH_WRITE, model: { provider: "gateway", promptCache: undefined }, sent: marked({ type: "ephemeral" }), answer: { cacheWrite: 120_000, cacheWrite1h: 120_000 } });
	other.emit("agent_settled");
	assert.equal(other.decide(), undefined, "a 5-minute request whose answer reports 1-hour writes");
});

test("R8: a lifetime assumed for a model family is owned only on the provider's own API", { skip: noCatalog }, async (t) => {
	t.after(() => mock.timers.reset());
	noNetwork(t);
	withRetention(t, undefined);
	const real = MODELS.openai["gpt-6.1-sol"];
	for (const baseUrl of ["https://gateway.example/v1", real.baseUrl]) {
		clock();
		fresh({ compactBeforeExpiry: false });
		const model = { ...real, baseUrl, promptCache: undefined, cost: WITH_WRITE };
		const sent = await adapterPayload(model, { maxTokens: 8192, cacheRetention: "short" }, systemAndUser);
		const h = harness({ model, sent, stream: viaRealAdapter(model) });
		if (baseUrl === real.baseUrl) {
			assert.equal(await ownedRefresh(h), 1_711_000);
			continue;
		}
		h.emit("agent_settled");
		assert.equal(h.decide(), undefined);
		assert.match(await h.command("cache-keeper"), /the cache lifetime \(OpenAI's minimum\) is only assumed on the provider's own API, not at https:\/\/gateway\.example\/v1/);
		await h.idle(HOUR);
		assert.equal(h.state.attempts, 0);
	}
});

test("a period left to Pi reads its cache as with keep-warm off: GPT-6.1 Sol asking for 12 hours is not compacted at 29m40s, with or without tools", { skip: noCatalog }, async (t) => {
	t.after(() => mock.timers.reset());
	noNetwork(t);
	withRetention(t, "long");
	// The reviewer's request: a model option asks for 12 hours on the conversation; providers.dev's 30 min and 12 h.
	const model = { ...MODELS.openai["gpt-6.1-sol"], samplingParams: { prompt_cache_options: { ttl: "12h" } }, promptCache: GPT_DATA, cost: WITH_WRITE };
	for (const tools of [[], piTools]) {
		const sent = await adapterPayload(model, { maxTokens: 8192, cacheRetention: "long" }, systemAndUser, tools);
		assert.deepEqual(sent.prompt_cache_options, { ttl: "12h" });
		const runOnce = async (keepWarmMinutes: number, ms: number) => {
			clock();
			fresh({ keepWarmMinutes, compactBeforeExpiry: true, minContextTokens: 140_000 });
			const h = harness({ model, sent, cached: 180_000, stream: viaRealAdapter(model) });
			h.emit("agent_settled");
			const decided = h.decide();
			await h.idle(ms);
			const shown = (await h.command("cache-keeper")).split("\n").find((l) => l.startsWith("cache:"));
			return { decided, compacts: h.state.compacts, compactedAt: h.state.compactedAt, attempts: h.state.attempts, traces: allTraces(), shown };
		};
		const label = tools.length ? "with tools" : "as the reviewer built it, without tools";
		const on = await runOnce(120, 35 * 60_000);
		const off = await runOnce(0, 35 * 60_000);
		assert.equal(on.decided, undefined, label);
		assert.match(on.shown ?? "", /lifetime 720 min/, `${label}: the countdown follows 12 hours`);
		assert.deepEqual([on.compacts, on.attempts], [0, 0], `${label}: no summary at 29m40s, nothing sent`);
		assert.deepEqual(on, off, `${label}: the same as with keep-warm off`);
		// To the end of the 12 hours: the same compaction, at the same time.
		const onLong = await runOnce(120, 12 * HOUR);
		const offLong = await runOnce(0, 12 * HOUR);
		assert.equal(onLong.compacts, 1, label);
		assert.deepEqual(onLong, offLong, `${label}: compacted 20 s before the 12 hours, as with keep-warm off`);
		mock.timers.reset();
	}
});

test("owned or left alone: where one refresh costs as much as the miss it avoids, the period is Pi's from its start", { skip: noWarmer }, async (t) => {
	t.after(() => mock.timers.reset());
	// A cached read priced like an uncached one, no cache-write price: a miss costs nothing more than a refresh.
	const flat = { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 };
	await leftToPi(() => harness({ lifetime: 300, cost: flat }), /at this model's prices a refresh costs as much as a miss/);
	// A real discount: owned, and the refresh goes out.
	clock();
	fresh({ compactBeforeExpiry: false });
	assert.equal(await ownedRefresh(harness({ lifetime: 300, cost: WITH_WRITE })), 276_000);
});

test("the reason for thinking names what the request carries, for any provider: DeepSeek on Chat Completions with thinking on", { skip: noCatalog }, async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	noNetwork(t);
	fresh({ compactBeforeExpiry: false });
	const real = MODELS.deepseek["deepseek-v4-pro"];
	const sent = await adapterPayload(real, { maxTokens: 8192, reasoning: "high" }, systemAndUser);
	assert.equal((sent.thinking as { type?: string } | undefined)?.type, "enabled", "the real adapter turns thinking on");
	const h = harness({ model: { ...real, cost: WITH_WRITE }, sent, stream: viaRealAdapter(real) });
	h.emit("agent_settled");
	assert.equal(h.decide(), undefined);
	const shown = await h.command("cache-keeper");
	assert.match(shown, /left to Pi's own warming: the request turns thinking on \(thinking: \{ type: "enabled" \}\), which a refresh capped at one output token cannot re-send as it was/);
	assert.doesNotMatch(shown, /Claude/);
});

// --------------------------------------------- R9: two misses in a row, then Pi, with a warning and a way back

const MODEL_KEY = "cliproxyapi/sub/claude";
// Half the prompt read from the cache: a miss that stays within the budget, so it ends the period as "missed".
const HALF_MISS = { usage: { input: 0, cacheRead: 300_000, cacheWrite: 300_000 } };
const misses = () => (globalThis as Record<symbol, { counts: Map<string, number>; fallback: Map<string, number>; inFlight: Map<string, Map<number, number>> } | undefined>)[Symbol.for("pi-cache-keeper.warm-misses")];
const countOf = (model = MODEL_KEY) => misses()?.counts.get(model) ?? 0;
const warningFor = (kinds: string) => `Two refreshes in a row without a hit for ${MODEL_KEY} (${kinds}), so pi-cache-keeper stopped keeping it warm; Pi's own warming takes over. /cache-keeper-warm starts it again.`;
const WARNING = warningFor("both missed the cache");
const FALLBACK_STATUS = "⚠ keep-warm: Pi's after 2 refreshes without a hit (/cache-keeper-warm)";
const fallbackLineAt = (at: number, model = MODEL_KEY, kinds = "both missed the cache") =>
	`two refreshes in a row without a hit for ${model} (the last at ${new Date(at).toTimeString().slice(0, 5)}): ${kinds}, so it is left to Pi's own warming; /cache-keeper-warm starts keeping it warm again`;
const keepWarmLineOf = async (h: ReturnType<typeof harness>) => (await h.command("cache-keeper")).split("\n").find((l) => l.startsWith("keep warm:"));
const RULE = "keep warm: up to 2 h after Pi goes idle; stops once refreshing has cost as much as one cache miss";
// One idle period: Pi goes idle after a real answer, the extension decides, the refresh is due 25 s before expiry.
async function nextPeriod(h: ReturnType<typeof harness>, first = false) {
	if (!first) {
		mock.timers.tick(1000);
		h.run(true);
	} else h.emit("agent_settled");
	const decided = h.decide();
	const before = h.warms.length;
	await h.idle(300_000);
	await flush();
	return { decided, refreshed: h.warms.length - before };
}

test("R9: one miss ends only its period; the next period is owned and refreshes, and a hit sets the count back to zero", async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	fresh({ compactBeforeExpiry: false });
	const h = harness({ lifetime: 300, cost: WITH_WRITE, ui: true, respond: (n) => (n === 1 ? HALF_MISS : {}) });
	assert.deepEqual(await nextPeriod(h, true), { decided: { action: "stop" }, refreshed: 1 });
	assert.deepEqual(traces().filter((r) => r.stop).map((r) => [r.action, r.stop]), [["missed", "missed"]]);
	assert.equal(countOf(), 1);
	assert.ok(h.notes.includes("Keeping the cache warm read only 50% from the cache, so it wrote the context again. Stopped until your next message."));
	assert.deepEqual(await nextPeriod(h), { decided: { action: "stop" }, refreshed: 1 }, "the next period is owned and refreshes");
	assert.equal(countOf(), 0, "a hit sets it back to zero");
	assert.ok(!h.notes.includes(WARNING));
});

test("R9: miss, hit, miss: still owned", async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	fresh({ compactBeforeExpiry: false });
	const h = harness({ lifetime: 300, cost: WITH_WRITE, ui: true, respond: (n) => (n === 2 ? {} : HALF_MISS) });
	await nextPeriod(h, true);
	await nextPeriod(h);
	await nextPeriod(h);
	assert.equal(countOf(), 1);
	assert.ok(!h.notes.includes(WARNING));
	mock.timers.tick(1000);
	h.run(true);
	assert.deepEqual(h.decide(), { action: "stop" }, "owned after miss, hit, miss");
});

test("R9: two misses in a row: left to Pi from the next period's start, warned once, shown in the footer and /cache-keeper, logged once; another model is unaffected; /cache-keeper-warm starts it again", async (t) => {
	online(t);
	clock();
	t.after(() => mock.timers.reset());
	fresh({ compactBeforeExpiry: false });
	const h = harness({ lifetime: 300, cost: WITH_WRITE, ui: true, respond: () => HALF_MISS });
	// Every notification, also those a command's output would clear from the harness's notes.
	const said: string[] = [];
	const notify = h.ctx.ui.notify;
	h.ctx.ui.notify = (text: string) => (said.push(text), notify(text));
	await nextPeriod(h, true);
	assert.equal(countOf(), 1);
	assert.deepEqual(await nextPeriod(h), { decided: { action: "stop" }, refreshed: 1 }, "one miss: the next period is still owned");
	const secondAt = h.warms[1].at;
	const line = fallbackLineAt(secondAt);
	assert.equal(said.filter((n) => n === WARNING).length, 1, "the warning");
	assert.deepEqual(traces().filter((r) => r.leftToPi).map((r) => [r.action, r.stop, r.leftToPi]), [["missed", "missed", line]], "logged once");
	// From that moment the period reads as left to Pi (the decision handler returns nothing).
	assert.equal(await keepWarmLineOf(h), `${RULE}; ${line}`);
	assert.equal(h.decide(), undefined, "the period of the second miss: Pi's from then on");
	// The next period: Pi's from its start.
	const third = await nextPeriod(h);
	assert.deepEqual(third, { decided: undefined, refreshed: 0 }, "the handler returns nothing, nothing is sent");
	assert.equal(await keepWarmLineOf(h), `${RULE}; ${line}`);
	// The footer says it right after the countdown, also once the cache has gone cold and no countdown runs.
	assert.ok(h.statuses.some((s) => s.text?.startsWith(`cache warm · 4m left · ${FALLBACK_STATUS} · `)), "the footer, with the countdown");
	assert.equal(h.statuses.at(-1)?.text, `cache cold · next message full price · ${FALLBACK_STATUS} · short 5m (in use) · long 5m · sent default cache · api $3/$15 per M`, "and without one");
	assert.ok((await h.command("cache-keeper-settings")).includes(line), "the settings line");
	assert.deepEqual(await nextPeriod(h), { decided: undefined, refreshed: 0 }, "and the next");
	assert.equal(said.filter((n) => n === WARNING).length, 1, "warned once");
	assert.equal(traces().filter((r) => r.leftToPi).length, 1);
	// Another model in the same process: unaffected.
	h.ctx.model = { ...h.model, id: "sub/other" };
	assert.deepEqual((await nextPeriod(h)).decided, { action: "stop" }, "another model");
	assert.equal(await keepWarmLineOf(h).then((l) => l?.includes("two refreshes in a row")), false);
	h.ctx.model = h.model;
	// /cache-keeper-warm: cleared for every model; nothing sent, nothing else changed.
	const attempts = h.state.attempts;
	assert.equal(
		await h.command("cache-keeper-warm"),
		`pi-cache-keeper keeps ${MODEL_KEY} warm again, at the latest from your next message: an idle period already running whose own warming had not ended is kept warm again at once. The count of refreshes without a hit of cliproxyapi/sub/other is cleared too.`,
	);
	assert.equal(h.state.attempts, attempts, "the command sends nothing");
	assert.deepEqual([misses()?.fallback.size, misses()?.counts.size], [0, 0]);
	assert.ok(!h.statuses.at(-1)?.text?.includes(FALLBACK_STATUS), "the footer no longer says it");
	assert.deepEqual((await nextPeriod(h)).decided, { action: "stop" }, "owned again from the next period");
	assert.equal(countOf(), 1, "counted from zero: one miss");
	assert.deepEqual((await nextPeriod(h)).decided, { action: "stop" }, "still owned after one miss");
	assert.equal(await h.command("cache-keeper-warm"), `pi-cache-keeper keeps ${MODEL_KEY} warm again, at the latest from your next message: an idle period already running whose own warming had not ended is kept warm again at once.`);
	assert.equal(await h.command("cache-keeper-warm"), "Nothing to clear: no model was left to Pi's own warming, and no refresh was counted without a hit.");
	settings({ keepWarmMinutes: 0, minContextTokens: 100_000, compactBeforeExpiry: false });
	assert.equal(
		await h.command("cache-keeper-warm"),
		"Nothing to clear: no model was left to Pi's own warming, and no refresh was counted without a hit. Keep-warm itself is off (keepWarmMinutes: 0); /cache-keeper-settings turns it on.",
		"it does not turn keep-warm on",
	);
	assert.equal(readSettings().cacheKeeper.keepWarmMinutes, 0);
});

test("/cache-keeper-warm takes effect at the latest from the next message: a period already running whose warming had not ended is kept warm again at once", async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	fresh({ compactBeforeExpiry: false });
	// Another session's period, on the same model at the 1-hour cache, owned and not ended.
	const running = harness({ lifetime: 3600, cost: WITH_WRITE, model: NO_BREAKDOWN });
	running.emit("agent_settled");
	assert.deepEqual(running.decide(), { action: "stop" });
	// This session's two misses in a row leave the model to Pi: the running period too.
	const missing = harness({ lifetime: 300, cost: WITH_WRITE, respond: () => HALF_MISS });
	await nextPeriod(missing, true);
	await nextPeriod(missing);
	assert.equal(running.decide(), undefined, "left to Pi");
	await missing.command("cache-keeper-warm");
	assert.deepEqual(running.decide(), { action: "stop" }, "kept warm again at once");
	await running.idle(3_000_000);
	await flush();
	assert.equal(running.warms.length, 1, "and refreshed before its cache expires");
});

test("R9: the count is of refreshes in a row without a hit: unreported ones count as misses do; a hit resets; one cancelled before it reported does not count", async (t) => {
	t.after(() => mock.timers.reset());
	const UNREPORTED = { usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 } };
	const run = async (label: string, respond: (n: number) => Record<string, unknown>, periods: number, options: Partial<Options> = {}) => {
		clock();
		fresh({ compactBeforeExpiry: false });
		const h = harness({ lifetime: 300, cost: WITH_WRITE, ui: true, respond: respond as never, ...options });
		const said: string[] = [];
		const notify = h.ctx.ui.notify;
		h.ctx.ui.notify = (text: string) => (said.push(text), notify(text));
		for (let i = 0; i < periods; i++) await nextPeriod(h, i === 0);
		mock.timers.tick(1000);
		h.run(true);
		await flush();
		return { h, said, decided: h.decide(), line: await keepWarmLineOf(h) };
	};
	// Unreported, unreported: left to Pi, warned once.
	let r = await run("unreported twice", () => UNREPORTED, 2);
	assert.equal(r.decided, undefined, "left to Pi");
	assert.equal(r.said.filter((n) => n === warningFor("neither reported what it cost")).length, 1, "warned once");
	assert.match(r.line ?? "", /two refreshes in a row without a hit for cliproxyapi\/sub\/claude \(the last at \d\d:\d\d\): neither reported what it cost, so it is left to Pi's own warming; \/cache-keeper-warm starts keeping it warm again$/);
	assert.deepEqual(traces().filter((x) => x.leftToPi).map((x) => [x.action, x.stop]), [["warm", "unknown"]], "logged once");
	// Unreported, hit, unreported: still owned.
	r = await run("unreported, hit, unreported", (n) => (n === 2 ? {} : UNREPORTED), 3);
	assert.deepEqual(r.decided, { action: "stop" }, "still owned");
	assert.equal(countOf(), 1);
	// Miss, unreported: left to Pi, and said what the two were.
	r = await run("miss, unreported", (n) => (n === 1 ? HALF_MISS : UNREPORTED), 2);
	assert.equal(r.decided, undefined);
	assert.equal(r.said.filter((n) => n === warningFor("one missed the cache, one did not report what it cost")).length, 1);
	// Cancelled before it reported usage, twice (the user's next message): not counted, still owned.
	clock();
	fresh({ compactBeforeExpiry: false });
	const h = harness({ lifetime: 300, cost: WITH_WRITE, hold: () => true });
	h.state.abortReports = false;
	await nextPeriod(h, true);
	await nextPeriod(h);
	await nextPeriod(h);
	assert.equal(h.warms.length, 3, "three went out, two of them cancelled by the next message");
	assert.equal(traces().filter((x) => x.action === "cancelled").length, 2);
	assert.equal(countOf(), 0, "not counted");
	assert.deepEqual(h.decide(), { action: "stop" }, "still owned");
});

test("the period's rule: while its refresh is out nothing else leaves, also after Pi's own refresh moved the expiry, a run that sent nothing cancelled it, and the 10-minute hold released (the reviewer's second sequence)", async (t) => {
	t.after(() => mock.timers.reset());
	clock();
	fresh({ compactBeforeExpiry: false });
	// GPT-like 30-minute cache; the refresh's transport does not pass a cancellation on, so it never settles.
	const h = harness({ lifetime: 1800, cost: WITH_WRITE, hold: () => true, model: NO_BREAKDOWN });
	h.state.ignoresAbort = true;
	h.emit("agent_settled");
	for (let s = 0; s < 1800 && h.warms.length === 0; s += 10) await h.idle(10_000);
	assert.equal(h.warms.length, 1, "the period's refresh went out");
	const sentAt = h.warms[0].at;
	// Pi's own refresh from the run before lands: the expiry moves 30 minutes on.
	mock.timers.tick(30_000);
	h.ctx.sessionManager.appendUsage("cache_warm", h.model.provider, h.model.id, h.usage());
	// A run that sends nothing cancels the refresh; the transport keeps it open.
	mock.timers.tick(10_000);
	h.run(false);
	await flush();
	// Past the 10-minute release of the model's hold and past the moved expiry's refresh time.
	await h.idle(2 * HOUR);
	assert.deepEqual(h.warms.map((w) => w.at), [sentAt], "one request in the period: it is out until it settles");
	assert.deepEqual(h.decide(), { action: "stop" }, "the period is still the extension's");
	// It settles at last, having reported a hit: waiting again, and the next one goes out.
	h.release();
	await flush();
	assert.equal(traces().filter((r) => r.action === "warm" || r.action === "cancelled").length, 1);
});

test("the period's rule: a refresh that fails before it leaves ends warming (\"failed\") with its notice once; nothing was sent, so nothing is spent or counted", async (t) => {
	t.after(() => mock.timers.reset());
	clock();
	fresh({ compactBeforeExpiry: false });
	// The adapter fails before it builds the payload (credentials, say): onPayload never runs.
	const h = harness({ ui: true, lifetime: 300, cost: WITH_WRITE, stream: () => ({ result: () => Promise.resolve({ stopReason: "error", errorMessage: "no API key for cliproxyapi", usage: h.usage({ input: 0, output: 0, cacheRead: 0 }) }) }) });
	h.emit("agent_settled");
	await h.idle(HOUR);
	assert.equal(h.state.attempts, 1, "tried once, not again");
	assert.equal(h.warms.length, 0, "nothing sent");
	const records = traces().filter((r) => r.event === "warm" && r.stop);
	assert.deepEqual(records.map((r) => [r.action, r.stop, r.reason]), [["failed", "failed", "no API key for cliproxyapi"]]);
	assert.equal(records[0].budget.spent, 0, "nothing spent");
	assert.equal(countOf(), 0, "nothing counted toward two in a row");
	assert.deepEqual(h.notes.filter((n) => n.includes("could not keep the cache warm")), ["pi-cache-keeper could not keep the cache warm: no API key for cliproxyapi"]);
});

// ------------------------------------------------------------------------------- the owned period's one expiry

// The reviewer's 1c: a preparation that takes 7 s (a credential lookup). The hit counts from when the refresh left, not
// from when its preparation started: the cache is warm to 1,958 s, past the window's end at 1,955 s, so no seventh
// refresh goes out (counted from the start of preparation, 1,951 s, one more went out at 1,926 s).
test("the owned period's expiry: a hit counts from when its refresh passed the last gate, not from the start of a slow preparation", async (t) => {
	t.after(() => mock.timers.reset());
	clock();
	fresh({ keepWarmMinutes: 30, compactBeforeExpiry: false });
	const h = harness({ lifetime: 300, cost: WITH_WRITE });
	h.state.beforePayload = () => {
		if (h.state.attempts === 6) mock.timers.tick(7_000);
	};
	// Pi goes idle at 155 s, so the window ends at 1,955 s.
	mock.timers.tick(154_000);
	h.emit("agent_settled");
	await h.idle(HOUR);
	assert.deepEqual(
		h.warms.map((w) => w.at / 1000),
		[276, 551, 826, 1101, 1376, 1658],
		"the sixth left at 1,658 s after a 7-s preparation; no seventh",
	);
	assert.equal(traces().find((r) => r.stop)?.stop, "limit");
});

// The reviewer's 1d: the period before's refresh, cancelled by a real answer, settles late with its hit, after the new
// period's own hit. It moves nothing in the new period: the new period's refresh due at 1,200 s goes out.
test("the owned period's expiry: a late settlement of the period before's refresh moves nothing in the new period", async (t) => {
	t.after(() => mock.timers.reset());
	clock();
	fresh({ compactBeforeExpiry: false });
	const h = harness({ lifetime: 300, cost: WITH_WRITE, hold: (n) => n === 1 });
	h.state.ignoresAbort = true;
	h.emit("agent_settled");
	await h.idle(649_000);
	assert.deepEqual(h.warms.map((w) => w.at / 1000), [276]);
	// A real answer at 650 s: a new period; the first refresh's stream stays open (the transport ignores the cancellation).
	h.run(true);
	await h.idle(331_000);
	// Held for the model until 10 minutes after the first left (876 s), then sent at 925 s with a hit.
	assert.deepEqual(h.warms.map((w) => w.at / 1000), [276, 925]);
	// At 981 s the old stream settles with its hit from 276 s.
	h.release();
	await flush();
	await h.idle(400_000);
	assert.deepEqual(h.warms.map((w) => w.at / 1000).slice(0, 3), [276, 925, 1200], "the refresh due 25 s before 1,225 s goes out");
});

// The reviewer's 1e: Pi's own refresh entry recorded at 1,850 s (the receipt of a request sent earlier) after the
// extension's refresh at 1,711 s: the next refresh counts from 1,711 s and goes out before the cache expires at 3,511 s.
test("the owned period's expiry: Pi's refresh entries, or when they were recorded, move nothing", async (t) => {
	t.after(() => mock.timers.reset());
	clock();
	fresh({ compactBeforeExpiry: false });
	const h = harness({ lifetime: 1800, cost: WITH_WRITE, model: NO_BREAKDOWN });
	h.emit("agent_settled");
	await h.idle(1_800_000);
	assert.deepEqual(h.warms.map((w) => w.at / 1000), [1711]);
	mock.timers.tick(49_000);
	h.ctx.sessionManager.appendUsage("cache_warm", h.model.provider, h.model.id, h.usage());
	await h.idle(1_800_000);
	assert.deepEqual(h.warms.map((w) => w.at / 1000).slice(0, 2), [1711, 3421], "90 s before 3,511 s (counted from Pi's entry: 3,560 s, after the cache expired)");
});

// A gateway (the harness's cliproxyapi/sub/claude) whose model comes from a Claude login, with the API key's facts
// beside it: the key route's short cache lasts `keyShort` seconds.
const gateway = (t: { after: (fn: () => void) => void }, keyShort: number) => {
	const path = join(dir, "cache-keeper-models.json");
	writeFileSync(
		path,
		JSON.stringify({
			version: 1,
			providers: { "claude-subscription": { "claude-sonnet-5-5": { short: 3600, long: 3600 } }, anthropic: { "claude-sonnet-5-5": { short: keyShort, long: 3600 } } },
			upstreams: { cliproxyapi: { "sub/claude": { upstreams: [{ provider: "claude-subscription", model: "claude-sonnet-5-5", subscription: true }] } } },
			written: {},
		}),
	);
	t.after(() => rmSync(path, { force: true }));
	// What the proxy says once a request was served by the API key.
	return (h: ReturnType<typeof harness>) => h.signal("model-upstreams:answered", { provider: "cliproxyapi", model: "sub/claude", upstreams: [{ provider: "anthropic", model: "claude-sonnet-5-5", subscription: false }] });
};

// The reviewer's first sequence: the period started on the login's hour; at 400 s an answer shows the API key's
// 5-minute route served the request. The lifetime read now is shorter: warming ends ("unable"), and every reader counts
// with the 5 minutes from then on, which have passed: the footer reads cold and no summary is sent at 3,580 s.
test("the owned period never counts a longer lifetime than the one read now: a route change reported by an answer", async (t) => {
	t.after(() => mock.timers.reset());
	online(t);
	clock();
	fresh();
	const keyRoute = gateway(t, 300);
	const h = harness({ lifetime: 3600, cost: WITH_WRITE, ui: true, sent: plainMarker, answer: CONFIRMING_HOUR });
	h.emit("agent_settled");
	await h.idle(399_000);
	assert.match(lastFooter(h) ?? "", /^cache warm · 53m left/);
	keyRoute(h);
	await h.idle(15_000);
	assert.match(lastFooter(h) ?? "", /^cache cold/, "cold from then");
	assert.match(await h.command("cache-keeper"), /cache: expired \(lifetime 5 min/);
	await h.idle(HOUR);
	assert.equal(h.state.compacts, 0, "no summary after the shorter lifetime passed");
	assert.deepEqual(h.warms, []);
	assert.match(traces().find((r) => r.stop)?.reason ?? "", /^the request's cache now lasts 5 min by the route's data, the cached request was written with 60 min$/);
});

// The reviewer's second sequence: Pi's own refresh during a long run comes back after the period started, through the
// API key's route (2.5 minutes). The period's 10-minute expiry counts with 2.5 minutes from then: long passed.
test("the owned period never counts a longer lifetime than the one read now: a route change reported by Pi's in-run refresh", { skip: noWarmer }, async (t) => {
	t.after(() => mock.timers.reset());
	online(t);
	clock();
	fresh();
	const keyRoute = gateway(t, 150);
	const h = harness({ lifetime: 600, cost: WITH_WRITE, ui: true, model: NO_BREAKDOWN });
	// The answer's request at 1 s; the answer streams until 545 s, and Pi's warmer refreshes the request at 541 s.
	h.state.idle = false;
	h.emit("agent_start");
	const piSent: number[] = [];
	let landed: (() => void) | undefined;
	const answer = () => ({ stopReason: "stop", provider: h.model.provider, model: h.model.id, usage: h.usage() });
	const warmer = new CacheWarmer(
		{
			streamSimple: () => {
				piSent.push(Date.now());
				return { result: () => new Promise((resolve) => (landed = () => resolve(answer()))) };
			},
		},
		h.ctx.sessionManager,
		() => "idle",
		async (event: { action: string }) => (h.emit("cache_warming_decision", event) as { action?: string } | undefined)?.action ?? event.action,
	);
	t.after(() => warmer.cancel());
	warmer.start({ model: h.model, context: { messages: [] }, options: {} }, () => true);
	for (let s = 0; s < 544; s++) {
		mock.timers.tick(1000);
		await flush();
	}
	assert.deepEqual(piSent, [541_000]);
	h.state.idle = true;
	h.emit("agent_settled");
	warmer.onAgentSettled();
	assert.match(lastFooter(h) ?? "", /^cache warm · 0:56 left/, "owned, on the login's 10 minutes");
	await h.idle(3_000);
	// Pi's refresh lands; the proxy says the API key served it.
	landed?.();
	keyRoute(h);
	await flush();
	await h.idle(15_000);
	assert.match(lastFooter(h) ?? "", /^cache cold/);
	await h.idle(HOUR);
	assert.equal(h.state.compacts, 0, "no summary after the shorter lifetime passed");
	assert.deepEqual(h.warms, []);
	assert.equal(traces().find((r) => r.stop)?.stop, "unable");
});

test("the owned period never counts a longer lifetime than the one read now: where none can be read any more, it counts as expired (no automatic summary)", async (t) => {
	t.after(() => mock.timers.reset());
	clock();
	fresh();
	const h = harness({ lifetime: 3600, cost: WITH_WRITE, ui: true, model: NO_BREAKDOWN });
	h.emit("agent_settled");
	await h.idle(100_000);
	// The model's lifetime is gone (its data changed): nothing to count with.
	delete (h.model as { promptCache?: unknown }).promptCache;
	await h.idle(HOUR);
	assert.equal(h.state.compacts, 0);
	assert.deepEqual(h.warms, []);
	assert.match(traces().find((r) => r.stop)?.reason ?? "", /^the request's cache now lasts an unknown time, the cached request was written with 60 min$/);
	assert.match(await h.command("cache-keeper"), /cache: lifetime unknown, so no countdown/);
	assert.match(lastFooter(h) ?? "", /^cache cold/, "counted as expired");
});

// Compacting before expiry has a last gate. Pi's compaction is stood in for: the extension's session_before_compact
// handler is called as Pi calls it, and the summary's transport looks the credentials up (taking `lookupMs`) before it
// builds the payload.
// ------------------------------------------------------------------- a marker that states no lifetime: the route's

// A proxy that serves a Claude subscription login (the harness's cliproxyapi/sub/claude), whose data gives both tiers an
// hour: with `cacheRetention: "short"` Pi sends Anthropic's plain marker, which states no lifetime.
const plainMarker = { model: "claude", max_tokens: 64_000, system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: "hi" }], thinking: { type: "adaptive" } };
const HOUR_WRITE = { cacheWrite: 120_000, cacheWrite1h: 120_000 };
const FIVE_MINUTE_WRITE = { cacheWrite: 120_000, cacheWrite1h: 0 };

test("route lifetimes: a plain marker on a route whose data gives the short tier an hour, the answer reporting a 1-hour write: owned at one hour, refreshed at 57 minutes, within the budget", async (t) => {
	t.after(() => mock.timers.reset());
	withRetention(t, undefined);
	clock();
	fresh({ compactBeforeExpiry: false });
	const h = harness({ lifetime: 3600, sent: plainMarker, answer: HOUR_WRITE });
	assert.equal(await ownedRefresh(h, HOUR), 3_421_000, "57 min after the answer at 1 s");
	assert.equal(h.warms.length, 1);
	const refresh = traces().find((r) => r.event === "warm" && r.action === "warm");
	assert.equal(refresh.lifetimeSeconds, 3600);
	assert.deepEqual(refresh.budget, { unit: "refreshes", spent: 1, limit: 10 }, "a subscription: the first of at most 10 refreshes");
	assert.equal(refresh.stop, undefined, "warming goes on");
});

test("route lifetimes: the same request whose answer reports the 5-minute write (the proxy fell back to an API key): owned at 5 minutes by the served route's data, or Pi's; never at an hour", async (t) => {
	t.after(() => mock.timers.reset());
	withRetention(t, undefined);
	// The proxy said the API key served it: that route's data (5 minutes short) holds, and the 5-minute write agrees.
	clock();
	fresh({ compactBeforeExpiry: false });
	const keyRoute = gateway(t, 300);
	const served = harness({ lifetime: 3600, sent: plainMarker, answer: FIVE_MINUTE_WRITE });
	keyRoute(served);
	assert.equal(await ownedRefresh(served, HOUR), 276_000, "25 s before the 5-minute expiry");
	assert.equal(traces().find((r) => r.event === "warm" && r.action === "warm").lifetimeSeconds, 300);
	// Nobody said so: the data gives the short tier an hour, the answer says five minutes. They disagree: Pi's.
	clock();
	fresh({ compactBeforeExpiry: false });
	const unsaid = harness({ lifetime: 3600, sent: plainMarker, answer: FIVE_MINUTE_WRITE });
	unsaid.emit("agent_settled");
	assert.equal(unsaid.decide(), undefined, "not owned");
	assert.match(await unsaid.command("cache-keeper"), /left to Pi's own warming: an answer of this model reports a 5 min cache write; the request's cache lasts 60 min by the route's data/);
	await unsaid.idle(2 * HOUR);
	assert.equal(unsaid.state.attempts, 0, "the extension sends nothing");
});

test("route lifetimes: only the period's own answer confirms a route's lifetime: an answer that only read is Pi's, also after an earlier 1-hour write of the same model", async (t) => {
	t.after(() => mock.timers.reset());
	withRetention(t, undefined);
	clock();
	fresh({ compactBeforeExpiry: false });
	const h = harness({ lifetime: 3600, sent: plainMarker });
	h.emit("agent_settled");
	assert.equal(h.decide(), undefined, "an answer that only read the cache, nothing reported before it");
	assert.match(
		await h.command("cache-keeper"),
		/left to Pi's own warming: the request states no cache lifetime \(system\[0\]\.cache_control\), and the route's lifetime for its tier \(60 min\) is not the 5 min that marker defaults to; the answer did not report a cache write, all of it in that cache, that confirms it/,
	);
	await h.idle(2 * HOUR);
	assert.equal(h.state.attempts, 0);
	// An earlier answer of the same model wrote the 1-hour bucket; the latest only read the cache. The route may have
	// changed silently since (a gateway's failover to a route whose short tier lasts five minutes): no proof.
	clock();
	fresh({ compactBeforeExpiry: false });
	const earlier = { role: "assistant", content: [], timestamp: 500, stopReason: "stop", provider: "cliproxyapi", model: "sub/claude", usage: { input: 2, output: 5, cacheRead: 0, cacheWrite: 600_000, cacheWrite1h: 600_000 } };
	const readOnly = harness({ lifetime: 3600, sent: plainMarker, before: [{ type: "message", id: "e", parentId: null, timestamp: new Date(500).toISOString(), message: earlier }] });
	readOnly.emit("agent_settled");
	assert.equal(readOnly.decide(), undefined);
	assert.match(await readOnly.command("cache-keeper"), UNCONFIRMED);
	await readOnly.idle(2 * HOUR);
	assert.equal(readOnly.state.attempts, 0, "nothing sent: no cold refresh at 3,420 s");
	// The period's own answer wrote the 1-hour bucket, all of it: proof.
	clock();
	fresh({ compactBeforeExpiry: false });
	const proven = harness({ lifetime: 3600, sent: plainMarker, answer: HOUR_WRITE });
	assert.equal(await ownedRefresh(proven, HOUR), 3_421_000);
	// Another model's 1-hour write is no proof for this one.
	clock();
	fresh({ compactBeforeExpiry: false });
	const other = { ...earlier, provider: "claude-bridge", model: "opus" };
	const unproven = harness({ lifetime: 3600, sent: plainMarker, before: [{ type: "message", id: "e", parentId: null, timestamp: new Date(500).toISOString(), message: other }] });
	unproven.emit("agent_settled");
	assert.equal(unproven.decide(), undefined);
});

// ------------------------------- the reviewer's third look: evidence after the start, mixed writes, a model round trip

const refreshesOf = (h: ReturnType<typeof harness>) => h.warms.filter((w) => (w.options as { maxTokens?: number }).maxTokens === 1);
const STATED_HOUR = { model: "claude", max_tokens: 64_000, system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", ttl: "1h" } }], messages: [{ role: "user", content: "hi" }], thinking: { type: "adaptive" } };

// The reviewer's signalled sequence: the login's route keeps the plain marker's short tier for an hour, and the
// period's own answer reported the 1-hour write, so the period is the extension's at the hour. Pi's refresh from the run
// is answered by the API key's route: its receipt (at 273 s) reports a 5-minute write, and the gateway says so. Either
// one alone is evidence against the hour: the period is Pi's from then on, Pi's refresh at 543 s goes out, and the
// extension sends nothing (no cold re-send at 3,420 s).
test("evidence since the start: Pi's refresh reporting a write of another lifetime, or the route read now giving another, hands the period to Pi: Pi's next refresh goes out, the extension sends nothing", async (t) => {
	t.after(() => mock.timers.reset());
	online(t);
	withRetention(t, undefined);
	const receipt = { input: 5, output: 1, cacheRead: 570_000, cacheWrite: 30_000, cacheWrite1h: 0 };
	for (const evidence of ["the receipt and the route", "the receipt only", "the route only"] as const) {
		clock();
		fresh({ compactBeforeExpiry: false });
		const keyRoute = gateway(t, 300);
		const h = harness({ lifetime: 3600, cost: WITH_WRITE, sent: plainMarker, answer: { cacheRead: 0, cacheWrite: 600_000, cacheWrite1h: 600_000 } });
		h.emit("agent_settled");
		assert.deepEqual(h.decide(), { action: "stop" }, `${evidence}: owned at the login's hour`);
		await h.idle(272_000);
		if (evidence !== "the route only") h.ctx.sessionManager.appendUsage("cache_warm", h.model.provider, h.model.id, receipt);
		if (evidence !== "the receipt only") keyRoute(h);
		await h.idle(270_000);
		// Without Pi's receipt nothing seen says the cache outlived the five minutes read since: Pi is stopped.
		assert.deepEqual(h.decide(), evidence === "the route only" ? { action: "stop" } : undefined, `${evidence}: Pi's refresh at 543 s goes out, or is stopped`);
		await h.idle(2 * HOUR);
		await flush();
		assert.deepEqual(refreshesOf(h), [], `${evidence}: the extension sends nothing`);
		const stops = traces().filter((r) => r.stop);
		assert.deepEqual(
			stops.map((r) => r.stop),
			["unable"],
			`${evidence}: warming ended once`,
		);
		assert.match(
			stops[0].reason,
			evidence === "the receipt only" ? /^a refresh of Pi's after the answer reports a 5 min cache write; the request's cache lasts 60 min by the route's data$/ : /^the request's cache now lasts 5 min by the route's data, the cached request was written with 60 min$/,
			evidence,
		);
		const shown = await h.command("cache-keeper");
		assert.match(shown, /this session is left to Pi's own warming: /, evidence);
		// Counted as a period left to Pi, never longer than the five minutes read since.
		assert.match(shown, /\(lifetime 5 min, /, evidence);
	}
	// The receipt already on the branch when Pi goes idle (Pi's refresh during the run settled first): Pi's from the start.
	clock();
	fresh({ compactBeforeExpiry: false });
	gateway(t, 300);
	const early = harness({ lifetime: 3600, cost: WITH_WRITE, sent: plainMarker, answer: { cacheRead: 0, cacheWrite: 600_000, cacheWrite1h: 600_000 } });
	mock.timers.tick(272_000);
	early.ctx.sessionManager.appendUsage("cache_warm", early.model.provider, early.model.id, receipt);
	early.emit("agent_settled");
	assert.equal(early.decide(), undefined);
	assert.match(await early.command("cache-keeper"), /left to Pi's own warming: a refresh of Pi's after the answer reports a 5 min cache write/);
	// A receipt that reports a 1-hour write, or that only read, is no evidence against the hour: still the extension's.
	for (const usage of [{ ...receipt, cacheWrite1h: 30_000 }, { ...receipt, cacheRead: 600_000, cacheWrite: 0 }]) {
		clock();
		fresh({ compactBeforeExpiry: false });
		gateway(t, 300);
		const h = harness({ lifetime: 3600, cost: WITH_WRITE, sent: plainMarker, answer: { cacheRead: 0, cacheWrite: 600_000, cacheWrite1h: 600_000 } });
		h.emit("agent_settled");
		await h.idle(272_000);
		h.ctx.sessionManager.appendUsage("cache_warm", h.model.provider, h.model.id, usage);
		await h.idle(270_000);
		assert.deepEqual(h.decide(), { action: "stop" }, JSON.stringify(usage));
	}
});

// The reviewer's mixed write: 4,096 of 180,000 written tokens in the 1-hour cache, the rest in the 5-minute one. Evidence of neither
// lifetime: never a confirmation, and after it the model's periods are Pi's until an answer reports a write in one cache
// only; an answer that only read does not open ownership.
test("mixed writes: a write partly in each cache confirms no lifetime: the period is Pi's, counted as before (5 minutes), and stays so until a write in one cache only", async (t) => {
	t.after(() => mock.timers.reset());
	withRetention(t, undefined);
	const mixed = { cacheRead: 0, cacheWrite: 180_000, cacheWrite1h: 4_096 };
	// On a route whose tiers both last five minutes: Pi's, and compacting before expiry leaves 20 s before the five
	// minutes end, while the cache is warm (it left at 3,580 s, after the five-minute part had expired).
	clock();
	fresh({ minContextTokens: 0 });
	const h = harness({ lifetime: 300, cost: WITH_WRITE, answer: mixed });
	h.emit("agent_settled");
	assert.equal(h.decide(), undefined);
	assert.match(await h.command("cache-keeper"), /left to Pi's own warming: the answer reports cache writes in both tiers \(5 min and 1 h\)/);
	await h.idle(HOUR);
	assert.deepEqual([h.state.compacts, h.state.compactedAt], [1, 281_000]);
	// An earlier answer of the model wrote partly in each cache; the period's answer only read. A request that states
	// the hour, on a route whose long tier lasts an hour: Pi's, nothing sent.
	const before = (usage: Record<string, number>) => [
		{ type: "message", id: "e", parentId: null, timestamp: new Date(500).toISOString(), message: { role: "assistant", content: [], timestamp: 500, stopReason: "stop", provider: "cliproxyapi", model: "sub/claude", usage: { input: 2, output: 5, cacheRead: 0, ...usage } } },
	];
	withRetention(t, "long");
	clock();
	fresh({ compactBeforeExpiry: false });
	const readOnly = harness({ cost: WITH_WRITE, model: { promptCache: { short: 300, long: 3600 } }, sent: STATED_HOUR, before: before(mixed) });
	readOnly.emit("agent_settled");
	assert.equal(readOnly.decide(), undefined);
	assert.match(await readOnly.command("cache-keeper"), /left to Pi's own warming: an answer of this model reports a cache write partly in the 5-minute and partly in the 1-hour cache/);
	await readOnly.idle(2 * HOUR);
	await flush();
	assert.deepEqual(refreshesOf(readOnly), [], "no re-send at 3,420 s");
	// The period's own answer reports a write all in the 1-hour cache: the mixed write is behind it.
	clock();
	fresh({ compactBeforeExpiry: false });
	const pure = harness({ cost: WITH_WRITE, model: { promptCache: { short: 300, long: 3600 } }, sent: STATED_HOUR, before: before(mixed), answer: HOUR_WRITE });
	assert.equal(await ownedRefresh(pure, HOUR), 3_421_000);
	// On a route whose short tier lasts an hour, a plain marker: the mixed write confirms nothing.
	withRetention(t, undefined);
	clock();
	fresh({ compactBeforeExpiry: false });
	const plain = harness({ lifetime: 3600, cost: WITH_WRITE, sent: plainMarker, answer: mixed });
	plain.emit("agent_settled");
	assert.equal(plain.decide(), undefined);
	await plain.idle(2 * HOUR);
	await flush();
	assert.deepEqual(refreshesOf(plain), []);
});

// The reviewer's model round trip: the model switched away and back without a message. The extension let go of the period's request with the
// first switch, so it can't refresh the period: the period is Pi's, and Pi's warming is never told to stop (it was told
// so at 270 s, and neither warmer sent anything). Also on a plain five-minute route, as on 0.5.3.
test("a model round trip: a model switch away and back without a message: the period is Pi's from the first switch, no 'stop', nothing sent by the extension", async (t) => {
	t.after(() => mock.timers.reset());
	online(t);
	withRetention(t, undefined);
	const routes: [string, Options][] = [
		["a direct five-minute route", { lifetime: 300, cost: WITH_WRITE }],
		["a route whose short tier lasts an hour", { lifetime: 3600, cost: WITH_WRITE, sent: plainMarker, answer: HOUR_WRITE }],
	];
	for (const [label, options] of routes) {
		clock();
		fresh({ compactBeforeExpiry: false });
		const h = harness({ ui: true, ...options });
		h.emit("agent_settled");
		assert.deepEqual(h.decide(), { action: "stop" }, `${label}: owned`);
		await h.idle(59_000);
		const own = h.ctx.model;
		h.ctx.model = { ...h.model, provider: "google", id: "gemini-3.8-pro", api: "google-generative-ai" } as never;
		h.emit("model_select");
		await h.idle(1_000);
		h.ctx.model = own;
		h.emit("model_select");
		await h.idle(209_000);
		assert.equal(h.decide(), undefined, `${label}: Pi's refresh at 270 s goes out`);
		await h.idle(2 * HOUR);
		await flush();
		assert.deepEqual(refreshesOf(h), [], `${label}: the extension sends nothing`);
		const stops = traces().filter((r) => r.stop);
		assert.deepEqual(
			stops.map((r) => [r.stop, r.reason]),
			[["unable", "the extension no longer holds the period's request (the model, the branch or the conversation changed), so it can't refresh it"]],
			label,
		);
		assert.match(lastFooter(h) ?? "", /keep-warm: Pi's \(request let go\)/, label);
	}
});

// ---------------------------------- the reviewer's second look: one judge of the evidence (lifetime-evidence.ts)

// The reviewer's 1a: a route whose short tier lasts an hour, confirmed by the period's own answer. At 3,421 s the
// extension's refresh reads 570,000 and writes 30,000, all of it to the five-minute cache: the gateway switched route.
// The 95% read is a hit for the budget, and the write is evidence against the hour: warming ends, the period is Pi's, and
// nothing goes out at 6,841 s (it rewrote all 600,000 there). The countdown counts five minutes from that refresh's send.
test("the extension's own refresh is a report: a hit that wrote the rest into the five-minute cache hands the period to Pi, no second refresh", async (t) => {
	t.after(() => mock.timers.reset());
	withRetention(t, undefined);
	clock();
	fresh({ compactBeforeExpiry: false, keepWarmMinutes: 240 });
	const h = harness({ lifetime: 3600, cost: WITH_WRITE, ui: true, sent: plainMarker, answer: CONFIRMING_HOUR, respond: () => ({ usage: { cacheRead: 570_000, cacheWrite: 30_000, cacheWrite1h: 0 } }) });
	assert.equal(await ownedRefresh(h, HOUR), 3_421_000);
	const refresh = traces().find((r) => r.event === "warm" && r.action === "warm");
	assert.equal(refresh.stop, "unable");
	assert.equal(refresh.reason, "the extension's refresh reports a 5 min cache write; the request's cache lasts 60 min by the route's data");
	assert.ok(refresh.budget.spent > 0, "a hit, counted in the budget");
	assert.equal(h.decide(), undefined, "Pi's warming decides");
	assert.match(await h.command("cache-keeper"), /\(lifetime 5 min, /);
	await h.idle(4 * HOUR);
	await flush();
	assert.equal(refreshesOf(h).length, 1, "nothing at 6,841 s");
	assert.match(lastFooter(h) ?? "", /^cache cold · next message full price · keep-warm: Pi's \(the refresh wrote otherwise\)/);
});

// The reviewer's 1b: a gateway that caches requests without markers. The request carries none (Pi's adapter with
// `cacheRetention: "none"`), the route's data gives it an hour, an earlier answer wrote the hour and the period's own
// answer only read: no confirmation, Pi's; nothing sent (it re-sent at 3,421 s, after the five-minute cache was gone).
test("a request without any cache marker on Anthropic Messages: five minutes by default, any other route lifetime confirmed by the period's own answer only", async (t) => {
	t.after(() => mock.timers.reset());
	withRetention(t, undefined);
	const unmarked = { model: "claude", max_tokens: 64_000, system: "s", messages: [{ role: "user", content: "hi" }], thinking: { type: "adaptive" } };
	const earlierHour = [
		{ type: "message", id: "e", parentId: null, timestamp: new Date(500).toISOString(), message: { role: "assistant", content: [], timestamp: 500, stopReason: "stop", provider: "cliproxyapi", model: "sub/claude", usage: { input: 2, output: 5, cacheRead: 0, cacheWrite: 600_000, cacheWrite1h: 600_000 } } },
	];
	clock();
	fresh({ compactBeforeExpiry: false });
	const h = harness({ lifetime: 3600, cost: WITH_WRITE, sent: unmarked, before: earlierHour });
	h.emit("agent_settled");
	assert.equal(h.decide(), undefined);
	assert.match(await h.command("cache-keeper"), /left to Pi's own warming: the request states no cache lifetime \(it carries no cache marker\), and the route's lifetime for its tier \(60 min\) is not the 5 min a request without one defaults to; the answer did not report a cache write, all of it in that cache, that confirms it/);
	await h.idle(2 * HOUR);
	await flush();
	assert.deepEqual(refreshesOf(h), []);
	// The period's own answer wrote the hour: kept warm at the hour.
	clock();
	fresh({ compactBeforeExpiry: false });
	assert.equal(await ownedRefresh(harness({ lifetime: 3600, cost: WITH_WRITE, sent: unmarked, answer: CONFIRMING_HOUR }), HOUR), 3_421_000);
	// On a five-minute route the default holds, with or without a write.
	clock();
	fresh({ compactBeforeExpiry: false });
	assert.equal(await ownedRefresh(harness({ lifetime: 300, cost: WITH_WRITE, sent: unmarked })), 276_000);
});

// The reviewer's 3: a 30-minute goal and an hour cache: no refresh needed, so warming ends on the time limit at the
// start. Then Pi's refresh from the run reports a five-minute write and the gateway its API key's route: the period's
// lifetime no longer holds, so Pi's first idle proposal at 543 s goes out (it was told "stop", and the next message at
// 600 s rewrote all 600,000). And after the time limit ended warming, letting the request go releases Pi too.
test("a period whose warming ended on its time limit is still asked: evidence against its lifetime, or its request let go, and Pi's warming decides", async (t) => {
	t.after(() => mock.timers.reset());
	online(t);
	withRetention(t, undefined);
	const receipt = { input: 5, output: 1, cacheRead: 570_000, cacheWrite: 30_000, cacheWrite1h: 0 };
	const covered = () => {
		clock();
		fresh({ compactBeforeExpiry: false, keepWarmMinutes: 30 });
		const keyRoute = gateway(t, 300);
		const h = harness({ lifetime: 3600, cost: WITH_WRITE, ui: true, sent: plainMarker, answer: CONFIRMING_HOUR });
		h.emit("agent_settled");
		return { h, keyRoute };
	};
	for (const evidence of ["the receipt and the route", "the receipt only", "the route only"] as const) {
		const { h, keyRoute } = covered();
		await h.idle(5_000);
		assert.deepEqual(traces().filter((r) => r.stop).map((r) => r.stop), ["limit"], `${evidence}: the hour covers the 30 minutes`);
		assert.deepEqual(h.decide(), { action: "stop" }, `${evidence}: Pi stays stopped while the period holds`);
		await h.idle(267_000);
		if (evidence !== "the route only") h.ctx.sessionManager.appendUsage("cache_warm", h.model.provider, h.model.id, receipt);
		if (evidence !== "the receipt only") keyRoute(h);
		await h.idle(270_000);
		assert.deepEqual(h.decide(), evidence === "the route only" ? { action: "stop" } : undefined, `${evidence}: Pi's proposal at 543 s goes out, or is stopped`);
		assert.match(await h.command("cache-keeper"), /this session is left to Pi's own warming: /, evidence);
		assert.deepEqual(refreshesOf(h), []);
	}
	// Ended on the time limit, then the request let go (a model switch away and back, a move on the tree).
	for (const letGo of ["a model switch", "/tree"] as const) {
		const { h } = covered();
		await h.idle(60_000);
		assert.deepEqual(h.decide(), { action: "stop" });
		if (letGo === "/tree") h.emit("session_tree");
		else {
			const own = h.ctx.model;
			h.ctx.model = { ...h.model, provider: "google", id: "gemini-3.8-pro", api: "google-generative-ai" } as never;
			h.emit("model_select");
			h.ctx.model = own;
			h.emit("model_select");
		}
		assert.equal(h.decide(), undefined, `${letGo}: Pi's warming decides`);
	}
	// Ended for good (the budget): Pi stays stopped, as before, also after the request is let go.
	clock();
	fresh({ compactBeforeExpiry: false, keepWarmMinutes: 1440 });
	const spent = harness({ lifetime: 300 });
	spent.emit("agent_settled");
	await spent.idle(2 * HOUR);
	assert.equal(traces().find((r) => r.stop)?.stop, "budget");
	spent.emit("session_tree");
	assert.deepEqual(spent.decide(), { action: "stop" });
});

// The reviewer's 4: after a hand-over on evidence against, the period's countdown counts the shortest lifetime read from
// the period's own last fact (its answer here), never from when a receipt of Pi's was recorded; a write in both caches
// counts as the shorter, and a marker without ttl has its five minutes where the route gives its tier none. Read cold
// early, compacting before expiry sends nothing (each sent a summary that read nothing from the cache).
test("after a hand-over on evidence against, the countdown counts the shortest lifetime from the period's own last fact: no cold summary", async (t) => {
	t.after(() => mock.timers.reset());
	const cases: [string, Options, string | undefined, (h: ReturnType<typeof harness>) => void][] = [
		[
			"an explicit hour, the route now giving its tier five minutes, Pi's receipt recorded at 350 s",
			{ model: { promptCache: { short: 300, long: 3600 } }, sent: STATED_HOUR },
			"long",
			(h) => {
				h.model.promptCache = { short: 300, long: 300 };
				h.ctx.sessionManager.appendUsage("cache_warm", h.model.provider, h.model.id, { input: 5, output: 1, cacheRead: 600_000, cacheWrite: 0, cacheWrite1h: 0 });
			},
		],
		[
			"the short-hour route, Pi's receipt writing into both caches",
			{ lifetime: 3600, sent: plainMarker, answer: CONFIRMING_HOUR },
			undefined,
			(h) => h.ctx.sessionManager.appendUsage("cache_warm", h.model.provider, h.model.id, { input: 5, output: 1, cacheRead: 0, cacheWrite: 180_000, cacheWrite1h: 4_096 }),
		],
		[
			"the short-hour route, the route now giving the short tier nothing",
			{ lifetime: 3600, sent: plainMarker, answer: CONFIRMING_HOUR },
			undefined,
			(h) => {
				h.model.promptCache = { long: 3600 };
				h.ctx.sessionManager.appendUsage("cache_warm", h.model.provider, h.model.id, { input: 5, output: 1, cacheRead: 600_000, cacheWrite: 0, cacheWrite1h: 0 });
			},
		],
	];
	for (const [label, options, retention, evidence] of cases) {
		withRetention(t, retention);
		clock();
		fresh({ minContextTokens: 0 });
		const h = harness({ cost: WITH_WRITE, ui: true, ...options });
		h.emit("agent_settled");
		assert.deepEqual(h.decide(), { action: "stop" }, `${label}: owned`);
		await h.idle(349_000);
		evidence(h);
		await h.idle(15_000);
		assert.equal(h.decide(), undefined, `${label}: Pi's`);
		assert.match(lastFooter(h) ?? "", /^cache cold/, `${label}: counted from the answer at 1 s, five minutes: cold`);
		assert.match(await h.command("cache-keeper"), /\ncache: expired \(lifetime 5 min, /, `${label}: /cache-keeper too`);
		await h.idle(2 * HOUR);
		assert.equal(h.state.compacts, 0, `${label}: no summary`);
		assert.deepEqual(refreshesOf(h), [], label);
	}
});

// The route whose short tier lasts an hour, confirmed by the period's own answer, through two refreshes: one reports an
// hour write, one only reads. Both agree with the hour: warming goes on.
test("the confirmed short-hour route stays the extension's through refreshes that report an hour write or no write", async (t) => {
	t.after(() => mock.timers.reset());
	withRetention(t, undefined);
	clock();
	fresh({ compactBeforeExpiry: false, keepWarmMinutes: 120 });
	const h = harness({ lifetime: 3600, cost: WITH_WRITE, sent: plainMarker, answer: CONFIRMING_HOUR, respond: (n) => ({ usage: n === 1 ? { cacheRead: 590_000, cacheWrite: 10_000, cacheWrite1h: 10_000 } : { cacheRead: 600_000, cacheWrite: 0, cacheWrite1h: 0 } }) });
	h.emit("agent_settled");
	await h.idle(3 * HOUR);
	await flush();
	assert.deepEqual(refreshesOf(h).map((w) => w.at), [3_421_000, 6_841_000]);
	assert.deepEqual(traces().filter((r) => r.stop).map((r) => r.stop), ["limit"], "ended only by the time limit");
	assert.deepEqual(h.decide(), { action: "stop" });
});

// Every row of the probe (route data in seconds for the short and the long tier, the request's marker, the bucket the
// answer reports), keep-warm on: owned at a lifetime, with the first refresh 5% (at least 25 s) before it expires, or
// Pi's, with why. The bucket is evidence of a lifetime: owned only where it is the request's lifetime.
const PROBE_ROUTES: Record<string, { short?: number; long?: number } | undefined> = {
	"300/3600": { short: 300, long: 3600 },
	"3600/3600": { short: 3600, long: 3600 },
	"3600/-": { short: 3600 },
	"3600/7200": { short: 3600, long: 7200 },
	"300/1800": { short: 300, long: 1800 },
	"1800/3600": { short: 1800, long: 3600 },
	"300/300": { short: 300, long: 300 },
	"-/-": undefined,
};
const PROBE_MARKERS = { plain: { type: "ephemeral" }, "1h": { type: "ephemeral", ttl: "1h" } } as const;
const PROBE_BUCKETS = { "5m": FIVE_MINUTE_WRITE, "1h": HOUR_WRITE, none: {} } as const;
const probeRequest = (marker: keyof typeof PROBE_MARKERS) => ({ ...plainMarker, system: [{ type: "text", text: "s", cache_control: PROBE_MARKERS[marker] }] });
const probeHarness = (route: string, marker: keyof typeof PROBE_MARKERS, bucket: keyof typeof PROBE_BUCKETS, options: Options = {}) =>
	harness({ cost: WITH_WRITE, model: { provider: "gw", promptCache: PROBE_ROUTES[route] }, sent: probeRequest(marker), answer: PROBE_BUCKETS[bucket], ...options });
const UNCONFIRMED = /the request states no cache lifetime .* the answer did not report a cache write, all of it in that cache, that confirms it/;
const DISAGREE = /an answer of this model reports a \d+ min cache write; the request's cache lasts \d+ min/;
const STATED = /the request's cache lifetime does not match the model data/;
const UNKNOWN = /the cache lifetime is unknown/;
const KEEP_WARM_ROWS: [string, keyof typeof PROBE_MARKERS, keyof typeof PROBE_BUCKETS, number | RegExp][] = [
	["300/3600", "plain", "5m", 300],
	["300/3600", "plain", "1h", DISAGREE],
	["300/3600", "plain", "none", 300],
	["300/3600", "1h", "5m", DISAGREE],
	["300/3600", "1h", "1h", 3600],
	["300/3600", "1h", "none", 3600],
	["3600/3600", "plain", "5m", DISAGREE],
	["3600/3600", "plain", "1h", 3600],
	["3600/3600", "plain", "none", UNCONFIRMED],
	["3600/3600", "1h", "5m", DISAGREE],
	["3600/3600", "1h", "1h", 3600],
	["3600/3600", "1h", "none", 3600],
	["3600/-", "plain", "5m", DISAGREE],
	["3600/-", "plain", "1h", 3600],
	["3600/-", "plain", "none", UNCONFIRMED],
	["3600/-", "1h", "5m", DISAGREE],
	["3600/-", "1h", "1h", 3600],
	["3600/-", "1h", "none", UNKNOWN],
	["3600/7200", "plain", "5m", DISAGREE],
	["3600/7200", "plain", "1h", 3600],
	["3600/7200", "plain", "none", UNCONFIRMED],
	["3600/7200", "1h", "5m", STATED],
	["3600/7200", "1h", "1h", STATED],
	["3600/7200", "1h", "none", STATED],
	["300/1800", "plain", "5m", 300],
	["300/1800", "plain", "1h", DISAGREE],
	["300/1800", "plain", "none", 300],
	["300/1800", "1h", "5m", STATED],
	["300/1800", "1h", "1h", STATED],
	["300/1800", "1h", "none", STATED],
	["1800/3600", "plain", "5m", DISAGREE],
	["1800/3600", "plain", "1h", DISAGREE],
	["1800/3600", "plain", "none", UNCONFIRMED],
	["1800/3600", "1h", "5m", DISAGREE],
	["1800/3600", "1h", "1h", 3600],
	["1800/3600", "1h", "none", 3600],
	["300/300", "plain", "5m", 300],
	["300/300", "plain", "1h", DISAGREE],
	["-/-", "plain", "5m", 300],
	["-/-", "plain", "1h", DISAGREE],
	["-/-", "plain", "none", UNKNOWN],
	["-/-", "1h", "5m", DISAGREE],
	["-/-", "1h", "1h", 3600],
	["-/-", "1h", "none", UNKNOWN],
];

test("route lifetimes, keep-warm on: every row of the probe is owned at the request's lifetime where the evidence agrees, else Pi's", async (t) => {
	t.after(() => mock.timers.reset());
	for (const [route, marker, bucket, expected] of KEEP_WARM_ROWS) {
		const label = `${route}, ${marker} marker, ${bucket} bucket`;
		withRetention(t, marker === "1h" ? "long" : undefined);
		clock();
		fresh({ compactBeforeExpiry: false });
		const h = probeHarness(route, marker, bucket);
		if (typeof expected === "number") {
			const at = await ownedRefresh(h, (expected + 10) * 1000);
			assert.equal(at, 1_000 + expected * 1000 - Math.max(25_000, expected * 50), `${label}: the first refresh`);
			const refresh = traces().find((r) => r.event === "warm" && r.action === "warm");
			assert.equal(refresh?.lifetimeSeconds, expected, `${label}: the period's lifetime`);
		} else {
			h.emit("agent_settled");
			assert.equal(h.decide(), undefined, `${label}: Pi's`);
			assert.match(await h.command("cache-keeper"), new RegExp(`left to Pi's own warming: ${expected.source}`), label);
			await h.idle(HOUR + 10_000);
			assert.equal(h.state.attempts, 0, `${label}: the extension sends nothing`);
		}
	}
});

test("route lifetimes: a period owned by the data for the tier asked names that source, not the bucket's", async (t) => {
	t.after(() => mock.timers.reset());
	withRetention(t, undefined);
	clock();
	fresh({ compactBeforeExpiry: false });
	const h = probeHarness("3600/-", "plain", "1h");
	assert.equal(await ownedRefresh(h, HOUR), 3_421_000);
	assert.equal(traces().find((r) => r.event === "warm" && r.action === "warm").lifetimeSource, "declared by the model");
});

test("route lifetimes: Claude on the Anthropic API with Pi's real adapter, short and long, is kept warm as before; a plain marker whose answer reports the 1-hour write is not", { skip: noCatalog }, async (t) => {
	t.after(() => mock.timers.reset());
	noNetwork(t);
	for (const [retention, answer, at] of [
		["short", FIVE_MINUTE_WRITE, 276_000],
		["short", {}, 276_000],
		["long", HOUR_WRITE, 3_421_000],
		["long", {}, 3_421_000],
	] as const) {
		withRetention(t, retention === "long" ? "long" : undefined);
		clock();
		fresh({ compactBeforeExpiry: false });
		const sent = await adapterPayload(claude(), { maxTokens: 8192, cacheRetention: retention }, systemAndUser);
		const h = harness({ model: { ...claude(), cost: WITH_WRITE }, sent, answer, stream: viaRealAdapter(claude()) });
		assert.equal(await ownedRefresh(h, HOUR), at, `${retention} ${JSON.stringify(answer)}`);
	}
	withRetention(t, undefined);
	clock();
	fresh({ compactBeforeExpiry: false });
	const sent = await adapterPayload(claude(), { maxTokens: 8192, cacheRetention: "short" }, systemAndUser);
	const h = harness({ model: { ...claude(), cost: WITH_WRITE }, sent, answer: HOUR_WRITE, stream: viaRealAdapter(claude()) });
	h.emit("agent_settled");
	assert.equal(h.decide(), undefined);
	assert.match(await h.command("cache-keeper"), /an answer of this model reports a 60 min cache write; the request's cache lasts 5 min by the route's data/);
});

test("route lifetimes: a format whose answers report no bucket goes by the data, as before (GPT-6.1 Sol on OpenAI's API, 30 minutes)", { skip: noCatalog }, async (t) => {
	t.after(() => mock.timers.reset());
	noNetwork(t);
	withRetention(t, undefined);
	clock();
	fresh({ compactBeforeExpiry: false });
	const real = MODELS.openai["gpt-6.1-sol"];
	const model = { ...real, promptCache: undefined, cost: WITH_WRITE };
	const sent = await adapterPayload(model, { maxTokens: 8192, cacheRetention: "short" }, systemAndUser);
	const h = harness({ model, sent, stream: viaRealAdapter(model) });
	assert.equal(await ownedRefresh(h), 1_711_000, "OpenAI's 30-minute minimum, no bucket");
	assert.equal(traces().find((r) => r.event === "warm" && r.action !== "pi-stopped").lifetimeSource, "OpenAI's minimum");
});

const withCompaction = (lookupMs: number, options: Options) => {
	const summaries: { at: number; payload: unknown }[] = [];
	let compaction: Promise<unknown> | undefined;
	const h = harness({
		...options,
		stream: (o) => ({
			result: async () => {
				const summary = (o as { maxTokens?: number }).maxTokens !== 1;
				if (summary && lookupMs) mock.timers.tick(lookupMs);
				let payload: unknown;
				try {
					payload = await (o as { onPayload: (p: unknown) => unknown }).onPayload({ ...h.sent, messages: [...h.sent.messages, { role: "user", content: "Summarize." }] });
				} catch (error) {
					return { stopReason: "error", errorMessage: (error as Error).message, content: [], usage: h.usage({ input: 0, output: 0, cacheRead: 0 }) };
				}
				if (summary) summaries.push({ at: Date.now(), payload });
				return { stopReason: "stop", content: [{ type: "text", text: summary ? "The summary." : "" }], usage: h.usage() };
			},
		}),
	});
	h.ctx.compact = () => {
		h.state.compacts++;
		compaction = h.emit("session_before_compact", {
			reason: "manual",
			branchEntries: [...h.branch],
			signal: new AbortController().signal,
			preparation: { tokensBefore: 600_000, firstKeptEntryId: "u", messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false, fileOps: { read: new Set(), written: new Set(), edited: new Set() }, settings: { reserveTokens: 16_384, keepRecentTokens: 20_000 } },
		}) as Promise<unknown>;
	};
	return { h, summaries, compaction: () => compaction };
};
const checkGate = async (label: string, lookupMs: number, run: ReturnType<typeof withCompaction>, expect: { startedAt: number }) => {
	assert.equal(run.h.state.compacts, 1, `${label}: compaction before expiry started`);
	const result = await run.compaction();
	const record = allTraces().find((r) => r.event === "compact");
	const started = allTraces().find((r) => r.event === "expiry" && r.action === "compact");
	assert.equal(Date.parse(started.at), expect.startedAt, `${label}: when it started`);
	if (lookupMs) {
		assert.deepEqual(run.summaries, [], `${label}: nothing left`);
		assert.deepEqual(result, { cancel: true }, `${label}: the compaction is cancelled`);
		assert.deepEqual([record.outcome, record.reason], ["cancelled", "the prompt cache expired before the summary request left"], label);
	} else {
		assert.deepEqual(run.summaries.map((x) => x.at), [expect.startedAt], `${label}: it left at once, while the cache was warm`);
		assert.equal(record.outcome, "cached", label);
		assert.equal(record.response.usage.cacheRead, 600_000, `${label}: and read the cache`);
	}
};

test("compaction before expiry, keep-warm off: a credential lookup that outlasts the cache leaves nothing and cancels the compaction; a fast one leaves and reads the cache", async (t) => {
	t.after(() => mock.timers.reset());
	for (const lookupMs of [21_000, 0]) {
		clock();
		fresh({ keepWarmMinutes: 0, minContextTokens: 100_000 });
		const run = withCompaction(lookupMs, { lifetime: 300, cost: WITH_WRITE });
		run.h.emit("agent_settled");
		await run.h.idle(HOUR);
		await checkGate(`lookup ${lookupMs / 1000} s`, lookupMs, run, { startedAt: 281_000 });
		mock.timers.reset();
	}
});

// The reviewer's sequence: an owned period on the login's hour; at 294 s the gateway shows the API key's 5-minute route.
// The route changed since the period's answer: the cache's expiry is unknown for the rest of the period (the login's
// cache says nothing about the key's), so compacting before expiry never starts, whatever the credential lookup takes.
// On 0.5.3 and before this change, a summary started at once and left while the five minutes lasted.
test("compaction before expiry, keep-warm on: the gateway shows the 5-minute route at 294 s; the route changed, so no compaction starts, with a 2.1-s credential lookup or a fast one", async (t) => {
	t.after(() => mock.timers.reset());
	online(t);
	for (const lookupMs of [2_100, 0]) {
		clock();
		fresh({ minContextTokens: 100_000 });
		const keyRoute = gateway(t, 300);
		const run = withCompaction(lookupMs, { lifetime: 3600, cost: WITH_WRITE, sent: plainMarker, answer: CONFIRMING_HOUR });
		run.h.emit("agent_settled");
		await run.h.idle(293_000);
		keyRoute(run.h);
		await run.h.idle(HOUR);
		assert.deepEqual(run.h.warms.filter((w) => (w.options as { maxTokens?: number }).maxTokens === 1), [], `lookup ${lookupMs / 1000} s: no refresh`);
		assert.equal(run.h.state.compacts, 0, `lookup ${lookupMs / 1000} s: no compaction starts`);
		assert.deepEqual(run.summaries, [], `lookup ${lookupMs / 1000} s: nothing left`);
		assert.equal(allTraces().find((r) => r.event === "expiry"), undefined, `lookup ${lookupMs / 1000} s: compacting before expiry was not tried`);
		mock.timers.reset();
	}
});

// ------------------------------------------------- one clock: every state of the warmer, every kind of later evidence

// A 30-minute route whose answers report no write breakdown (the period goes by the data), behind a gateway whose API-key
// route also lasts 30 minutes. Prices where one refresh costs nearly a miss, so the budget ends after one refresh. Each
// refresh answers as `respond` says (a hit by default); `holdFirst` keeps the first one out until `release`. A summary's
// credential lookup takes 25 s, longer than compaction before expiry's 20-s lead, so the summary's last check falls after
// the expiry it was started for.
const NEAR_MISS = { input: 3, output: 0, cacheRead: 1.4, cacheWrite: 0 };
const FIVE_RECEIPT = { input: 5, output: 1, cacheRead: 570_000, cacheWrite: 30_000, cacheWrite1h: 0 };
function everyState(t: { after: (fn: () => void) => void }, o: { respond?: (n: number) => { stopReason?: string; errorMessage?: string; usage?: Fields }; holdFirst?: boolean; params?: unknown }) {
	const keyRoute = gateway(t, 1800);
	const sent: { at: number; kind: "refresh" | "summary" }[] = [];
	let release: (() => void) | undefined;
	let compaction: Promise<unknown> | undefined;
	let refreshes = 0;
	const h = harness({
		lifetime: 1800,
		cost: NEAR_MISS,
		ui: true,
		model: NO_BREAKDOWN,
		stream: (s) => ({
			result: async () => {
				const summary = (s as { maxTokens?: number }).maxTokens !== 1;
				if (summary) mock.timers.tick(25_000);
				const n = summary ? 0 : ++refreshes;
				try {
					await s.onPayload(summary ? { ...h.sent, messages: [...h.sent.messages, { role: "user", content: "x" }] } : (o.params ?? { model: "rebuilt", max_tokens: 1, messages: [] }));
				} catch (error) {
					return { stopReason: "error", errorMessage: (error as Error).message, content: [], usage: h.usage({ input: 0, output: 0, cacheRead: 0 }) };
				}
				sent.push({ at: Date.now(), kind: summary ? "summary" : "refresh" });
				const answer = summary ? {} : (o.respond?.(n) ?? {});
				const response = { stopReason: answer.stopReason ?? "stop", errorMessage: answer.errorMessage, content: [{ type: "text", text: summary ? "The summary." : "" }], usage: h.usage(answer.usage) };
				if (!summary && n === 1 && o.holdFirst) return new Promise((resolve) => (release = () => resolve(response)));
				return response;
			},
		}),
	});
	h.ctx.compact = () => {
		h.state.compacts++;
		compaction = h.emit("session_before_compact", {
			reason: "manual",
			branchEntries: [...h.branch],
			signal: new AbortController().signal,
			preparation: { tokensBefore: 600_000, firstKeptEntryId: "u", messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false, fileOps: { read: new Set(), written: new Set(), edited: new Set() }, settings: { reserveTokens: 16_384, keepRecentTokens: 20_000 } },
		}) as Promise<unknown>;
	};
	// Pi's refreshes recorded on the branch, as Pi appends them (after its leaf), so the summary's kept messages are found.
	const append = h.ctx.sessionManager.appendUsage;
	h.ctx.sessionManager.appendUsage = (...args: Parameters<typeof append>) => {
		const parentId = (h.branch.at(-1) as { id?: string } | undefined)?.id ?? null;
		const entry = append(...args);
		(entry as { parentId: string | null }).parentId = parentId;
		return entry;
	};
	const loginRoute = () => h.signal("model-upstreams:answered", { provider: "cliproxyapi", model: "sub/claude", upstreams: [{ provider: "claude-subscription", model: "claude-sonnet-5-5", subscription: true }] });
	return { h, sent, keyRoute: () => keyRoute(h), loginRoute, release: () => release?.(), compaction: () => compaction };
}
type Run = ReturnType<typeof everyState>;
// Each state of the warmer, reached from a period whose answer is at 1 s; `anchor`: the period's last sure fact (its
// answer, or the send of its latest refresh that reported a hit), `out`: a refresh stays out, `plain`: keep-warm read off.
const STATES: { state: string; options?: Parameters<typeof everyState>[1]; settings?: Record<string, unknown>; reach: (r: Run) => Promise<{ anchor: number; out?: boolean; plain?: boolean; ownEvidence?: boolean }> }[] = [
	{ state: "waiting", reach: async (r) => (await r.h.idle(99_000), { anchor: 1_000, ownEvidence: true }) },
	{ state: "out", options: { holdFirst: true }, reach: async (r) => (await r.h.idle(1_719_000), { anchor: 1_000, out: true, ownEvidence: true }) },
	{ state: "ended on its budget", settings: { keepWarmMinutes: 1440 }, reach: async (r) => (await r.h.idle(3_429_000), { anchor: 1_711_000 }) },
	{ state: "ended on a miss", options: { respond: () => ({ usage: { cacheRead: 300_000, cacheWrite: 300_000 } }) }, reach: async (r) => (await r.h.idle(1_719_000), { anchor: 1_000 }) },
	{ state: "ended on an unreported refresh", options: { respond: () => ({ usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 } }) }, reach: async (r) => (await r.h.idle(1_719_000), { anchor: 1_000 }) },
	{ state: "ended on a failed refresh", options: { respond: () => ({ stopReason: "error", errorMessage: "overloaded", usage: { input: 0, output: 0, cacheRead: 0 } }) }, reach: async (r) => (await r.h.idle(1_719_000), { anchor: 1_000 }) },
	{ state: "ended on its time limit", settings: { keepWarmMinutes: 10 }, reach: async (r) => (await r.h.idle(99_000), { anchor: 1_000 }) },
	{ state: "ended as unable", options: { params: { model: "rebuilt", max_tokens: 2, messages: [] } }, reach: async (r) => (await r.h.idle(1_719_000), { anchor: 1_000 }) },
	{
		state: "handed over on evidence",
		reach: async (r) => {
			await r.h.idle(49_000);
			// Pi's refresh wrote the hour: another lifetime than the period's 30 minutes, not a shorter one.
			r.h.ctx.sessionManager.appendUsage("cache_warm", r.h.model.provider, r.h.model.id, { input: 5, output: 1, cacheRead: 570_000, cacheWrite: 30_000, cacheWrite1h: 30_000 });
			await r.h.idle(50_000);
			return { anchor: 1_000 };
		},
	},
	{ state: "let go", reach: async (r) => (await r.h.idle(49_000), r.h.emit("session_tree"), await r.h.idle(50_000), { anchor: 1_000 }) },
	{
		state: "two misses on the model",
		options: { respond: () => ({ usage: { cacheRead: 300_000, cacheWrite: 300_000 } }) },
		reach: async (r) => {
			await r.h.idle(1_718_000);
			r.h.run(true);
			const answer = Date.now();
			await r.h.idle(1_719_000);
			return { anchor: answer };
		},
	},
	{ state: "keep-warm switched off", reach: async (r) => (await r.h.idle(49_000), settings({ keepWarmMinutes: 0, minContextTokens: 100_000 }), await r.h.idle(50_000), { anchor: 1_000, plain: true }) },
];
const EVIDENCE: { evidence: string; own?: boolean; floor?: number; unknown?: "the route changed" | "no lifetime can be read"; apply: (r: Run) => void }[] = [
	{ evidence: "Pi's refresh writes into the five-minute cache", floor: 300_000, apply: (r) => r.h.ctx.sessionManager.appendUsage("cache_warm", r.h.model.provider, r.h.model.id, FIVE_RECEIPT) },
	{ evidence: "the extension's own refresh writes into the five-minute cache", own: true, floor: 300_000, apply: () => {} },
	{ evidence: "Pi's refresh writes into both caches", floor: 300_000, apply: (r) => r.h.ctx.sessionManager.appendUsage("cache_warm", r.h.model.provider, r.h.model.id, { input: 5, output: 1, cacheRead: 0, cacheWrite: 180_000, cacheWrite1h: 4_096 }) },
	{ evidence: "the route's data gives the tier five minutes", floor: 300_000, apply: (r) => (r.h.model.promptCache = { short: 300, long: 300 }) },
	{ evidence: "the route's data gives the tier nothing", unknown: "no lifetime can be read", apply: (r) => delete (r.h.model as { promptCache?: unknown }).promptCache },
	{ evidence: "another route is announced", unknown: "the route changed", apply: (r) => r.keyRoute() },
	{ evidence: "another route is announced, then the first one again", unknown: "the route changed", apply: (r) => (r.keyRoute(), r.loginRoute()) },
];
const minutesLabel = (ms: number) => `${Math.round(ms / 60_000)}m`;

test("one clock: in every state of the warmer, after every kind of later evidence, the footer, its lifetime in use, /cache-keeper, compacting before expiry and the summary's last check read the same expiry, and nothing leaves at or after it or while it is unknown", async (t) => {
	t.after(() => mock.timers.reset());
	online(t);
	withRetention(t, undefined);
	let rows = 0;
	for (const s of STATES) {
		for (const e of EVIDENCE) {
			// The extension's own refresh reports only where one goes out after the evidence's moment: waiting, or out.
			if (e.own && s.state !== "waiting" && s.state !== "out") continue;
			const label = `${s.state}; ${e.evidence}`;
			clock();
			fresh({ minContextTokens: 100_000, ...s.settings });
			const own = e.own ? { respond: () => ({ usage: { cacheRead: 570_000, cacheWrite: 30_000, cacheWrite1h: 0 } }) } : {};
			const r = everyState(t, { ...s.options, ...own });
			r.h.emit("agent_settled");
			const reached = await s.reach(r);
			let anchor = reached.anchor;
			const at = Date.now();
			e.apply(r);
			if (e.own && reached.out) {
				r.release();
				await flush();
				anchor = 1_711_000;
			}
			if (e.own && !reached.out) {
				// The first refresh, 90 s before the 30-minute expiry, reports the five-minute write.
				await r.h.idle(1_711_000 - Date.now());
				await flush();
				anchor = 1_711_000;
			}
			const evidenceAt = Date.now();
			await r.h.idle(16_000);
			await flush();
			// What keep-warm off counts (as on main): Pi's refreshes move it, the data now gives the lifetime.
			const plain = reached.plain
				? e.unknown === "no lifetime can be read"
					? undefined
					: { expiry: (e.evidence.startsWith("Pi's") ? at : 1_000) + (e.floor === 300_000 && !e.evidence.startsWith("Pi's") ? 300_000 : 1_800_000), lifetime: e.floor === 300_000 && !e.evidence.startsWith("Pi's") ? 300_000 : 1_800_000 }
				: undefined;
			const unknown = reached.plain ? undefined : e.unknown;
			const lifetime = reached.plain ? plain?.lifetime : e.unknown === "no lifetime can be read" ? undefined : (e.floor ?? 1_800_000);
			const expiry = reached.plain ? plain?.expiry : unknown ? undefined : anchor + (e.floor ?? 1_800_000);
			const now = Date.now();
			const footer = lastFooter(r.h) ?? "";
			const shown = (await r.h.command("cache-keeper")).match(/\ncache: .*/)?.[0] ?? "";
			// The footer's countdown and /cache-keeper's line.
			if (lifetime === undefined) assert.match(shown, /cache: lifetime unknown, so no countdown/, `${label}: /cache-keeper`);
			if (expiry === undefined) {
				if (lifetime !== undefined) assert.match(shown, new RegExp(`cache: expired \\(lifetime ${formatRemaining(lifetime).replace(" left", "")}|cache: expired \\(lifetime \\d+ min.*counted as expired: ${unknown}`), `${label}: /cache-keeper`);
				if (unknown) assert.match(footer, /^cache cold/, `${label}: the footer`);
			} else if (expiry > now) {
				const left = `${formatRemaining(expiry - now)} left`;
				if (!reached.out || e.own) assert.ok(footer.startsWith(`cache warm · ${left} · `), `${label}: the footer ${footer}, expected ${left}`);
				assert.ok(shown.startsWith(`\ncache: ${left} (lifetime ${lifetime! / 60_000} min`), `${label}: /cache-keeper ${shown}, expected ${left}`);
			} else {
				if (!reached.out || e.own) assert.match(footer, /^cache cold/, `${label}: the footer`);
				assert.ok(shown.startsWith(`\ncache: expired (lifetime ${lifetime! / 60_000} min`), `${label}: /cache-keeper ${shown}`);
			}
			// The lifetime the footer marks in use is the countdown's. With keep-warm read off the footer's values are main's,
			// read again only when Pi's events say so; that is left as it is.
			if (lifetime !== undefined && !reached.plain) assert.match(footer, new RegExp(`short ${minutesLabel(lifetime)} \\(in use\\)`), `${label}: the lifetime in use, ${footer}`);
			// Then the rest of the idle time: compacting before expiry starts 20 s before that same expiry, and its summary's last
			// check, after a 25-s credential lookup, falls after it: nothing leaves. Nothing leaves at or after the expiry, nor at
			// all once it is unknown.
			await r.h.idle(3 * HOUR);
			await r.compaction();
			await flush();
			const after = r.sent.filter((x) => x.at >= evidenceAt);
			if (expiry === undefined) assert.deepEqual(after, [], `${label}: nothing leaves on an unknown expiry`);
			else assert.ok(after.every((x) => x.at < expiry), `${label}: nothing at or after ${expiry / 1000} s: ${JSON.stringify(after)}`);
			const started = allTraces().filter((x) => x.event === "expiry" && Date.parse(x.at) >= evidenceAt);
			// With keep-warm off, as on main, the countdown keeps the expiry it had when the lifetime can't be read any more;
			// the summary's last check then finds none, and nothing leaves.
			const countedTo = reached.plain && lifetime === undefined ? 1_801_000 : expiry;
			if (countedTo === undefined || countedTo - 20_000 <= now || (reached.out && !e.own)) assert.deepEqual(started, [], `${label}: compacting before expiry not tried`);
			else {
				assert.equal(started.length, 1, `${label}: compacting before expiry tried once`);
				assert.equal(Date.parse(started[0].at) + started[0].secondsLeft * 1000, countedTo, `${label}: from the same expiry`);
				const summary = allTraces().find((x) => x.event === "compact");
				if (started[0].action === "compact") assert.deepEqual([summary?.outcome, summary?.reason], ["cancelled", "the prompt cache expired before the summary request left"], `${label}: the summary's last check`);
			}
			rows++;
			mock.timers.reset();
		}
	}
	assert.equal(rows, 12 * 6 + 2);
});

// /tree to another branch: the countdown belongs to the branch in front of the user. A period's facts apply only while
// the branch still holds the period's answer.
test("/tree to an independent branch whose cache is an hour old: the footer and /cache-keeper read that branch, cold", async (t) => {
	t.after(() => mock.timers.reset());
	for (const keepWarmMinutes of [0, 120]) {
		clock();
		fresh({ keepWarmMinutes, compactBeforeExpiry: false });
		const h = harness({ lifetime: 300, cost: WITH_WRITE, ui: true });
		// The harness's first branch answered at 1 s; an hour later another branch answers.
		const old = h.branch.slice();
		h.emit("agent_settled");
		await h.idle(HOUR);
		h.branch.length = 0;
		h.run(true);
		mock.timers.tick(2000);
		assert.match(lastFooter(h) ?? "", /^cache warm · 4m left/, `${keepWarmMinutes}: the fresh answer`);
		// Select the old branch without a summary.
		h.branch.splice(0, h.branch.length, ...old);
		h.emit("session_tree");
		mock.timers.tick(1000);
		assert.match(lastFooter(h) ?? "", /^cache cold/, `${keepWarmMinutes}: the selected branch`);
		assert.match(await h.command("cache-keeper"), /cache: expired/, `${keepWarmMinutes}: /cache-keeper`);
		mock.timers.reset();
	}
});

// The reviewer's first /tree capture: branch A asked for the 5-minute cache and its answer reported no write tier; branch
// B, with the retention switched to long, asked for the hour. With short restored, /tree back to A at 601 s: A's own
// answer and tier count (cold, as main shows it with keep-warm off), not B's period's hour.
test("/tree back to a branch whose answer reported no tier: its own tier counts, not the tier of the period on the branch left", async (t) => {
	t.after(() => mock.timers.reset());
	const saved = process.env.PI_CACHE_RETENTION;
	t.after(() => (saved === undefined ? delete process.env.PI_CACHE_RETENTION : (process.env.PI_CACHE_RETENTION = saved)));
	for (const keepWarmMinutes of [0, 120]) {
		clock();
		fresh({ keepWarmMinutes, compactBeforeExpiry: false });
		process.env.PI_CACHE_RETENTION = "short";
		const h = harness({ ui: true, cost: WITH_WRITE, model: { promptCache: { short: 300, long: 3600 } } });
		const a = h.branch.slice();
		// No refresh on A (a message stays queued), so A's own answer is all its cache has.
		h.state.pending = true;
		h.emit("agent_settled");
		await h.idle(599_000);
		h.state.pending = false;
		// Branch B, at 600 s, with the long retention: its request asks for the hour.
		process.env.PI_CACHE_RETENTION = "long";
		(h.sent as Record<string, unknown>).system = [{ type: "text", text: "s", cache_control: { type: "ephemeral", ttl: "1h" } }];
		h.branch.length = 0;
		h.run(true);
		mock.timers.tick(1000);
		assert.match(lastFooter(h) ?? "", /^cache warm · 59m left/, `${keepWarmMinutes}: B`);
		process.env.PI_CACHE_RETENTION = "short";
		h.branch.splice(0, h.branch.length, ...a);
		h.emit("session_tree");
		mock.timers.tick(1000);
		assert.match(lastFooter(h) ?? "", /^cache cold/, `${keepWarmMinutes}: A, 601 s old`);
		assert.match(await h.command("cache-keeper"), /cache: expired \(lifetime 5 min/, `${keepWarmMinutes}: /cache-keeper`);
		mock.timers.reset();
	}
});

// The reviewer's second /tree capture: a confirmed hit on branch X, keep-warm switched off, then /tree to an hour-old
// independent branch Y. Nothing of X's period carries over.
test("/tree after keep-warm was switched off: the confirmed hit of the period on the branch left does not carry over", async (t) => {
	t.after(() => mock.timers.reset());
	clock();
	fresh({ compactBeforeExpiry: false });
	const h = harness({ lifetime: 300, cost: WITH_WRITE, ui: true });
	const y = h.branch.slice();
	h.state.pending = true;
	h.emit("agent_settled");
	await h.idle(HOUR);
	h.state.pending = false;
	// Branch X answers at 3,601 s; its refresh at 3,876 s reports a hit.
	h.branch.length = 0;
	h.run(true);
	await h.idle(276_000);
	assert.deepEqual(h.warms.map((w) => w.at / 1000), [3876]);
	settings({ keepWarmMinutes: 0, compactBeforeExpiry: false });
	await h.idle(5_000);
	assert.match(lastFooter(h) ?? "", /^cache warm · 4m left/, "X: its hit still counts on X");
	h.branch.splice(0, h.branch.length, ...y);
	h.emit("session_tree");
	mock.timers.tick(1000);
	assert.match(lastFooter(h) ?? "", /^cache cold/, "Y, an hour old");
	assert.match(await h.command("cache-keeper"), /cache: expired/);
});

test("R9: one miss counted, then the command with only a count to clear", async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	fresh({ compactBeforeExpiry: false });
	const h = harness({ lifetime: 300, cost: WITH_WRITE, respond: () => HALF_MISS });
	await nextPeriod(h, true);
	assert.equal(await h.command("cache-keeper-warm"), `No model was left to Pi's own warming. The count of refreshes without a hit of ${MODEL_KEY} is cleared.`);
	assert.equal(countOf(), 0);
});

test("R9: the state belongs to the Pi process: a new extension instance (/new, /reload) finds it, a new process does not", async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	fresh({ compactBeforeExpiry: false });
	const h = harness({ lifetime: 300, cost: WITH_WRITE, respond: () => HALF_MISS });
	await nextPeriod(h, true);
	await nextPeriod(h);
	const line = fallbackLineAt(h.warms[1].at);
	for (const n of [1, 2]) {
		clock();
		const again = harness({ lifetime: 300, cost: WITH_WRITE, respond: () => HALF_MISS });
		assert.deepEqual(await nextPeriod(again, true), { decided: undefined, refreshed: 0 }, `instance ${n}`);
		assert.equal(await keepWarmLineOf(again), `${RULE}; ${line}`);
		clock();
		const other = harness({ lifetime: 300, cost: WITH_WRITE, model: { id: "sub/other" } });
		other.emit("agent_settled");
		assert.deepEqual(other.decide(), { action: "stop" }, `instance ${n}: another model`);
	}
	newProcess();
	clock();
	const restarted = harness({ lifetime: 300, cost: WITH_WRITE });
	restarted.emit("agent_settled");
	assert.deepEqual(restarted.decide(), { action: "stop" }, "a new process");
});

test("R9: an interrupted refresh that reported a miss counts; one that reported no usage neither counts nor resets", async (t) => {
	t.after(() => mock.timers.reset());
	const none = { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	const cases: [string, Partial<Options>, boolean][] = [
		["error after usage", { respond: (n) => (n === 2 ? { stopReason: "error", errorMessage: "stream failed", ...HALF_MISS } : HALF_MISS) }, true],
		["abort after usage", { respond: () => HALF_MISS, hold: (n) => n === 2 }, true],
		["error without usage", { respond: (n) => (n === 2 ? { stopReason: "error", errorMessage: "stream failed", ...none } : HALF_MISS) }, false],
		["abort without usage", { respond: () => HALF_MISS, hold: (n) => n === 2 }, false],
	];
	for (const [label, options, counts] of cases) {
		clock();
		fresh({ compactBeforeExpiry: false });
		const h = harness({ lifetime: 300, cost: WITH_WRITE, ...options });
		if (label === "abort without usage") h.state.abortReports = false;
		await nextPeriod(h, true);
		assert.equal(countOf(), 1, label);
		await nextPeriod(h);
		assert.equal(h.warms.length, 2, label);
		// An abort settles when the next real request starts; that run's period began before the settlement was known.
		if (options.hold) {
			mock.timers.tick(1000);
			h.run(true);
			await flush();
		}
		assert.equal(countOf(), counts ? 2 : 1, `${label}: the count`);
		assert.equal(misses()?.fallback.has(MODEL_KEY), counts, label);
		if (options.hold && counts) {
			// The period that started before the second miss was reported is Pi's from then on: Pi is not stopped for a
			// refresh the extension will not send, and nothing more leaves.
			assert.equal(h.decide("warm"), undefined, `${label}: the running period's handler returns nothing`);
			assert.match((await keepWarmLineOf(h)) ?? "", /two refreshes in a row without a hit for /, label);
			await h.idle(300_000);
			await flush();
			assert.equal(h.warms.length, 2, `${label}: nothing more leaves`);
		}
		mock.timers.tick(1000);
		h.run(true);
		assert.deepEqual(h.decide(), counts ? undefined : { action: "stop" }, `${label}: the next period`);
		if (!counts) {
			// Not reset either: the next miss is the second in a row.
			await h.idle(300_000);
			await flush();
			assert.equal(misses()?.fallback.has(MODEL_KEY), true, `${label}: the next miss makes two`);
		}
	}
});

test("R9: with Pi's real Anthropic adapter, a refresh whose stream fails after reporting 120,000 written and none read is a miss", { skip: noCatalog }, async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	noNetwork(t);
	withRetention(t, "long");
	fresh({ compactBeforeExpiry: false });
	const real = claude();
	const sent = await adapterPayload(real, { maxTokens: 8192, cacheRetention: "long" }, systemAndUser);
	const events = [
		{ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: real.id, content: [], stop_reason: null, usage: { input_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 120_000, output_tokens: 1 } } },
		{ type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
	];
	const h = harness({ model: { ...real, cost: WITH_WRITE }, sent, stream: inMemory(real, "long", () => sse(events)), cached: 120_000 });
	h.emit("agent_settled");
	assert.deepEqual(h.decide(), { action: "stop" });
	await h.idle(3_420_000);
	await flush();
	const record = traces().find((r) => r.action === "failed");
	assert.ok(record?.usage, JSON.stringify(traces()));
	assert.deepEqual([record.usage.cacheRead, record.usage.cacheWrite], [0, 120_000]);
	// Writing 120,000 tokens costs more than the miss it was to avoid: warming ends on the budget, and it is a miss.
	assert.equal(record.stop, "budget");
	assert.equal(countOf("anthropic/claude-sonnet-4-6"), 1);
});

test("a successful refresh whose usage shows no prompt (omitted, or output only), through Pi's real Chat Completions and Responses adapters: what it cost is unknown, so warming ends for the period and it counts as a refresh without a hit; two in a row leave the model to Pi", { skip: noCatalog }, async (t) => {
	t.after(() => mock.timers.reset());
	noNetwork(t);
	withRetention(t, undefined);
	const completion = (usage?: Record<string, number>) =>
		sse([
			{ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "o" }, finish_reason: null }] },
			{ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...(usage ? { usage } : {}) },
			"[DONE]",
		]);
	const responses = (usage?: Record<string, number>) => {
		const item = { id: "m", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "o", annotations: [] }] };
		return sse([
			{ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "o" },
			{ type: "response.output_item.done", output_index: 0, item },
			{ type: "response.completed", response: { id: "r", object: "response", model: "m", status: "completed", output: [item], ...(usage ? { usage } : {}) } },
		]);
	};
	const cases: [string, string, string, () => Response][] = [
		["Kimi K3, usage omitted", "moonshotai", "kimi-k3", () => completion()],
		["Kimi K3, output only", "moonshotai", "kimi-k3", () => completion({ completion_tokens: 1 })],
		["GPT-6.1 Sol, usage omitted", "openai", "gpt-6.1-sol", () => responses()],
		["GPT-6.1 Sol, output only", "openai", "gpt-6.1-sol", () => responses({ output_tokens: 1 })],
	];
	for (const [label, provider, id, reply] of cases) {
		clock();
		fresh({ compactBeforeExpiry: false });
		const real = MODELS[provider][id];
		const model = { ...real, promptCache: undefined, cost: WITH_WRITE };
		const key = `${provider}/${id}`;
		misses(); // the store exists once a harness is made
		const sent = await adapterPayload(model, { maxTokens: 8192, cacheRetention: "short" }, systemAndUser);
		// A context that fits the window, so compacting when full stays out of it.
		const h = harness({ model, sent, stream: inMemory(model, "short", reply), ui: true, cached: 100_000 });
		const lifetime = provider === "openai" ? 1_800_000 : 300_000;
		h.emit("agent_settled");
		assert.deepEqual(h.decide(), { action: "stop" }, label);
		await h.idle(2 * lifetime);
		await flush();
		assert.equal(h.warms.length, 1, `${label}: no refresh after one whose cost is unknown`);
		const stops = traces().filter((r) => r.stop);
		assert.deepEqual(stops.map((r) => [r.action, r.stop, r.reason]), [["warm", "unknown", "the refresh reported no usage, so what it cost is unknown"]], label);
		assert.match(await h.command("cache-keeper"), /keep-warm ended \(a refresh reported no usage\): .*\(the refresh reported no usage, so what it cost is unknown\)/, label);
		assert.equal(countOf(key), 1, `${label}: counted as a refresh without a hit`);
		assert.equal(misses()?.fallback.size, 0, label);
		// The next period after a new real answer is owned again; its refresh also reports no usage: two in a row.
		mock.timers.tick(1000);
		h.run(true);
		assert.deepEqual(h.decide(), { action: "stop" }, `${label}: the next period`);
		await h.idle(lifetime);
		await flush();
		assert.equal(h.warms.length, 2, label);
		assert.equal(misses()?.fallback.has(key), true, `${label}: left to Pi`);
		assert.ok(
			h.notes.includes(`Two refreshes in a row without a hit for ${key} (neither reported what it cost), so pi-cache-keeper stopped keeping it warm; Pi's own warming takes over. /cache-keeper-warm starts it again.`),
			`${label}: warned`,
		);
		mock.timers.tick(1000);
		h.run(true);
		assert.equal(h.decide(), undefined, `${label}: the period after is Pi's`);
		mock.timers.reset();
	}
});

test("never a third paid miss: while a refresh of the model is on its way, from any session of the process, no other leaves; a slow one is never cancelled nor sent again; it stops holding back after 10 min", async (t) => {
	t.after(() => mock.timers.reset());
	// Another session's refresh of this model, sent 1 s ago and still open: this one is held until the last safe moment.
	clock();
	fresh({ compactBeforeExpiry: false });
	const held = harness({ lifetime: 300, cost: WITH_WRITE });
	misses()?.inFlight.set(MODEL_KEY, new Map([[-1, Date.now() - 1000]]));
	held.emit("agent_settled");
	assert.deepEqual(held.decide(), { action: "stop" });
	await held.idle(300_000);
	assert.equal(held.state.attempts, 0, "nothing leaves while it is open");
	assert.ok(traces().some((r) => r.action === "skip" && /an earlier refresh of this model has not settled yet/.test(r.reason)));
	assert.ok(traces().some((r) => r.action === "skip" && /^too late/.test(r.reason)), "then too late, as for any hold-up");
	// One sent more than 10 min ago no longer holds the model back.
	clock();
	fresh({ compactBeforeExpiry: false });
	const stale = harness({ lifetime: 300, cost: WITH_WRITE });
	misses()?.inFlight.set(MODEL_KEY, new Map([[-1, Date.now() - 10 * 60_000]]));
	stale.emit("agent_settled");
	await stale.idle(300_000);
	await flush();
	assert.equal(stale.warms.length, 1, "after 10 min it is no longer waited for");
	// A slow refresh settles when it settles: not cancelled, not sent again; once it reports a hit, the next one follows.
	clock();
	fresh({ compactBeforeExpiry: false });
	const slow = harness({ lifetime: 3600, cost: WITH_WRITE, hold: (n) => n === 1, model: NO_BREAKDOWN });
	slow.emit("agent_settled");
	await slow.idle(3_421_000);
	assert.equal(slow.warms.length, 1);
	for (let i = 0; i < 65; i++) {
		mock.timers.tick(1000);
		await flush();
	}
	assert.equal(slow.warms.length, 1, "nothing sent again while it is on its way");
	assert.equal(misses()?.inFlight.get(MODEL_KEY)?.size, 1, "still on its way after 65 s");
	assert.equal(traces().filter((r) => r.action === "cancelled").length, 0, "never cancelled for being slow");
	slow.release();
	await flush();
	assert.equal(misses()?.inFlight.has(MODEL_KEY), false, "settled");
	assert.equal(traces().filter((r) => r.action === "warm").length, 1, "it reported a hit");
	await slow.idle(3_600_000);
	await flush();
	assert.equal(slow.warms.length, 2, "the next refresh followed the hit");
});

test("prices in tiers count as prices: four zero base rates and a paid tier are counted in money at the request's size", async (t) => {
	t.after(() => mock.timers.reset());
	const tier = (cacheRead: number) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tiers: [{ inputTokensAbove: 100_000, input: 1, output: 15, cacheRead, cacheWrite: 1 }] });
	// The reviewer's shape: the tier prices a cached read like a write, so a refresh cannot save anything: Pi's.
	clock();
	fresh({ compactBeforeExpiry: false });
	const flat = harness({ lifetime: 300, cost: tier(1) as never });
	flat.emit("agent_settled");
	assert.equal(flat.decide(), undefined);
	assert.match(await flat.command("cache-keeper"), /left to Pi's own warming: at this model's prices a refresh costs as much as a miss/);
	await flat.idle(HOUR);
	assert.equal(flat.state.attempts, 0);
	// A tier with a discounted read: owned, with a money budget (not ten refreshes).
	clock();
	fresh({ compactBeforeExpiry: false });
	const discounted = harness({ lifetime: 300, cost: tier(0.1) as never });
	discounted.emit("agent_settled");
	assert.deepEqual(discounted.decide(), { action: "stop" });
	const line = (await discounted.command("cache-keeper")).split("\n").find((l) => l.startsWith("keep warm:"));
	assert.match(line ?? "", /so far \$0 spent, a miss costs \$0\.54/);
});

test("unpriced means no price at all: a model that charges only for output is counted in money, and left to Pi where a refresh costs as much as a miss", async (t) => {
	t.after(() => mock.timers.reset());
	clock();
	fresh({ compactBeforeExpiry: false });
	const outputOnly = harness({ lifetime: 300, cost: { input: 0, output: 15, cacheRead: 0, cacheWrite: 0 } });
	outputOnly.emit("agent_settled");
	assert.equal(outputOnly.decide(), undefined);
	assert.match(await outputOnly.command("cache-keeper"), /left to Pi's own warming: at this model's prices a refresh costs as much as a miss/);
	clock();
	fresh({ compactBeforeExpiry: false });
	const free = harness({ lifetime: 300 });
	free.emit("agent_settled");
	assert.deepEqual(free.decide(), { action: "stop" }, "no price at all: the ten-refresh allowance");
	assert.match(await free.command("cache-keeper"), /at most 10 refreshes/);
});

test("R8: the ordinary cases with Pi's real adapters and tools: Claude and Kimi K3, long and short; GPT-6.1 Sol owned at 30 min with either retention; GPT with the shared prefix left to Pi", { skip: noCatalog }, async (t) => {
	t.after(() => mock.timers.reset());
	noNetwork(t);
	const cases: [string, string, "long" | "short", number | undefined][] = [
		["anthropic", "claude-sonnet-4-6", "long", 3_421_000],
		["anthropic", "claude-sonnet-4-6", "short", 276_000],
		["moonshotai", "kimi-k3", "long", 3_421_000],
		["moonshotai", "kimi-k3", "short", 276_000],
		["openai", "gpt-6.1-sol", "short", 1_711_000],
		// With Pi's tools first in the request, GPT-6.1 Sol gets no shared prefix: owned at 30 min (without tools: Pi's).
		["openai", "gpt-6.1-sol", "long", 1_711_000],
		["openai", "gpt-5.6-cyber", "long", undefined],
	];
	for (const [provider, id, retention, at] of cases) {
		withRetention(t, retention === "long" ? "long" : undefined);
		clock();
		fresh({ compactBeforeExpiry: false });
		const real = MODELS[provider][id];
		// Pi's catalog as it is: the lifetime from the model's data or the provider's own rule.
		const model = { ...real, promptCache: real.promptCache, cost: WITH_WRITE };
		const sent = await adapterPayload(model, { maxTokens: 8192, cacheRetention: retention }, systemAndUser);
		const h = harness({ model, sent, stream: viaRealAdapter(model) });
		const label = `${id} ${retention}`;
		if (at === undefined) {
			h.emit("agent_settled");
			assert.equal(h.decide(), undefined, label);
			assert.match(await h.command("cache-keeper"), /the request carries more than one cache lifetime/, label);
		} else assert.equal(await ownedRefresh(h), at, label);
	}
});

test("no file imports evaluateCacheWarming (missing before pi-ai 1.5.1)", () => {
	const root = new URL("..", import.meta.url);
	const files = [...readdirSync(root).filter((name) => name.endsWith(".ts")).map((name) => new URL(name, root)), ...readdirSync(new URL("tests/", root)).filter((name) => name.endsWith(".ts")).map((name) => new URL(`tests/${name}`, root))];
	assert.ok(files.length > 10);
	for (const file of files) assert.doesNotMatch(readFileSync(file, "utf8"), /^\s*import\s[^;]*\bevaluateCacheWarming\b/m, file.pathname);
});

// At exit rather than in a root after-hook: that hook can run while a test still awaits a real adapter.
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

// ------------------------------------------------- the footer: only what the extension read, and only for this model

const lastFooter = (h: ReturnType<typeof harness>) => h.statuses.at(-1)?.text;
// The retention Pi asks for, for one test: Pi's short default, as the reviewer's cases ran with.
const shortRetention = (t: { after: (fn: () => void) => void }) => {
	const before = process.env.PI_CACHE_RETENTION;
	delete process.env.PI_CACHE_RETENTION;
	t.after(() => {
		if (before === undefined) delete process.env.PI_CACHE_RETENTION;
		else process.env.PI_CACHE_RETENTION = before;
	});
};

test("footer: a request whose cache markers the extension does not read (Bedrock's cachePoint) says nothing of what was sent", async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	online(t);
	fresh();
	// Claude on Bedrock asks for the one-hour cache twice, in Bedrock's own form; the answer reports a one-hour write.
	const cachePoint = { cachePoint: { type: "default", ttl: "1h" } };
	const sent = { modelId: "us.anthropic.claude-sonnet-5-5", system: [{ text: "s" }, cachePoint], messages: [{ role: "user", content: [{ text: "hi" }, cachePoint] }], inferenceConfig: { maxTokens: 8192 } };
	const h = harness({
		ui: true,
		cost: WITH_WRITE,
		model: { provider: "amazon-bedrock", id: "us.anthropic.claude-sonnet-5-5", api: "bedrock-converse-stream", promptCache: { short: 300, long: 3600 } },
		sent,
		answer: { cacheWrite: 1, cacheWrite1h: 1 },
	});
	h.emit("agent_settled");
	// It said "⚠ sent default cache" before.
	assert.equal(lastFooter(h), "cache warm · 60m left · keep-warm: Pi's (bedrock-converse-stream not re-sent) · long 1h (in use) · short 5m · api $3/$15 per M");
});

test("footer: after a model switch, the new model's lifetimes and price, and nothing in use or sent until it makes a request", async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	online(t);
	shortRetention(t);
	fresh();
	// Claude with the one-hour cache, kept warm by the extension.
	const sent = { model: "claude", max_tokens: 64_000, system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", ttl: "1h" } }], messages: [{ role: "user", content: "hi" }], thinking: { type: "adaptive" } };
	const h = harness({ ui: true, cost: WITH_WRITE, sent });
	h.emit("agent_settled");
	// The retention in force is Pi's short default, so the request's hour is said against it.
	// Kept warm by the extension (keep-warm 2 h): the goal, until when, and its budget.
	assert.equal(lastFooter(h), `cache warm · 60m left · keep-warm 2h until ${clockText(Date.now() + 2 * HOUR)}, $0 spent of $2.07 · long 1h (in use) · short 1h · sent 1h (retention short) · api $3/$15 per M`);
	const gemini = { provider: "google", id: "gemini-3.8-pro", api: "google-generative-ai", contextWindow: 1_000_000, maxTokens: 64_000, cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 } };
	h.ctx.model = gemini as never;
	h.emit("model_select");
	// It said "long 1h (in use) · short unknown · api $1.25/$10 per M" before.
	// Keep-warm is still on and set to 2 h: said as the setting, nothing about a period this model has not started.
	assert.equal(lastFooter(h), "keep-warm 2h · cache lifetime unknown · api $1.25/$10 per M");
	// A model with lifetimes of its own: both shown, neither in use.
	h.ctx.model = { ...gemini, id: "gemini-3.8-cached", promptCache: { short: 300, long: 3600 } } as never;
	h.emit("model_select");
	assert.equal(lastFooter(h), "keep-warm 2h · short 5m · long 1h · api $1.25/$10 per M");
	// Back on Claude, which has answered in this session: the request was forgotten with the switch, so the extension
	// can't refresh the period any more: it is Pi's, and the tier in use is still the one the period's request asked for
	// (the stated hour), with the lifetime its clock counts.
	h.ctx.model = h.model as never;
	h.emit("model_select");
	assert.equal(lastFooter(h), "keep-warm: Pi's (request let go) · long 1h (in use) · short 1h · api $3/$15 per M");
	assert.equal(h.decide(), undefined, "Pi's warming decides");

	// A period left to Pi is said for its own model only.
	fresh();
	const left = harness({ ui: true, cost: WITH_WRITE, thinking: { type: "enabled", budget_tokens: 1024 } });
	left.emit("agent_settled");
	assert.match(lastFooter(left)!, /^cache warm · 60m left · keep-warm: Pi's \(thinking on\) · /);
	left.ctx.model = gemini as never;
	left.emit("model_select");
	assert.equal(lastFooter(left), "keep-warm 2h · cache lifetime unknown · api $1.25/$10 per M");
});

test("footer: a countdown counted from another model's answer is said to be so, also where the current model has made no request yet, after a switch and after /reload; not for the same model, nor during a run", async (t) => {
	t.after(() => mock.timers.reset());
	online(t);
	withRetention(t, "long");
	const kimi = { provider: "moonshotai", id: "kimi-k3", api: "openai-completions", baseUrl: "https://api.moonshot.ai/v1", promptCache: { short: 300, long: 3600 }, cost: WITH_WRITE, contextWindow: 1_000_000, maxTokens: 64_000 };
	for (const keepWarmMinutes of [0, 120]) {
		clock();
		fresh({ keepWarmMinutes });
		// A Claude answer at the 1-hour cache; then a switch to Kimi K3, which has made no request.
		const h = harness({ ui: true, cost: WITH_WRITE, model: { provider: "anthropic", id: "claude-sonnet-4-6", promptCache: { short: 300, long: 3600 } } });
		h.emit("agent_settled");
		assert.doesNotMatch(lastFooter(h) ?? "", /another model's/, `${keepWarmMinutes}: the same model`);
		h.ctx.model = kimi as never;
		h.emit("model_select");
		mock.timers.tick(1000);
		// The switch itself stops the countdown; where one is shown, it says whose it is.
		assert.ok(!/^cache warm/.test(lastFooter(h) ?? "") || /another model's/.test(lastFooter(h) ?? ""), `${keepWarmMinutes}: after the switch`);
		// /reload, /resume, /fork: the extension starts the session again with the same branch.
		h.emit("session_start", { reason: "reload" });
		mock.timers.tick(1000);
		const pi = keepWarmMinutes > 0 ? " · keep-warm: Pi's (request not seen)" : "";
		assert.equal(lastFooter(h), `cache warm · 59m left · ⚠ countdown on another model's long tier${pi} · short 5m · long 1h · api $3/$15 per M`, `${keepWarmMinutes}: after /reload`);
		// During a run, no countdown is said, nor the warning.
		h.state.idle = false;
		h.emit("agent_start");
		assert.doesNotMatch(lastFooter(h) ?? "", /another model's/, `${keepWarmMinutes}: during a run`);
		h.state.idle = true;
		mock.timers.reset();
	}
});

test("footer: an aborted answer that read the cache is not the one the countdown counts from, so the other-model warning follows the answer it does count from", async (t) => {
	t.after(() => mock.timers.reset());
	online(t);
	shortRetention(t);
	const kimi = { provider: "moonshotai", id: "kimi-k3", api: "openai-completions", baseUrl: "https://api.moonshot.ai/v1", promptCache: { short: 300, long: 3600 } };
	const claude = { provider: "anthropic", id: "claude-sonnet-4-6", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", promptCache: { short: 300, long: 3600 }, cost: WITH_WRITE, contextWindow: 1_000_000, maxTokens: 64_000 };
	for (const keepWarmMinutes of [0, 120]) {
		clock();
		fresh({ keepWarmMinutes, compactBeforeExpiry: false });
		// A Kimi answer at the short cache; then Claude, whose answer read the cache and was interrupted.
		const h = harness({ ui: true, cost: WITH_WRITE, model: kimi, cached: 120_000 });
		h.emit("agent_settled");
		mock.timers.tick(10_000);
		h.ctx.model = claude as never;
		h.emit("model_select");
		const aborted = { role: "assistant", content: [], timestamp: Date.now(), stopReason: "aborted", provider: claude.provider, model: claude.id, usage: { input: 2, output: 0, cacheRead: 120_000, cacheWrite: 0 } };
		h.branch.push({ type: "message", id: "claude-aborted", parentId: null, timestamp: new Date().toISOString(), message: aborted } as never);
		h.emit("session_start", { reason: "reload" });
		mock.timers.tick(1000);
		// The countdown is Kimi's answer's: said beside it while Claude is selected.
		assert.match(lastFooter(h) ?? "", /^cache warm · \d+m left · ⚠ countdown on another model's \w+ tier · /, `${keepWarmMinutes}: Claude selected`);
		h.ctx.model = { ...h.model } as never;
		h.emit("model_select");
		h.emit("session_start", { reason: "reload" });
		mock.timers.tick(1000);
		assert.match(lastFooter(h) ?? "", /^cache warm · \d+m left · /, `${keepWarmMinutes}: back on Kimi`);
		assert.doesNotMatch(lastFooter(h) ?? "", /another model's/, `${keepWarmMinutes}: back on Kimi, its own answer's countdown`);
		mock.timers.reset();
	}
});

test("footer: with keep-warm off, a countdown on another model's tier is said to be so, beside the model's own tier", async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	online(t);
	shortRetention(t);
	fresh({ keepWarmMinutes: 0 });
	// An earlier model wrote the one-hour cache; then Kimi K3, whose answers report no tier, at the short tier Pi asks for.
	const earlier = {
		type: "message",
		id: "e",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: { role: "assistant", content: [], provider: "claude-bridge", model: "bridge-claude", timestamp: 0, stopReason: "stop", usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 600_000, cacheWrite1h: 600_000 } },
	};
	const h = harness({
		ui: true,
		cost: WITH_WRITE,
		before: [earlier],
		model: { provider: "moonshotai", id: "kimi-k3", api: "openai-completions", baseUrl: "https://api.moonshot.ai/v1", promptCache: { short: 300, long: 3600 } },
		sent: { model: "kimi-k3", max_tokens: 8192, messages: [{ role: "user", content: "hi" }] },
	});
	h.emit("agent_settled");
	// The countdown itself is unchanged (it counts the long tier the earlier model reported, as the released version
	// does); the footer no longer puts it beside Kimi's short tier as if they were one. It said
	// "cache warm · 60m left · short 5m (in use) · long 1h · sent default cache · api $3/$15 per M" before.
	assert.equal(lastFooter(h), "cache warm · 60m left · ⚠ countdown on another model's long tier · short 5m (in use) · long 1h · sent default cache · api $3/$15 per M");
	// Without the earlier model's write, the same session reads as one.
	fresh({ keepWarmMinutes: 0 });
	const alone = harness({ ui: true, cost: WITH_WRITE, model: { provider: "moonshotai", id: "kimi-k3", api: "openai-completions", baseUrl: "https://api.moonshot.ai/v1", promptCache: { short: 300, long: 3600 } }, sent: { model: "kimi-k3", max_tokens: 8192, messages: [{ role: "user", content: "hi" }] } });
	alone.emit("agent_settled");
	assert.equal(lastFooter(alone), "cache warm · 5m left · short 5m (in use) · long 1h · sent default cache · api $3/$15 per M");
});

// ---------------------------------------------------- the footer: "sent" says what the request stated, and warns only on a difference

const retentionFor = (t: { after: (fn: () => void) => void }, value: "short" | "long") => {
	const before = process.env.PI_CACHE_RETENTION;
	if (value === "long") process.env.PI_CACHE_RETENTION = "long";
	else delete process.env.PI_CACHE_RETENTION;
	t.after(() => {
		if (before === undefined) delete process.env.PI_CACHE_RETENTION;
		else process.env.PI_CACHE_RETENTION = before;
	});
};
// A Claude request with one cache_control, with or without a stated ttl.
const claudeSent = (ttl?: string) => ({ model: "claude", max_tokens: 64_000, system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", ...(ttl ? { ttl } : {}) } }], messages: [{ role: "user", content: "hi" }], thinking: { type: "adaptive" } });
const anthropicApi = { provider: "anthropic", id: "claude-sonnet-5-5", promptCache: { short: 300, long: 3600 } };
// /reload (or /resume, /fork) as Pi does it: the old instance shuts down and a new one starts the session on the same
// branch, without the request the old one saw. Pi's retention marker, which the new instance sets, is restored after.
function reload(h: ReturnType<typeof harness>, t: { after: (fn: () => void) => void }) {
	const marker = process.env.PI_CACHE_KEEPER_RETENTION;
	t.after(() => {
		if (marker === undefined) delete process.env.PI_CACHE_KEEPER_RETENTION;
		else process.env.PI_CACHE_KEEPER_RETENTION = marker;
	});
	h.emit("session_shutdown");
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	cacheKeeper({
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
		registerEntryRenderer: () => {},
		events: { on: () => () => {}, emit: () => {} },
		registerCommand: () => {},
		appendEntry: () => {},
		getThinkingLevel: () => "high",
	} as never);
	handlers.get("session_start")?.({ reason: "reload" }, h.ctx);
	t.after(() => handlers.get("session_shutdown")?.({}, h.ctx));
}

test("footer: a route whose short tier lasts an hour, the request asking for the short tier: short is in use, no warning, also after /reload", async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	online(t);
	retentionFor(t, "short");
	fresh({ keepWarmMinutes: 0, cacheRetention: "short", modelData: false });
	// The request states no lifetime; the answer reports the one-hour write, which is this route's short tier.
	const h = harness({ ui: true, sent: claudeSent(), answer: { cacheWrite: 1, cacheWrite1h: 1 } });
	Object.assign(h.ctx.modelRegistry, { isUsingOAuth: () => true, getProvider: () => ({ auth: { oauth: { isSubscription: true } } }) });
	h.emit("agent_settled");
	// 0.5.1 said "cache warm · 60m left · long 1h (in use) · short 1h · sent short · sub, no per-token price".
	assert.equal(lastFooter(h), "cache warm · 60m left · short 1h (in use) · long 1h · sent short · sub, no per-token price");
	h.state.idle = false;
	h.emit("agent_start");
	// 0.5.0 said "cache in use · long 1h (in use) · short 1h · ⚠ sent 5m · sub, no per-token price".
	assert.equal(lastFooter(h), "cache in use · short 1h (in use) · long 1h · sent short · sub, no per-token price");
	h.state.idle = true;
	h.emit("agent_settled");
	// /reload: the request is gone; both tiers last an hour here, so the retention in force (short) is the one in use.
	reload(h, t);
	assert.equal(lastFooter(h), "cache warm · 60m left · short 1h (in use) · long 1h · sub, no per-token price");
});

// The third review's footer: a route whose short tier lasts an hour, kept warm by the extension; its refresh at 3,421 s
// reads 95% and writes the rest into the five-minute cache (the gateway fell back to an API key), so the period is Pi's
// and its cache counts five minutes from that refresh. The countdown, the lifetime in use and "sent" say the same five
// minutes (it said "short 1h (in use)" beside "4m left").
test("footer: after a hand-over to a five-minute write, the countdown, the lifetime in use, what was sent and /cache-keeper say five minutes", async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	online(t);
	shortRetention(t);
	fresh({ compactBeforeExpiry: false, modelData: false, keepWarmMinutes: 240 });
	const h = harness({ lifetime: 3600, cost: WITH_WRITE, ui: true, sent: plainMarker, answer: CONFIRMING_HOUR, respond: () => ({ usage: { cacheRead: 570_000, cacheWrite: 30_000, cacheWrite1h: 0 } }) });
	h.emit("agent_settled");
	await h.idle(3_430_000);
	await flush();
	assert.deepEqual(refreshesOf(h).map((w) => w.at), [3_421_000]);
	const left = formatRemaining(3_721_000 - Date.now());
	assert.equal(lastFooter(h), `cache warm · ${left} left · keep-warm: Pi's (the refresh wrote otherwise) · short 5m (in use) · long 1h · ⚠ sent short · api $3/$15 per M`);
	assert.match(await h.command("cache-keeper"), new RegExp(`\ncache: ${left} left \\(lifetime 5 min, the shortest lifetime read since\\)\n`));
});

test("footer, sent: Anthropic's API, retention short (the short tier, 5 minutes on the route) and long (the stated hour)", async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	online(t);
	retentionFor(t, "short");
	fresh({ keepWarmMinutes: 0, cacheRetention: "short", modelData: false });
	const short = harness({ ui: true, cost: WITH_WRITE, model: anthropicApi, sent: claudeSent(), answer: { cacheWrite: 1, cacheWrite1h: 0 } });
	short.emit("agent_settled");
	// 0.5.0 said "sent 5m": a lifetime the request does not state.
	assert.equal(lastFooter(short), "cache warm · 5m left · short 5m (in use) · long 1h · sent short · api $3/$15 per M");
	// After /reload only the 5 minutes the countdown runs on tell the tier: the short one, as before.
	reload(short, t);
	assert.equal(lastFooter(short), "cache warm · 5m left · short 5m (in use) · long 1h · api $3/$15 per M");
	// Restored after the test by the retentionFor above.
	process.env.PI_CACHE_RETENTION = "long";
	fresh({ keepWarmMinutes: 0, modelData: false });
	const long = harness({ ui: true, cost: WITH_WRITE, model: anthropicApi, sent: claudeSent("1h"), answer: { cacheWrite: 1, cacheWrite1h: 1 } });
	long.emit("agent_settled");
	assert.equal(lastFooter(long), "cache warm · 60m left · long 1h (in use) · short 5m · sent 1h · api $3/$15 per M");
	reload(long, t);
	assert.equal(lastFooter(long), "cache warm · 60m left · long 1h (in use) · short 5m · api $3/$15 per M");
});

test("footer, sent: a stated lifetime the provider did not write is a difference, said with a warning", async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	online(t);
	retentionFor(t, "long");
	fresh({ keepWarmMinutes: 0, modelData: false });
	// The request states an hour; the answer reports a 5-minute write, so the countdown runs on 5 minutes: the 5-minute
	// tier is what is in use, said truthfully, and the request's hour is a difference.
	const h = harness({ ui: true, cost: WITH_WRITE, model: anthropicApi, sent: claudeSent("1h"), answer: { cacheWrite: 1, cacheWrite1h: 0 } });
	h.emit("agent_settled");
	assert.equal(lastFooter(h), "cache warm · 5m left · short 5m (in use) · long 1h · ⚠ sent 1h · api $3/$15 per M");
	// After /reload the request is not known: the 5 minutes in use are the short tier's; nothing to warn about.
	reload(h, t);
	assert.equal(lastFooter(h), "cache warm · 5m left · short 5m (in use) · long 1h · api $3/$15 per M");
});

test("footer: a subscription login shows the prices the extension counts with; without any, no per-token price", async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	online(t);
	retentionFor(t, "long");
	fresh({ keepWarmMinutes: 0, modelData: false });
	const login = { isUsingOAuth: () => true, getProvider: () => ({ auth: { oauth: { isSubscription: true } } }) };
	// Claude on a subscription login, with the model's prices (Pi's catalog, providers.dev or your own).
	const priced = harness({ ui: true, cost: WITH_WRITE, model: anthropicApi, sent: claudeSent("1h"), answer: { cacheWrite: 1, cacheWrite1h: 1 } });
	Object.assign(priced.ctx.modelRegistry, login);
	priced.emit("agent_settled");
	// 0.5.1 said "… · sent 1h · sub, no per-token price".
	assert.equal(lastFooter(priced), "cache warm · 60m left · long 1h (in use) · short 5m · sent 1h · sub, counted at $3/$15 per M");
	// A model priced at $0 has none.
	fresh({ keepWarmMinutes: 0, modelData: false });
	const free = harness({ ui: true, cost: NO_PRICES, model: anthropicApi, sent: claudeSent("1h"), answer: { cacheWrite: 1, cacheWrite1h: 1 } });
	Object.assign(free.ctx.modelRegistry, login);
	free.emit("agent_settled");
	assert.equal(lastFooter(free), "cache warm · 60m left · long 1h (in use) · short 5m · sent 1h · sub, no per-token price");
});

// ------------------------------------------------------------------------------- the footer: the keep-warm goal

test("footer: keep-warm's goal, with the time it runs to and the budget, while the extension keeps the period warm; nothing with keep-warm off", async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	online(t);
	shortRetention(t);
	const values = " · short 5m (in use) · long 5m · sent default cache · api $3/$15 per M";
	// Keep-warm off: nothing about it.
	fresh({ keepWarmMinutes: 0, modelData: false });
	const off = harness({ ui: true, lifetime: 300, cost: WITH_WRITE });
	off.emit("agent_settled");
	assert.equal(lastFooter(off), `cache warm · 5m left${values}`);
	// On (2 h), waiting for the first refresh: the goal, until when (Pi went idle at the answer), nothing spent yet.
	clock();
	fresh({ modelData: false });
	const h = harness({ ui: true, lifetime: 300, cost: WITH_WRITE });
	h.emit("agent_settled");
	const until = clockText(Date.now() + 2 * HOUR);
	assert.equal(lastFooter(h), `cache warm · 5m left · keep-warm 2h until ${until}, $0 spent of $2.07${values}`);
	// After a refresh: what it cost, and the countdown starts again.
	await h.idle(280_000);
	await flush();
	assert.equal(h.warms.length, 1);
	// The refresh went out 25 s before expiry, 5 s ago: the countdown started again from it.
	assert.equal(lastFooter(h), `cache warm · 4m left · keep-warm 2h until ${until}, $0.18 spent of $2.07${values}`);
	// During a run the extension keeps nothing warm: the setting only.
	h.state.idle = false;
	h.emit("agent_start");
	assert.equal(lastFooter(h), `cache in use · keep-warm 2h${values}`);
});

test("footer: keep-warm's goal on a model without prices counts refreshes; a period left to Pi still says so, without the goal", async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	online(t);
	shortRetention(t);
	fresh({ modelData: false });
	const h = harness({ ui: true, lifetime: 300, cost: NO_PRICES });
	h.emit("agent_settled");
	const until = clockText(Date.now() + 2 * HOUR);
	const values = " · short 5m (in use) · long 5m · sent default cache · api, price unknown";
	assert.equal(lastFooter(h), `cache warm · 5m left · keep-warm 2h until ${until}, 0 of 10 refreshes${values}`);
	await h.idle(280_000);
	await flush();
	assert.equal(lastFooter(h), `cache warm · 4m left · keep-warm 2h until ${until}, 1 of 10 refreshes${values}`);
	// Left to Pi (a request with thinking on): the existing text, no goal.
	clock();
	fresh({ modelData: false });
	const left = harness({ ui: true, lifetime: 300, cost: WITH_WRITE, thinking: { type: "enabled", budget_tokens: 1024 } });
	left.emit("agent_settled");
	assert.equal(lastFooter(left), "cache warm · 5m left · keep-warm: Pi's (thinking on) · short 5m (in use) · long 5m · sent default cache · api $3/$15 per M");
});
