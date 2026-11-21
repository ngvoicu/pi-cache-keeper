import assert from "node:assert/strict";
import test from "node:test";
import { comparison, describeTrace, stopLabel, type TraceRecord, formatCacheStatus, formatRemaining, type CompactTrace, type TraceUsage } from "../trace.ts";

const cached = (usage: Partial<TraceUsage>, piEstimate: CompactTrace["piEstimate"]): CompactTrace => ({
	event: "compact",
	trigger: "manual",
	model: "m",
	outcome: "cached",
	tokensBefore: 0,
	cwd: "/",
	response: { stopReason: "stop", seconds: 1, summaryChars: 1, usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0, ...usage } },
	piEstimate,
});

test("the card compares a cached compaction with Pi's: by cost when the model has prices, else by tokens not read from the cache", () => {
	assert.equal(
		comparison(cached({ cost: 0.061 }, { input: 186_000, cost: 0.47 }))?.text,
		"vs Pi's compaction: 87% less, $0.061 instead of ~$0.47 (it sends ~186k tokens, none from cache)",
	);
	assert.equal(
		comparison(cached({ input: 2, cacheRead: 39_559, cacheWrite: 457_879 }, { input: 186_000, cost: 0 }))?.text,
		"vs Pi's compaction: 2.5× as much, 458k tokens not from cache instead of ~186k",
	);
});

