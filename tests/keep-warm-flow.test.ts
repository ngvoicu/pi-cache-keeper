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

const HOUR = 3_600_000;
const flush = () => new Promise((resolve) => setImmediate(resolve));

// Prices per million tokens: Claude-like with a cache-write price, GPT-like without one, and a subscription login.
const WITH_WRITE = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const WITHOUT_WRITE = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 };
const NO_PRICES = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
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
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
		registerEntryRenderer: () => {},
		events: { on: () => () => {}, emit: () => {} },
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
	const state = { compacts: 0, compactedAt: 0, idle: true, pending: false, abortReports: true, attempts: 0, beforePayload: undefined as (() => void) | undefined };
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
									options2.signal.addEventListener("abort", () => resolve({ stopReason: "aborted", usage: state.abortReports ? usage : refreshUsage({ input: 0, output: 0, cacheRead: 0 }) }));
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
			request([user, message], { ...sent, messages: [...sent.messages, { role: "user", content: `more ${runs}` }] }, reply2);
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
	return { emit, idle, warms, state, sent, model, branch, statuses, notes, command, decide, run, usage: refreshUsage, ctx, thinkingLevel, release: () => pending?.() };
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
	assert.ok(h.warms.length >= 1, "the extension refreshes for the expiry Pi's refresh moved");
	assert.equal(h.warms[0].at, 546_000, "25 s before the new expiry (Pi's refresh at 271 s moved it to 571 s)");
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
	const { emit, warms, state, sent } = harness();
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
			const { emit, idle, warms, state } = harness({ lifetime, cost });
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
	// without a reported cost the reserve stays counted, and the period goes on from there.
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
	assert.equal(cancelled.stop, undefined, "an abort by a real request ends nothing");
});

