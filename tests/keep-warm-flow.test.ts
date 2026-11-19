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
		getThinkingLevel: () => "high",
	};
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
	};
	const user = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 };
	const reply = { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 1_000, stopReason: "stop", usage: { input: 2, output: 5, cacheRead: cached, cacheWrite: 0 } };
	const branch = [
		{ type: "message", id: "u", parentId: null, timestamp: new Date(0).toISOString(), message: user },
		{ type: "message", id: "a", parentId: "u", timestamp: new Date(1_000).toISOString(), message: reply },
	];
	const sent = { model: "claude", max_tokens: 64_000, system: "s", messages: [{ role: "user", content: "hi" }], thinking: options.thinking ?? { type: "adaptive" } };
	const warms: { payload: unknown; options: Record<string, unknown>; at: number }[] = [];
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
			streamSimple: (_model: unknown, _context: unknown, options2: Record<string, unknown> & { onPayload: (p: unknown) => unknown; signal: AbortSignal }) => {
				state.attempts++;
				state.beforePayload?.();
				let payload: unknown;
				let thrown: unknown;
				try {
					payload = options2.onPayload({ model: "rebuilt", max_tokens: 1, messages: [] });
				} catch (error) {
					thrown = error;
				}
				if (thrown) return { result: () => Promise.reject(thrown) };
				warms.push({ payload, options: options2, at: Date.now() });
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
			const reply2 = { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: Date.now(), stopReason: answer === true || answer === "uncached" ? "stop" : answer, usage: used };
			request([user, message], { ...sent, messages: [...sent.messages, { role: "user", content: `more ${runs}` }] }, reply2);
			branch.push({ type: "message", id: `a${runs}`, parentId: null, timestamp: new Date().toISOString(), message: reply2 } as never);
		}
		beforeSettled?.();
		state.idle = true;
		emit("agent_settled", { aborted: answer !== true && answer !== "uncached" });
	};
	// Runs the idle clock second by second, letting each refresh land, until a compaction starts or `ms` passed.
	const idle = async (ms: number) => {
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
	return { emit, idle, warms, state, sent, model, branch, statuses, notes, command, decide, run, usage: refreshUsage, ctx, release: () => pending?.() };
}

const allTraces = () =>
	readFileSync(join(dir, "cache-keeper.jsonl"), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
const traces = () => allTraces().filter((record) => record.event === "warm" || record.event === "expiry");
const fresh = (keepWarm: Record<string, unknown> = {}) => {
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
] as const) {
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
	assert.match(await h.command("cache-keeper"), /at most 10 refreshes \(this model has no prices, so the cost of a miss is unknown\); this session is left to Pi's own warming: Claude's budget-based thinking/);
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

	// budget: with prices (gate) and without (count).
	let r = await ended({ lifetime: 300, cost: WITH_WRITE }, undefined, 1440);
	assert.equal(r.stop.stop, "budget");
	assert.equal(r.footer, "cache warm · 0:24 left · keep-warm ended (budget reached): $1.98 spent, a miss costs $2.07");
	assert.match(r.shown, /keep warm: up to 24 h after Pi goes idle; stops once refreshing has cost as much as one cache miss; keep-warm ended \(budget reached\): \$1\.98 spent, a miss costs \$2\.07, until your next message \(refreshing has cost/);
	r = await ended({ lifetime: 300 }, undefined, 1440);
	assert.equal(r.footer, "cache warm · 5m left · keep-warm ended (budget reached): 10 of 10 refreshes", "ended when the 10th refresh settled");

	// limit: the last refresh carries the cache past the window; or the answer's own lifetime already covers it.
	r = await ended({ lifetime: 3600, cost: WITH_WRITE });
	assert.deepEqual([r.stop.action, r.stop.stop, r.h.warms.length], ["warm", "limit", 2]);
	assert.equal(r.footer, "cache warm · 60m left · keep-warm ended (2 h limit): $0.36 spent, a miss costs $2.07");
	r = await ended({ lifetime: 3600, cost: WITH_WRITE }, undefined, 30);
	assert.deepEqual([r.stop.action, r.stop.stop, r.h.warms.length], ["skip", "limit", 0]);
	assert.equal(r.stop.idleMinutes, 0, "recorded when the period starts");
	assert.equal(r.footer, "cache warm · 60m left · keep-warm ended (30 min limit): $0 spent, a miss costs $2.07");

	// missed: a refresh read under 90% from the cache.
	r = await ended({ lifetime: 300, cost: WITH_WRITE, respond: () => ({ usage: { cacheRead: 300_000, cacheWrite: 300_000 } }) });
	assert.deepEqual([r.stop.action, r.stop.stop, r.h.warms.length], ["missed", "missed", 1]);
	assert.equal(r.stop.reason, "the refresh read only 49% from the cache, so it wrote the context again");
	assert.equal(r.footer, "cache warm · 5m left · keep-warm ended (a refresh missed the cache): $1.22 spent, a miss costs $2.07");

	// failed: a refresh ended in an error.
	r = await ended({ lifetime: 300, cost: WITH_WRITE, respond: () => ({ stopReason: "error", errorMessage: "overloaded" }) });
	assert.deepEqual([r.stop.action, r.stop.stop, r.h.warms.length], ["failed", "failed", 1]);
	assert.equal(r.footer, "cache warm · 0:25 left · keep-warm ended (a refresh failed): $0.18 spent, a miss costs $2.07");

	// unable: the cached path no longer checks out (a branch move made the extension forget the request). Pi's
	// decisions are still answered by the period's facts.
	r = await ended({ lifetime: 300, cost: WITH_WRITE }, async (h) => {
		await h.idle(200_000);
		h.emit("session_tree");
	});
	assert.deepEqual([r.stop.action, r.stop.stop, r.h.warms.length], ["skip", "unable", 0]);
	assert.match(r.stop.reason, /^no request since the session started or compacted, or since the model or branch changed/);
	assert.equal(r.footer, "cache warm · 0:24 left · keep-warm ended (the request can't be re-sent): $0 spent, a miss costs $2.07");
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

test("no file imports evaluateCacheWarming (missing before pi-ai 1.5.1)", () => {
	const root = new URL("..", import.meta.url);
	const files = [...readdirSync(root).filter((name) => name.endsWith(".ts")).map((name) => new URL(name, root)), ...readdirSync(new URL("tests/", root)).filter((name) => name.endsWith(".ts")).map((name) => new URL(`tests/${name}`, root))];
	assert.ok(files.length > 10);
	for (const file of files) assert.doesNotMatch(readFileSync(file, "utf8"), /^\s*import\s[^;]*\bevaluateCacheWarming\b/m, file.pathname);
});

test.after(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	rmSync(dir, { recursive: true });
});