test("the log describes compacting when full", () => {
	const at = "2026-11-08T10:00:00.000Z";
	const time = new Date(at).toLocaleTimeString([], { hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" });
	const base = { event: "full" as const, contextTokens: 905_000, threshold: 900_000, percent: 90, at, session: "s" };
	assert.equal(describeTrace({ ...base, action: "compact" }), `${time} context at 905k, past 90% (900k): compacting`);
	assert.equal(describeTrace({ ...base, action: "skip", reason: "Pi is busy or has queued messages" }), `${time} context at 905k, past 90% (900k): not compacting, Pi is busy or has queued messages`);
	assert.equal(describeTrace({ ...base, contextTokens: 412_000, threshold: 400_000, tokens: 400_000, action: "compact" }), `${time} context at 412k, past the 400k-token cap: compacting`);
});

test("the footer labels the countdown as the cache's, and the /cache-keeper line keeps the bare time", () => {
	assert.equal(formatCacheStatus(59 * 60_000), "cache warm · 59m left");
	assert.equal(formatCacheStatus(120_000), "cache warm · 2m left");
	assert.equal(formatCacheStatus(25_000), "cache warm · 0:25 left");
	assert.equal(formatCacheStatus(400), "cache warm · 0:01 left");
	assert.equal(formatCacheStatus(0), "cache cold · next message full price");
	assert.equal(formatCacheStatus(-5_000), "cache cold · next message full price");
	assert.equal(formatRemaining(29 * 60_000), "29m");
	assert.equal(formatRemaining(25_000), "0:25");
	// Past two hours (a 12-hour cache), in hours and minutes.
	assert.equal(formatRemaining(119 * 60_000), "119m");
	assert.equal(formatRemaining(2 * 3_600_000), "2h");
	assert.equal(formatRemaining(12 * 3_600_000 - 60_000), "11h 59m");
	assert.equal(formatCacheStatus(11 * 3_600_000 + 30_000), "cache warm · 11h left");
});

test("the log describes keeping the cache warm", () => {
	const at = "2026-11-12T10:00:00.000Z";
	const time = new Date(at).toLocaleTimeString([], { hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" });
	const base = { event: "warm" as const, secondsLeft: 180, contextTokens: 692_000, idleMinutes: 57, at, session: "s" };
	const usage = { input: 2, cacheRead: 692_000, cacheWrite: 0, output: 1, cost: 0.144 };
	assert.equal(describeTrace({ ...base, action: "warm", usage } as TraceRecord), `${time} kept the cache warm, idle 57 min: 99% of 692k from cache, 1 out, $0.14`);
	assert.equal(describeTrace({ ...base, action: "failed", reason: "overloaded" } as TraceRecord), `${time} keeping the cache warm failed: overloaded`);
	assert.equal(describeTrace({ ...base, action: "skip", reason: "Pi is busy or has queued messages" } as TraceRecord), `${time} cache expires in 180s: not keeping it warm, Pi is busy or has queued messages`);
});

test("the log says what keeping warm has spent and why it ended; records from before still read", () => {
	const at = "2026-11-19T10:00:00.000Z";
	const time = new Date(at).toLocaleTimeString([], { hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" });
	const timer = { model: "anthropic/claude-opus-5-5", lifetimeSeconds: 300, lifetimeSource: "declared by the model" };
	const base = { event: "warm" as const, secondsLeft: 25, contextTokens: 600_000, idleMinutes: 50, at, session: "s", ...timer };
	const usage = { input: 2, cacheRead: 600_000, cacheWrite: 0, output: 1, cost: 0.18 };
	assert.equal(
		describeTrace({ ...base, action: "warm", usage, budget: { unit: "usd", spent: 0.54, limit: 2.07, next: 0.18 } } as TraceRecord),
		`${time} kept the cache warm, idle 50 min: 99% of 600k from cache, 1 out, $0.18; $0.54 of $2.07 (one cache miss) spent`,
	);
	assert.equal(
		describeTrace({ ...base, action: "warm", usage: { ...usage, cost: 0 }, budget: { unit: "refreshes", spent: 10, limit: 10 }, stop: "budget", reason: "10 refreshes since the last answer" } as TraceRecord),
		`${time} kept the cache warm, idle 50 min: 99% of 600k from cache, 1 out, $0; 10 of at most 10 refreshes (no prices); keep-warm ended (budget reached)`,
	);
	const reason = "refreshing has cost $1.98 since the last answer; another refresh ($0.18) would pass the $2.07 one cache miss costs";
	assert.equal(describeTrace({ ...base, action: "skip", stop: "budget", reason } as TraceRecord), `${time} cache expires in 25s: keep-warm ended (budget reached), ${reason}`);
	assert.equal(
		describeTrace({ ...base, action: "skip", stop: "limit", reason: "the cache lasts to the end of the 2 h limit after Pi went idle" } as TraceRecord),
		`${time} cache expires in 25s: keep-warm ended (time limit), the cache lasts to the end of the 2 h limit after Pi went idle`,
	);
	assert.equal(
		describeTrace({ ...base, action: "missed", usage, stop: "missed", reason: "the refresh read only 49% from the cache" } as TraceRecord),
		`${time} keeping the cache warm missed the cache, idle 50 min: 99% of 600k from cache, 1 out, $0.18; keep-warm ended (a refresh missed the cache)`,
	);
	assert.equal(describeTrace({ ...base, action: "failed", reason: "overloaded", stop: "failed" } as TraceRecord), `${time} keeping the cache warm failed: overloaded; keep-warm ended (a refresh failed)`);
	assert.equal(describeTrace({ ...base, action: "skip", stop: "unable", reason: "the model changed since the last request" } as TraceRecord), `${time} cache expires in 25s: keep-warm ended (the request can't be re-sent), the model changed since the last request`);
	assert.equal(
		describeTrace({ ...base, action: "cancelled", reason: "a new request or a change of session cancelled it", budget: { unit: "usd", spent: 0.18, limit: 2.07 } } as TraceRecord),
		`${time} a refresh of the cache was cancelled: a new request or a change of session cancelled it; $0.18 of $2.07 (one cache miss) spent`,
	);
	assert.equal(describeTrace({ ...base, action: "pi-stopped", reason: "this extension keeps this idle period's cache warm (Pi would have refreshed)" } as TraceRecord), `${time} told Pi's own idle warming to stop: this extension keeps this idle period's cache warm (Pi would have refreshed)`);
	// 0.4 records: no model, lifetime, budget or end reason.
	const old = JSON.parse('{"event":"expiry","action":"compact","secondsLeft":20,"contextTokens":600000,"at":"2026-11-19T10:00:00.000Z","session":"s"}');
	assert.equal(describeTrace(old), `${time} cache expires in 20s: compacting 600k tokens`);
	const oldMissed = JSON.parse('{"event":"warm","action":"missed","secondsLeft":180,"idleMinutes":57,"usage":{"input":0,"cacheRead":0,"cacheWrite":692000,"output":1,"cost":2.6},"at":"2026-11-19T10:00:00.000Z","session":"s"}');
	assert.equal(describeTrace(oldMissed), `${time} keeping the cache warm missed the cache, idle 57 min: 0% of 692k from cache, 1 out, $2.6; stopped until your next message`);
});

test("a /cache-keeper-stop in the log: its label, the end of a period's warming, and Pi's warming told to stop, with a budget only where the period has one", () => {
	assert.equal(stopLabel("stopped"), "stopped by /cache-keeper-stop");
	const at = "2026-11-22T14:02:10.000Z";
	const time = new Date(at).toLocaleTimeString([], { hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" });
	const base = { event: "warm" as const, secondsLeft: 2400, at, session: "s", model: "anthropic/claude-sonnet-4-6" };
	assert.equal(
		describeTrace({ ...base, action: "skip", stop: "stopped", reason: "given at 14:02", budget: { unit: "usd", spent: 0.36, limit: 2.07 } } as TraceRecord),
		`${time} cache expires in 2400s: keep-warm ended (stopped by /cache-keeper-stop), given at 14:02; $0.36 of $2.07 (one cache miss) spent`,
	);
	const reason = "/cache-keeper-stop (given at 14:02) holds until your next message (Pi would have refreshed)";
	assert.equal(describeTrace({ ...base, secondsLeft: 0, action: "pi-stopped", reason } as TraceRecord), `${time} told Pi's own idle warming to stop: ${reason}`);
});
