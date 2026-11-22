import assert from "node:assert/strict";
import test from "node:test";
import { comparison, describeTrace, noticeOf, stopLabel, SWITCHED_OFF, traceDetails, type TraceRecord, type WarmTrace, formatCacheStatus, formatRemaining, type CompactTrace, type TraceUsage } from "../trace.ts";

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

test("what each record says in the transcript: its words and level, with prices and without", () => {
	const base = { event: "warm" as const, secondsLeft: 12 };
	const usd = { unit: "usd" as const, spent: 0.36, limit: 2.07 };
	const none = { unit: "refreshes" as const, spent: 3, limit: 10 };
	const hit = { input: 2, cacheRead: 600_000, cacheWrite: 0, output: 1, cost: 0.18 };
	const miss = { input: 0, cacheRead: 75_000, cacheWrite: 525_000, output: 1, cost: 2.25 };
	const say = (record: Partial<WarmTrace>, limit = "2 h") => noticeOf({ ...base, action: "skip", ...record } as WarmTrace, limit);
	const A = "$0.36 spent, a miss costs $2.07";
	const warmed = `Cache warmed (pi-cache-keeper, refresh 2): 99% of 600k from the cache, $0.18; ${A}`;
	// A refresh that was sent.
	assert.deepEqual(say({ action: "warm", refresh: 2, verdict: "hit", usage: hit, budget: usd }), { level: "info", text: warmed });
	assert.deepEqual(say({ action: "warm", refresh: 2, verdict: "hit", usage: { ...hit, cost: 0 }, budget: none }), { level: "info", text: "Cache warmed (pi-cache-keeper, refresh 2): 99% of 600k from the cache; 3 of 10 refreshes" });
	assert.deepEqual(say({ action: "warm", refresh: 2, verdict: "hit", usage: hit, budget: usd, stop: "budget", reason: "r" }), { level: "info", text: `${warmed}. Keep-warm ended until your next message (budget reached).` });
	assert.deepEqual(say({ action: "warm", refresh: 2, verdict: "hit", usage: hit, budget: usd, stop: "limit", reason: "r" }), { level: "info", text: `${warmed}. Keep-warm ended until your next message (2 h limit).` });
	assert.deepEqual(say({ action: "warm", refresh: 2, verdict: "hit", usage: hit, budget: usd, stop: "unable", reason: "it wrote 5%", handedOver: "evidence" }), { level: "warning", text: `${warmed}. Keep-warm ended, and this idle period is left to Pi's own warming: it wrote 5%.` });
	assert.deepEqual(say({ action: "missed", refresh: 2, verdict: "miss", usage: miss, budget: { ...usd, spent: 2.43 }, stop: "missed" }), {
		level: "warning",
		text: "Keeping the cache warm read only 12% of 600k from the cache, so it wrote the context again: $2.25; $2.43 spent, a miss costs $2.07. Stopped until your next message.",
	});
	assert.deepEqual(say({ action: "warm", refresh: 2, budget: usd, stop: "unknown" }), { level: "warning", text: `Keeping the cache warm: refresh 2 reported no usage, so what it cost is unknown; ${A}. Stopped until your next message.` });
	assert.deepEqual(say({ action: "failed", refresh: 2, budget: usd, reason: "overloaded", stop: "failed" }), { level: "warning", text: `pi-cache-keeper could not keep the cache warm: overloaded; ${A}. Stopped until your next message.` });
	assert.deepEqual(say({ action: "failed", refresh: 2, verdict: "miss", usage: miss, budget: usd, reason: "overloaded", stop: "missed" }), {
		level: "warning",
		text: `pi-cache-keeper could not keep the cache warm: overloaded; ${A}. Stopped until your next message. It had read only 12% of 600k from the cache: $2.25.`,
	});
	assert.deepEqual(say({ action: "failed", refresh: 2, verdict: "hit", usage: hit, budget: usd, reason: "overloaded" }), { level: "info", text: `${warmed}. The request then failed: overloaded` });
	assert.deepEqual(say({ action: "cancelled", refresh: 2, verdict: "hit", usage: hit, budget: usd }), { level: "info", text: `${warmed}. It was then cancelled by a new request or a change of session.` });
	assert.deepEqual(say({ action: "cancelled", refresh: 2, budget: usd }), { level: "info", text: `The cache refresh on its way (refresh 2) was cancelled by a new request or a change of session; it stays counted: ${A}` });
	assert.deepEqual(say({ action: "cancelled", refresh: 2, verdict: "miss", usage: miss, budget: { ...usd, spent: 2.43 } }), {
		level: "warning",
		text: "The cache refresh on its way (refresh 2) was cancelled by a new request; it had read only 12% of 600k from the cache: $2.25; $2.43 spent, a miss costs $2.07",
	});
	// Due and not sent.
	assert.deepEqual(say({ hold: "busy", reason: "r" }), { level: "info", text: "Cache refresh held back: Pi is busy or has queued messages; tried again until the last safe moment." });
	assert.deepEqual(say({ hold: "settling", reason: "r" }), { level: "info", text: "Cache refresh held back: an earlier refresh of this model has not settled yet, and it may have missed the cache; tried again until the last safe moment." });
	assert.deepEqual(say({ hold: "late", reason: "r" }), {
		level: "warning",
		text: "The cache was not refreshed: too late, less than half the warm lead was left before it expires (the computer slept, or Pi was busy until then). It expires in 12s.",
	});
	// Warming ends without a refresh.
	assert.deepEqual(say({ stop: "budget", reason: "refreshing has cost $1.98", budget: usd }), { level: "info", text: `Keep-warm ended until your next message (budget reached): refreshing has cost $1.98; ${A}` });
	assert.deepEqual(say({ stop: "limit", reason: "the cache lasts to the end of the 2 h limit after Pi went idle", budget: usd }), {
		level: "info",
		text: `Keep-warm ended until your next message (2 h limit): the cache lasts to the end of the 2 h limit after Pi went idle; ${A}`,
	});
	assert.deepEqual(say({ stop: "unable", reason: SWITCHED_OFF, budget: usd }), { level: "info", text: `Keep-warm ended for this idle period: keep-warm was turned off; ${A}` });
	assert.deepEqual(say({ stop: "unable", reason: "the stop record could not be read", budget: usd }), { level: "warning", text: `Keep-warm ended until your next message (the request can't be re-sent): the stop record could not be read; ${A}` });
	assert.deepEqual(say({ action: "failed", stop: "failed", reason: "no API key", budget: usd }), { level: "warning", text: `pi-cache-keeper could not keep the cache warm: no API key (nothing was sent); ${A}. Stopped until your next message.` });
	// Who warms changes.
	assert.deepEqual(say({ stop: "unable", reason: "the route changed", handedOver: "evidence", budget: usd }), { level: "warning", text: `Keep-warm ended, and this idle period is left to Pi's own warming: the route changed; ${A}` });
	assert.deepEqual(say({ stop: "unable", reason: "you switched", handedOver: "let go", budget: usd }), { level: "info", text: `Keep-warm ended, and this idle period is left to Pi's own warming: you switched; ${A}` });
	assert.deepEqual(say({ reason: "the route changed", handedOver: "evidence" }), { level: "warning", text: "This idle period is left to Pi's own warming from now: the route changed" });
	assert.deepEqual(say({ reason: "you switched", handedOver: "let go" }), { level: "info", text: "This idle period is left to Pi's own warming from now: you switched" });
	assert.deepEqual(say({ action: "left", reason: "the cache lifetime is unknown" }), { level: "info", text: "Keep-warm: this session is left to Pi's own warming: the cache lifetime is unknown" });
	assert.deepEqual(say({ action: "pi-stopped", reason: "this extension keeps this idle period's cache warm (Pi would have refreshed)" }), {
		level: "info",
		text: "Told Pi's own idle warming to stop: this extension keeps this idle period's cache warm (Pi would have refreshed)",
	});
	// Nothing: a stop's end (the stop's own notice says it) and a bare skip.
	assert.equal(say({ stop: "stopped", reason: "given at 14:02", budget: usd }), undefined);
	assert.equal(say({ reason: "keep-warm ended: given at 14:02" }), undefined);
});

