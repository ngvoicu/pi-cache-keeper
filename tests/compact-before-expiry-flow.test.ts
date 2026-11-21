import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";

// The trace path and settings are read from the agent directory, so it is set before the extension loads.
// Keeping warm is off, so only compacting before expiry acts on the countdown.
const dir = mkdtempSync(join(tmpdir(), "pcc-expiry-"));
process.env.PI_CODING_AGENT_DIR = dir;
const keeper = { keepWarmMinutes: 0, minContextTokens: 100_000 };
const writeSettings = (autoCompaction: boolean) =>
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ cacheKeeper: keeper, ...(autoCompaction ? {} : { compaction: { enabled: false } }) }));
writeSettings(true);
const { default: cacheKeeper } = await import("../index.ts");

const HOUR = 3_600_000;
// The reply lands at 1 s and the model's cache lasts an hour.
const EXPIRES = 1_000 + HOUR;

function harness() {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
		registerEntryRenderer: () => {},
		events: { on: () => () => {}, emit: () => {} },
		registerCommand: () => {},
		appendEntry: () => {},
		getThinkingLevel: () => "high",
	};
	cacheKeeper(pi as never);

	const model = { provider: "cliproxyapi", id: "sub/claude", api: "anthropic-messages", promptCache: { short: 3600, long: 3600 }, contextWindow: 1_000_000, maxTokens: 64_000 };
	const user = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 };
	const reply = { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 1_000, stopReason: "stop", usage: { input: 2, output: 5, cacheRead: 600_000, cacheWrite: 0 } };
	const branch: unknown[] = [
		{ type: "message", id: "u", parentId: null, timestamp: new Date(0).toISOString(), message: user },
		{ type: "message", id: "a", parentId: "u", timestamp: new Date(1_000).toISOString(), message: reply },
	];
	const sent = { model: "claude", max_tokens: 64_000, system: "s", messages: [{ role: "user", content: "hi" }], thinking: { type: "adaptive" } };
	// `fail`: the compaction reports its failure at once; `held`: it keeps its callbacks, for the test to settle later.
	const state = {
		compacts: 0,
		idle: true,
		queued: false,
		tokens: 600_000 as number | undefined,
		fail: false,
		hold: false,
		held: undefined as { onComplete?: () => void; onError?: (error: Error) => void } | undefined,
	};
	const ctx = {
		hasUI: false,
		cwd: dir,
		model,
		isIdle: () => state.idle,
		hasPendingMessages: () => state.queued,
		isProjectTrusted: () => false,
		getContextUsage: () => ({ tokens: state.tokens }),
		sessionManager: { getBranch: () => branch, getSessionId: () => "s1", getSessionFile: () => undefined },
		modelRegistry: {
			streamSimple: () => {
				throw new Error("no request is sent in these tests");
			},
		},
		compact: (options: { onComplete?: () => void; onError?: (error: Error) => void }) => {
			state.compacts++;
			if (state.hold) state.held = options;
			else if (state.fail) options.onError?.(new Error("compaction failed"));
		},
	};
	const emit = (event: string, payload: unknown = {}) => handlers.get(event)?.(payload, ctx);
	// Pi's own cache warmer refreshes the idle cache: its decision, then its usage entry, which moves the expiry.
	let warms = 0;
	const piWarms = () => {
		emit("cache_warming_decision", { action: "warm" });
		branch.push({ type: "usage", id: `w${++warms}`, parentId: "a", timestamp: new Date(Date.now()).toISOString(), kind: "cache_warm" });
	};
	// One real request: Pi builds the context, sends the payload, the reply lands, and the run settles.
	emit("context_with_system", { messages: [user] });
	emit("before_provider_request", { payload: sent });
	return { emit, state, piWarms };
}

const traces = () =>
	readFileSync(join(dir, "cache-keeper.jsonl"), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.filter((record) => record.event === "expiry");
const summary = () => traces().map((r) => `${r.action}${r.reason ? `: ${r.reason}` : ""}`);
const BUSY = "skip: Pi is busy or has queued messages";

// Starts at 1 s with the reply just landed and Pi idle; moves the clock to `at`.
function start(t: { after: (fn: () => void) => void }) {
	mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000 });
	t.after(() => {
		mock.timers.reset();
		writeSettings(true);
	});
	writeFileSync(join(dir, "cache-keeper.jsonl"), "");
	const h = harness();
	h.emit("agent_settled");
	// A second at a time, so each tick of the countdown sees its own time.
	const to = (at: number) => {
		while (Date.now() < at) mock.timers.tick(Math.min(1_000, at - Date.now()));
	};
	return { ...h, to };
}

test("a normal countdown compacts exactly once, 20 s before expiry", (t) => {
	const { state, to } = start(t);
	to(EXPIRES - 21_000);
	assert.equal(state.compacts, 0);
	to(EXPIRES - 20_000);
	assert.equal(state.compacts, 1);
	to(EXPIRES + 60_000);
	assert.equal(state.compacts, 1);
	assert.deepEqual(summary(), ["compact"]);
});