test("R3: an error or an abort leaves the reported cost, or else the reserve, in what was spent", async (t) => {
	t.after(() => mock.timers.reset());
	for (const [reports, spent] of [
		[true, REPORTED],
		[false, EXPECTED],
	] as const) {
		// An error: warming ends ("failed").
		clock();
		fresh({ compactBeforeExpiry: false });
		let h = harness({ lifetime: 300, cost: WITH_WRITE, respond: () => ({ stopReason: "error", errorMessage: "stream broke", usage: reports ? {} : { input: 0, output: 0, cacheRead: 0 } }) });
		h.emit("agent_settled");
		await h.idle(HOUR);
		assert.equal(h.warms.length, 1);
		const failed = traces().find((r) => r.action === "failed");
		assert.equal(failed.reason, "stream broke");
		assert.equal(failed.stop, "failed");
		assert.ok(near(failed.budget.spent, spent));
		assert.equal(failed.usage?.cost, reports ? REPORTED : undefined);

		// An abort by a run that sent nothing: counted, nothing ends, and the next refresh goes on from there.
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
		await h.idle(HOUR);
		const next = traces().find((r) => r.action === "warm");
		assert.equal(next.event, "warm");
		assert.deepEqual(h.warms.map((w) => w.at).slice(0, 2), [276_000, 282_000], "the refresh for that expiry is tried again once Pi is idle (on the tick after the abort settled)");
		assert.ok(near(next.budget.spent, spent + REPORTED), "the run that sent nothing did not reset it");
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
	r = await ended({ lifetime: 3600, cost: WITH_WRITE });
	assert.deepEqual([r.stop.action, r.stop.stop, r.h.warms.length], ["warm", "limit", 2]);
	assert.equal(r.footer, `cache warm · 60m left · keep-warm ended (2 h limit): $0.36 spent, a miss costs $2.07${values("1h")}`);
	r = await ended({ lifetime: 3600, cost: WITH_WRITE }, undefined, 30);
	assert.deepEqual([r.stop.action, r.stop.stop, r.h.warms.length], ["skip", "limit", 0]);
	assert.equal(r.stop.idleMinutes, 0, "recorded when the period starts");
	assert.equal(r.footer, `cache warm · 60m left · keep-warm ended (30 min limit): $0 spent, a miss costs $2.07${values("1h")}`);

	// missed: a refresh read under 90% from the cache.
	r = await ended({ lifetime: 300, cost: WITH_WRITE, respond: () => ({ usage: { cacheRead: 300_000, cacheWrite: 300_000 } }) });
	assert.deepEqual([r.stop.action, r.stop.stop, r.h.warms.length], ["missed", "missed", 1]);
	assert.equal(r.stop.reason, "the refresh read only 49% from the cache, so it wrote the context again");
	// Something gone wrong is marked, right after the countdown.
	assert.equal(r.footer, `cache warm · 5m left · ⚠ keep-warm ended (a refresh missed the cache): $1.22 spent, a miss costs $2.07${values("5m")}`);

	// failed: a refresh ended in an error.
	r = await ended({ lifetime: 300, cost: WITH_WRITE, respond: () => ({ stopReason: "error", errorMessage: "overloaded" }) });
	assert.deepEqual([r.stop.action, r.stop.stop, r.h.warms.length], ["failed", "failed", 1]);
	assert.equal(r.footer, `cache warm · 0:25 left · ⚠ keep-warm ended (a refresh failed): $0.18 spent, a miss costs $2.07${values("5m")}`);

	// unable: the cached path no longer checks out (a branch move made the extension forget the request). Pi's
	// decisions are still answered by the period's facts.
	r = await ended({ lifetime: 300, cost: WITH_WRITE }, async (h) => {
		await h.idle(200_000);
		h.emit("session_tree");
	});
	assert.deepEqual([r.stop.action, r.stop.stop, r.h.warms.length], ["skip", "unable", 0]);
	assert.match(r.stop.reason, /^no request since the session started or compacted, or since the model or branch changed/);
	// The branch move forgot the request, so the footer no longer says what was sent.
	assert.equal(r.footer, "cache warm · 0:24 left · ⚠ keep-warm ended (the request can't be re-sent): $0 spent, a miss costs $2.07 · short 5m (in use) · long 5m · api $3/$15 per M");
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

test("R7/2: a lifetime that reads differently during a period ends warming (unable) without another refresh", async (t) => {
	t.after(() => mock.timers.reset());
	const saved = process.env.PI_CACHE_RETENTION;
	t.after(() => (saved === undefined ? delete process.env.PI_CACHE_RETENTION : (process.env.PI_CACHE_RETENTION = saved)));
	delete process.env.PI_CACHE_RETENTION;
	const cases: [string, (h: ReturnType<typeof harness>) => void, RegExp][] = [
		// The model's declared lifetime for the request's tier changed (new model data).
		["model data changed", (h) => (h.model.promptCache = { short: 3600, long: 3600 }), /^the cache lifetime now reads 60 min, the cached request was written with 5 min$/],
		// A proxy said another upstream answered, whose lifetime is unknown.
		["lifetime unknown", (h) => delete h.model.promptCache, /^the cache lifetime is now unknown, the cached request was written with 5 min$/],
		// The declared lifetime fell from 300 s to 30 s.
		["lifetime lowered", (h) => (h.model.promptCache = { short: 30, long: 30 }), /^the cache lifetime now reads 30 s, the cached request was written with 5 min$/],
	];
	for (const [label, change, reason] of cases) {
		clock();
		fresh({ compactBeforeExpiry: false });
		delete process.env.PI_CACHE_RETENTION;
		const h = harness({ lifetime: 300, cost: WITH_WRITE, model: { promptCache: { short: 300, long: 3600 } } });
		h.emit("agent_settled");
		await h.idle(60_000);
		change(h);
		await h.idle(2 * HOUR);
		assert.equal(h.state.attempts, 0, `${label}: no refresh`);
		const stops = traces().filter((r) => r.stop);
		assert.equal(stops.length, 1, label);
		assert.equal(stops[0].stop, "unable");
		assert.match(stops[0].reason, reason);
		assert.equal(stops[0].lifetimeSeconds, 300, "logged with the period's lifetime");
		assert.deepEqual(h.decide(), { action: "stop" }, "Pi stays as it is for the period");
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

test("R7/3: Pi's refresh during a long answer, appended before it, counts: the extension refreshes before the cache expires", async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	fresh({ compactBeforeExpiry: false });
	const h = harness({ lifetime: 300, cost: WITH_WRITE });
	h.emit("agent_settled");
	await h.idle(100_000);
	// A run at 101 s: Pi refreshes the new request at 371 s while the answer streams; the answer, timestamped when it
	// started (101 s), is appended when it ends, at 420 s, after Pi's cache_warm entry.
	h.state.idle = false;
	h.emit("agent_start");
	const ask = { role: "user", content: [{ type: "text", text: "go" }], timestamp: Date.now() };
	const payload = { ...h.sent, messages: [...h.sent.messages, { role: "user", content: "go" }] };
	h.branch.push({ type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(), message: ask } as never);
	h.emit("context_with_system", { messages: [ask] });
	h.emit("before_provider_request", { payload });
	const answer = { role: "assistant", content: [{ type: "text", text: "long" }], timestamp: Date.now(), stopReason: "stop", provider: h.model.provider, model: h.model.id, usage: { input: 2, output: 5, cacheRead: 600_000, cacheWrite: 0 } };
	mock.timers.tick(270_000);
	h.ctx.sessionManager.appendUsage("cache_warm", h.model.provider, h.model.id, h.usage());
	mock.timers.tick(49_000);
	h.emit("message_end", { message: answer });
	h.branch.push({ type: "message", id: "a1", parentId: null, timestamp: new Date().toISOString(), message: answer } as never);
	h.state.idle = true;
	h.emit("agent_settled");
	await h.idle(400_000);
	assert.equal(h.warms[0]?.at, 646_000, "25 s before 671 s, the expiry Pi's 371-s refresh set");
	assert.deepEqual(h.warms[0].payload, { ...payload, max_tokens: 1 });
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
		["the proxy's upstream now has no lifetime", (h) => delete h.model.promptCache, /^the cache lifetime is now unknown, the cached request was written with 5 min$/],
		["keepWarmMinutes set to 0", () => settings({ keepWarmMinutes: 0, minContextTokens: 100_000, compactBeforeExpiry: false }), /^keep-warm was turned off$/],
	];
	for (const [label, change, reason] of cases) {
		clock();
		fresh({ compactBeforeExpiry: false });
		const h = harness({ lifetime: 300, cost: WITH_WRITE });
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
		// The model's own answer now reports a 1-hour write; both tiers declare 5 min, so only the tier differs.
		["the tier changed", (h) => h.branch.splice(1, 0, { type: "message", id: "x", parentId: null, timestamp: new Date(500).toISOString(), message: own(h, { input: 1, output: 1, cacheRead: 0, cacheWrite: 10, cacheWrite1h: 10 }) } as never)],
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
		// While a run is active /cache-keeper shows no amounts; otherwise it shows what the period has spent.
		if (label !== "the refresh was cancelled") {
			assert.match((await h.command("cache-keeper")).match(/keep warm: .*/)?.[0] ?? "", /^keep warm: (off|.*\$0 spent.*)$/, `${label}: nothing counted`);
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

test("R8: an answer that reports cache writes in both tiers, or in the other one, is Pi's", async (t) => {
	t.after(() => mock.timers.reset());
	withRetention(t, "long");
	const oneHour = { model: "claude", max_tokens: 64_000, system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", ttl: "1h" } }], messages: [{ role: "user", content: "hi" }], thinking: { type: "adaptive" } };
	const cases: [string, Record<string, unknown> | undefined, Record<string, number>, RegExp][] = [
		["both tiers", oneHour, { cacheWrite: 120_000, cacheWrite1h: 8_000 }, /the answer reports cache writes in both tiers/],
		["the 5-minute tier for a 1-hour request", oneHour, { cacheWrite: 120_000, cacheWrite1h: 0 }, /the answer reports cache writes in the short tier, the request asked for the long one/],
		["the 1-hour tier for a request with no marker", undefined, { cacheWrite: 120_000, cacheWrite1h: 120_000 }, /the answer reports cache writes in the long tier, the request asked for the short one/],
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
const WARNING = `Two refreshes in a row missed the cache for ${MODEL_KEY}, so pi-cache-keeper stopped keeping it warm; Pi's own warming takes over. /cache-keeper-warm starts it again.`;
const FALLBACK_STATUS = "⚠ keep-warm: Pi's after 2 missed refreshes (/cache-keeper-warm)";
const fallbackLineAt = (at: number, model = MODEL_KEY) =>
	`two refreshes in a row missed the cache for ${model} (the last at ${new Date(at).toTimeString().slice(0, 5)}), so it is left to Pi's own warming; /cache-keeper-warm starts keeping it warm again`;
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
		`pi-cache-keeper keeps ${MODEL_KEY} warm again, from your next message: whether it keeps an idle period warm is decided when the period starts. The missed-refresh count of cliproxyapi/sub/other is cleared too.`,
	);
	assert.equal(h.state.attempts, attempts, "the command sends nothing");
	assert.deepEqual([misses()?.fallback.size, misses()?.counts.size], [0, 0]);
	assert.ok(!h.statuses.at(-1)?.text?.includes(FALLBACK_STATUS), "the footer no longer says it");
	assert.deepEqual((await nextPeriod(h)).decided, { action: "stop" }, "owned again from the next period");
	assert.equal(countOf(), 1, "counted from zero: one miss");
	assert.deepEqual((await nextPeriod(h)).decided, { action: "stop" }, "still owned after one miss");
	assert.equal(await h.command("cache-keeper-warm"), `pi-cache-keeper keeps ${MODEL_KEY} warm again, from your next message: whether it keeps an idle period warm is decided when the period starts.`);
	assert.equal(await h.command("cache-keeper-warm"), "Nothing to clear: no model was left to Pi's own warming, and no refresh had missed the cache.");
	settings({ keepWarmMinutes: 0, minContextTokens: 100_000, compactBeforeExpiry: false });
	assert.equal(
		await h.command("cache-keeper-warm"),
		"Nothing to clear: no model was left to Pi's own warming, and no refresh had missed the cache. Keep-warm itself is off (keepWarmMinutes: 0); /cache-keeper-settings turns it on.",
		"it does not turn keep-warm on",
	);
	assert.equal(readSettings().cacheKeeper.keepWarmMinutes, 0);
});

test("R9: one miss counted, then the command with only a count to clear", async (t) => {
	clock();
	t.after(() => mock.timers.reset());
	fresh({ compactBeforeExpiry: false });
	const h = harness({ lifetime: 300, cost: WITH_WRITE, respond: () => HALF_MISS });
	await nextPeriod(h, true);
	assert.equal(await h.command("cache-keeper-warm"), `No model was left to Pi's own warming. The missed-refresh count of ${MODEL_KEY} is cleared.`);
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
			assert.match((await keepWarmLineOf(h)) ?? "", /two refreshes in a row missed the cache for /, label);
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

test("R9: a successful refresh whose usage shows no prompt (omitted, or output only) is neither a miss nor a hit, through Pi's real Chat Completions and Responses adapters; warming goes on", { skip: noCatalog }, async (t) => {
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
		const h = harness({ model, sent, stream: inMemory(model, "short", reply) });
		const lifetime = provider === "openai" ? 1_800_000 : 300_000;
		h.emit("agent_settled");
		assert.deepEqual(h.decide(), { action: "stop" }, label);
		// A miss already counted for the model: a refresh without evidence must not reset it.
		misses()?.counts.set(key, 1);
		await h.idle(2 * lifetime);
		await flush();
		assert.ok(h.warms.length >= 2, `${label}: warming goes on (${h.warms.length} refreshes)`);
		assert.deepEqual(traces().filter((r) => r.stop), [], `${label}: nothing ended`);
		assert.equal(countOf(key), 1, `${label}: the count is neither raised nor reset`);
		assert.equal(misses()?.fallback.size, 0, label);
		mock.timers.reset();
	}
});

test("never a third paid miss: while a refresh of the model is on its way, from any session of the process, no other leaves; it is cancelled after 60 s, and stops holding back after 10 min", async (t) => {
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
	// The extension's own refresh that gets no answer is cancelled after 60 s, and settles.
	clock();
	fresh({ compactBeforeExpiry: false });
	const silent = harness({ lifetime: 3600, cost: WITH_WRITE, hold: () => true });
	silent.emit("agent_settled");
	await silent.idle(3_421_000);
	assert.equal(silent.warms.length, 1);
	assert.equal(misses()?.inFlight.get(MODEL_KEY)?.size, 1, "on its way");
	for (let i = 0; i < 61; i++) {
		mock.timers.tick(1000);
		await flush();
	}
	const cancelled = traces().find((r) => r.action === "cancelled");
	assert.equal(cancelled?.reason, "no answer within 60 s, so it was cancelled");
	await flush();
	assert.equal(silent.warms.length, 2, "settled: it no longer holds the model back, and the refresh is tried again before the last safe moment");
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
	assert.equal(lastFooter(h), "cache warm · 60m left · long 1h (in use) · short 1h · sent 1h (retention short) · api $3/$15 per M");
	const gemini = { provider: "google", id: "gemini-3.8-pro", api: "google-generative-ai", contextWindow: 1_000_000, maxTokens: 64_000, cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 } };
	h.ctx.model = gemini as never;
	h.emit("model_select");
	// It said "long 1h (in use) · short unknown · api $1.25/$10 per M" before.
	assert.equal(lastFooter(h), "cache lifetime unknown · api $1.25/$10 per M");
	// A model with lifetimes of its own: both shown, neither in use.
	h.ctx.model = { ...gemini, id: "gemini-3.8-cached", promptCache: { short: 300, long: 3600 } } as never;
	h.emit("model_select");
	assert.equal(lastFooter(h), "short 5m · long 1h · api $1.25/$10 per M");
	// Back on Claude, which has answered in this session: its tier is in use again; the request was forgotten with the switch.
	h.ctx.model = h.model as never;
	h.emit("model_select");
	assert.equal(lastFooter(h), "long 1h (in use) · short 1h · api $3/$15 per M");

	// A period left to Pi is said for its own model only.
	fresh();
	const left = harness({ ui: true, cost: WITH_WRITE, thinking: { type: "enabled", budget_tokens: 1024 } });
	left.emit("agent_settled");
	assert.match(lastFooter(left)!, /^cache warm · 60m left · keep-warm: Pi's \(thinking on\) · /);
	left.ctx.model = gemini as never;
	left.emit("model_select");
	assert.equal(lastFooter(left), "cache lifetime unknown · api $1.25/$10 per M");
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