test("the log reads the two new records: a session left to Pi, and a period handed over after its warming had ended", () => {
	const at = "2026-11-22T14:02:10.000Z";
	const time = new Date(at).toLocaleTimeString([], { hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" });
	assert.equal(describeTrace({ event: "warm", action: "left", reason: "the cache lifetime is unknown", secondsLeft: 0, at, session: "s" }), `${time} keep-warm: left to Pi's own warming, the cache lifetime is unknown`);
	assert.equal(describeTrace({ event: "warm", action: "skip", handedOver: "evidence", reason: "the route changed", secondsLeft: 2400, at, session: "s" }), `${time} cache expires in 2400s: left to Pi's own warming from now, the route changed`);
});

// Design 0.10.0, test 23: the words of a fallback model compaction, on the card and in /cache-keeper's log.
test("a fallback model compaction's words: a summary with prices, on a subscription, without prices; a fallback with each kind of skipped", () => {
	const at = "2026-11-22T13:48:54.000Z";
	const time = new Date(at).toLocaleTimeString([], { hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" });
	const usage: TraceUsage = { input: 148_000, cacheRead: 0, cacheWrite: 0, output: 3_000, cost: 0.052 };
	const cold = (over: Partial<NonNullable<CompactTrace["cold"]>> = {}): CompactTrace & TraceRecord => ({
		event: "compact",
		trigger: "manual",
		model: "anthropic/claude-opus-4-5",
		outcome: "cold",
		reason: "the prompt cache has expired",
		tokensBefore: 412_000,
		cwd: "/",
		at,
		session: "s",
		cold: { model: "google/gemini-2.5-flash", via: "api", thinking: "off", needTokens: 148_000, window: 1_000_000, requests: 1, response: { seconds: 12.3, usage, summaryChars: 5120 }, ...over },
	});
	const priced = cold();
	assert.equal(describeTrace(priced), `${time} /compact: summary by google/gemini-2.5-flash, the prompt cache has expired: 148k in, 3k out, $0.052, 12.3s, summary 5120 chars`);
	assert.equal(comparison(priced), undefined, "the picked model's own cost only (review 8)");
	assert.deepEqual(traceDetails(priced), ["fallback model: google/gemini-2.5-flash (API key), thinking off, about 148k tokens of a 1M window, 1 request"]);

	const sub = cold({ via: "sub", requests: 2, thinking: "minimal", response: { seconds: 12.3, usage: { ...usage, cost: 0 }, summaryChars: 5120 } });
	assert.equal(describeTrace(sub), `${time} /compact: summary by google/gemini-2.5-flash, the prompt cache has expired: 148k in, 3k out, on a subscription, 12.3s, summary 5120 chars`);
	assert.equal(comparison(sub), undefined);
	assert.deepEqual(traceDetails(sub), ["fallback model: google/gemini-2.5-flash (subscription), thinking minimal, about 148k tokens of a 1M window, 2 requests"]);

	const free = cold({ response: { seconds: 2, usage: { ...usage, cost: 0 }, summaryChars: 900 } });
	assert.equal(describeTrace(free), `${time} /compact: summary by google/gemini-2.5-flash, the prompt cache has expired: 148k in, 3k out, no price, 2.0s, summary 900 chars`);
	assert.equal(comparison(free), undefined);

	const skipped = [
		"it is a virtual model",
		"it runs through pi-claude-bridge",
		"it is the session's own model",
		"Pi no longer lists it",
		"Pi has no credentials for google",
		"it declares no context window",
		"it needs about 260k tokens and its window is 200k",
		"its request failed: Summarization failed: 429 rate limited",
		"it returned no summary text",
	];
	for (const why of skipped) {
		const record = { ...cold({ response: undefined, skipped: why }), outcome: "fallback" as const };
		assert.equal(describeTrace(record), `${time} /compact: Pi's compaction, the prompt cache has expired; google/gemini-2.5-flash did not write the summary: ${why}`);
		assert.equal(comparison(record), undefined);
	}
	// Skipped before the fit rule: only what was known.
	assert.deepEqual(traceDetails({ ...cold({ response: undefined, skipped: "Pi no longer lists it", via: undefined, thinking: undefined, needTokens: undefined, window: undefined, requests: undefined }), outcome: "fallback" }), ["fallback model: google/gemini-2.5-flash"]);
	// The fallback's own line when no fallback model was set is as before.
	const plain = { ...cold(), outcome: "fallback" as const, cold: undefined };
	assert.equal(describeTrace(plain), `${time} /compact: Pi's compaction, the prompt cache has expired`);
	assert.deepEqual(traceDetails(plain), []);
	// An abort during the cold request is a cancel.
	assert.equal(describeTrace({ ...cold({ response: undefined, skipped: "the compaction was aborted" }), outcome: "cancelled", reason: "the compaction was aborted" }), `${time} /compact: cancelled, the compaction was aborted`);
});

// Findings 8 and 9 (review, round 1): the card shows the picked model's own cost only, labelled from what the request
// recorded.
test("review 8 and 9: no comparison with the session's model; a recorded cost is shown as that cost, also through a subscription route; no cost on a subscription reads subscription", () => {
	const at = "2026-11-22T13:48:54.000Z";
	const time = new Date(at).toLocaleTimeString([], { hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" });
	const record = (via: "sub" | "api", cost: number): CompactTrace & TraceRecord => ({
		event: "compact",
		trigger: "manual",
		model: "anthropic/claude-haiku-5-5",
		outcome: "cold",
		reason: "the prompt cache has expired",
		tokensBefore: 120_000,
		cwd: "/",
		at,
		session: "s",
		cold: { model: "proxy/gpt-4o-mini", via, requests: 2, response: { seconds: 1, usage: { input: 60_000, cacheRead: 0, cacheWrite: 0, output: 1_000, cost }, summaryChars: 17 } },
	});
	assert.equal(comparison(record("api", 0.0192)), undefined, "no line against the session's model");
	assert.equal(describeTrace(record("sub", 0.0096)), `${time} /compact: summary by proxy/gpt-4o-mini, the prompt cache has expired: 60k in, 1k out, $0.0096, 1.0s, summary 17 chars`);
	assert.equal(describeTrace(record("sub", 0)), `${time} /compact: summary by proxy/gpt-4o-mini, the prompt cache has expired: 60k in, 1k out, on a subscription, 1.0s, summary 17 chars`);
	assert.equal(describeTrace(record("api", 0)), `${time} /compact: summary by proxy/gpt-4o-mini, the prompt cache has expired: 60k in, 1k out, no price, 1.0s, summary 17 chars`);
});

// Review of 0.10.0, round 2: the expanded card names the route by the cost line's rule: a cost recorded is an API key's
// (also on a route announced as a subscription), no cost on a subscription is the subscription's.
test("round 2, the card details: a cost recorded on a subscription route reads API key, as the cost line shows it; no cost reads subscription", () => {
	const record = (via: "sub" | "api" | "sub or api", cost: number): CompactTrace & TraceRecord => ({
		event: "compact",
		trigger: "manual",
		model: "anthropic/claude-haiku-5-5",
		outcome: "cold",
		reason: "the prompt cache has expired",
		tokensBefore: 120_000,
		cwd: "/",
		at: "2026-11-22T13:48:54.000Z",
		session: "s",
		cold: { model: "proxy/gpt-4o-mini", via, requests: 1, response: { seconds: 1, usage: { input: 60_000, cacheRead: 0, cacheWrite: 0, output: 1_000, cost }, summaryChars: 17 } },
	});
	const route = (r: CompactTrace) => /^fallback model: proxy\/gpt-4o-mini \(([^)]*)\)/.exec(traceDetails(r)[0])?.[1];
	assert.match(describeTrace(record("sub", 0.0096)), /\$0\.0096/);
	assert.equal(route(record("sub", 0.0096)), "API key", "a recorded cost on a subscription route");
	assert.equal(route(record("sub or api", 0.0096)), "API key");
	assert.equal(route(record("api", 0.0096)), "API key");
	assert.match(describeTrace(record("sub", 0)), /on a subscription/);
	assert.equal(route(record("sub", 0)), "subscription", "no cost on a subscription");
	assert.equal(route(record("sub or api", 0)), "subscription or API key");
	assert.equal(route(record("api", 0)), "API key");
	// Skipped before a reply: the route as it was announced.
	assert.equal(route({ ...record("sub", 0), outcome: "fallback", cold: { model: "proxy/gpt-4o-mini", via: "sub", skipped: "it returned no summary text" } }), "subscription");
});