test("a try postponed while a message is queued is made again once the queue clears", (t) => {
	const { state, to } = start(t);
	state.queued = true;
	to(EXPIRES - 20_000);
	assert.equal(state.compacts, 0);
	to(EXPIRES - 16_000);
	assert.equal(state.compacts, 0);
	state.queued = false;
	to(EXPIRES - 15_000);
	assert.equal(state.compacts, 1);
	to(EXPIRES + 60_000);
	assert.equal(state.compacts, 1);
	assert.deepEqual(summary(), [BUSY, "compact"], "the postponed try is traced once, not every second");
	assert.equal(traces()[1].secondsLeft, 15);
});

test("a try postponed until Pi's own refresh moved the expiry is made before the new expiry", (t) => {
	const { state, to, piWarms } = start(t);
	state.queued = true;
	to(EXPIRES - 20_000);
	// Pi's warmer refreshes the cache while the message is still queued: the cache lives another hour.
	to(EXPIRES - 10_000);
	piWarms();
	to(EXPIRES + 30_000);
	state.queued = false;
	const renewed = EXPIRES - 10_000 + HOUR;
	to(renewed - 21_000);
	assert.equal(state.compacts, 0);
	to(renewed - 20_000);
	assert.equal(state.compacts, 1);
	assert.deepEqual(summary(), [BUSY, "compact"]);
});

test("a lasting skip uses up the try for its expiry, and the expiry Pi's refresh moved gets its own", (t) => {
	const { state, to, piWarms } = start(t);
	writeSettings(false);
	to(EXPIRES - 20_000);
	assert.deepEqual(summary(), ["skip: automatic compaction is off in Pi's settings"]);
	// Turned on again: the try for this expiry is spent, so nothing happens before it.
	writeSettings(true);
	to(EXPIRES - 10_000);
	assert.equal(state.compacts, 0);
	piWarms();
	const renewed = EXPIRES - 10_000 + HOUR;
	to(renewed - 21_000);
	assert.equal(state.compacts, 0);
	to(renewed - 20_000);
	assert.equal(state.compacts, 1);
	assert.deepEqual(summary(), ["skip: automatic compaction is off in Pi's settings", "compact"]);
});

test("a lasting skip is traced once although the expiry moved twice", (t) => {
	const { state, to, piWarms } = start(t);
	state.tokens = 50_000;
	to(EXPIRES - 10_000);
	piWarms();
	const second = EXPIRES - 10_000 + HOUR;
	to(second - 10_000);
	piWarms();
	const third = second - 10_000 + HOUR;
	to(third + 60_000);
	assert.equal(state.compacts, 0);
	assert.deepEqual(summary(), ["skip: the context holds 50k tokens, under minContextTokens (100k)"]);
});

test("the expiry Pi's refresh moved is checked again after a lasting skip", (t) => {
	const { state, to, piWarms } = start(t);
	state.tokens = undefined;
	to(EXPIRES - 10_000);
	piWarms();
	state.tokens = 600_000;
	const renewed = EXPIRES - 10_000 + HOUR;
	to(renewed - 20_000);
	assert.equal(state.compacts, 1);
	assert.deepEqual(summary(), ["skip: the context size is unknown", "compact"]);
});

test("a try postponed until the cache expires ends without a compaction and without an error", (t) => {
	const { state, to } = start(t);
	state.queued = true;
	to(EXPIRES + 1_000);
	assert.equal(state.compacts, 0);
	state.queued = false;
	to(EXPIRES + HOUR);
	assert.equal(state.compacts, 0, "an expired cache is not compacted");
	assert.deepEqual(summary(), [BUSY]);
});

test("after a failed compaction the same expiry is not tried again, but the one Pi's refresh moved is", (t) => {
	const { state, to, piWarms } = start(t);
	state.fail = true;
	to(EXPIRES - 20_000);
	assert.equal(state.compacts, 1);
	state.fail = false;
	to(EXPIRES - 10_000);
	assert.equal(state.compacts, 1);
	piWarms();
	const renewed = EXPIRES - 10_000 + HOUR;
	to(renewed - 20_000);
	assert.equal(state.compacts, 2);
});

test("a compaction that fails after Pi's refresh moved the expiry leaves the new expiry its own try", (t) => {
	const { state, to, piWarms } = start(t);
	state.hold = true;
	to(EXPIRES - 20_000);
	assert.equal(state.compacts, 1);
	// Pi's refresh lands while the compaction is still running, and only then does the compaction fail.
	to(EXPIRES - 10_000);
	piWarms();
	state.hold = false;
	state.held?.onError?.(new Error("compaction failed"));
	const renewed = EXPIRES - 10_000 + HOUR;
	to(renewed - 21_000);
	assert.equal(state.compacts, 1);
	to(renewed - 20_000);
	assert.equal(state.compacts, 2, "the failed try was for the old expiry, not the one Pi's refresh moved it to");
	to(renewed + 60_000);
	assert.equal(state.compacts, 2);
	assert.deepEqual(summary(), ["compact", "compact"]);
});

test.after(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	rmSync(dir, { recursive: true });
});
