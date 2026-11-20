import assert from "node:assert/strict";
import test from "node:test";
import { agrees, FIVE_MINUTES_MS, ONE_HOUR_MS, periodLifetime, requestLifetime, routeLifetime, shortestMs, written, writtenMs, type Report } from "../lifetime-evidence.ts";

const HOUR = ONE_HOUR_MS;
const FIVE = FIVE_MINUTES_MS;

test("what a report wrote: nothing, all of it in the 1-hour cache, none of it there, some in each, or no breakdown", () => {
	assert.equal(written({ cacheWrite: 0, cacheWrite1h: 0 }), "nothing");
	assert.equal(written({ cacheWrite: 0 }), "nothing");
	assert.equal(written({ cacheWrite: 120_000, cacheWrite1h: 120_000 }), "hour");
	assert.equal(written({ cacheWrite: 120_000, cacheWrite1h: 0 }), "five minutes");
	assert.equal(written({ cacheWrite: 180_000, cacheWrite1h: 4_096 }), "both");
	assert.equal(written({ cacheWrite: 120_000 }), "no breakdown");
	assert.deepEqual(
		(["nothing", "hour", "five minutes", "both", "no breakdown"] as const).map((w) => writtenMs(w)),
		[undefined, HOUR, FIVE, FIVE, undefined],
		"a write in both counts as the shorter",
	);
});

test("how a request comes by its lifetime: stated; else the route's data, with the default of a marker without ttl or of an Anthropic request without markers", () => {
	assert.deepEqual(requestLifetime("anthropic-messages", HOUR), { statedMs: HOUR });
	assert.deepEqual(requestLifetime("anthropic-messages", undefined, FIVE), { defaultMs: FIVE });
	assert.deepEqual(requestLifetime("anthropic-messages", undefined), { defaultMs: FIVE }, "no marker: five minutes");
	assert.deepEqual(requestLifetime("openai-completions", undefined, FIVE), { defaultMs: FIVE }, "cache_control without ttl, wherever it is carried");
	assert.deepEqual(requestLifetime("openai-completions", undefined), {}, "no breakdown, no marker: no default of its own");
	assert.deepEqual(requestLifetime("openai-responses", 1_800_000), { statedMs: 1_800_000 });
	// The period's lifetime, and whether its answer has to confirm it.
	assert.deepEqual(periodLifetime({ defaultMs: FIVE }, HOUR), { ms: HOUR, stated: false, confirm: true }, "a route whose short tier lasts an hour");
	assert.deepEqual(periodLifetime({ defaultMs: FIVE }, FIVE), { ms: FIVE, stated: false, confirm: false });
	assert.deepEqual(periodLifetime({ defaultMs: FIVE }, undefined), { ms: FIVE, stated: false, confirm: false }, "no data: the default");
	assert.deepEqual(periodLifetime({ statedMs: HOUR }, 7_200_000), { ms: HOUR, stated: true, confirm: false });
	assert.deepEqual(periodLifetime({}, 1_800_000), { ms: 1_800_000, stated: false, confirm: false }, "no breakdown: by the data");
	assert.equal(periodLifetime({}, undefined), undefined);
	// The route read: the data, with the default where the request states nothing.
	assert.equal(routeLifetime({ statedMs: HOUR }, undefined), undefined);
	assert.equal(routeLifetime({ defaultMs: FIVE }, undefined), FIVE);
	assert.equal(routeLifetime({ defaultMs: FIVE }, HOUR), HOUR);
});

const answer = (w: Report["written"]): Report => ({ from: "answer", written: w });
const earlier = (w: Report["written"]): Report => ({ from: "earlier answer", written: w });
const pi = (w: Report["written"]): Report => ({ from: "Pi's refresh", written: w });
const own = (w: Report["written"]): Report => ({ from: "refresh", written: w });
const confirmedHour = { ms: HOUR, stated: false, confirm: true };
const statedHour = { ms: HOUR, stated: true, confirm: false };
const fiveDefault = { ms: FIVE, stated: false, confirm: false };
const noBreakdown = { ms: 1_800_000, stated: false, confirm: false };

test("confirmation: only the period's own answer, writing all of it into the cache of that lifetime", () => {
	assert.deepEqual(agrees(confirmedHour, { reports: [answer("hour")], routeMs: HOUR }, true), { agrees: true });
	for (const w of ["nothing", "five minutes", "no breakdown", "both"] as const) {
		assert.equal(agrees(confirmedHour, { reports: [answer(w)], routeMs: HOUR }, true).agrees, false, w);
	}
	// An earlier answer's hour write, a refresh's, Pi's: none of them confirms.
	assert.deepEqual(agrees(confirmedHour, { reports: [answer("nothing"), earlier("hour")], routeMs: HOUR }, true), { agrees: false, why: "unconfirmed" });
	assert.deepEqual(agrees(confirmedHour, { reports: [answer("nothing"), pi("hour"), own("hour")], routeMs: HOUR }, false), { agrees: false, why: "unconfirmed" });
	// A 30-minute route lifetime for a marker without ttl: no write can confirm it.
	assert.equal(agrees({ ms: 1_800_000, stated: false, confirm: true }, { reports: [answer("hour")], routeMs: 1_800_000 }, true).agrees, false);
});

test("against, for a lifetime the request does not state: any write of another lifetime or into both caches, from any report, at any ask; the route now giving another", () => {
	for (const report of [earlier("both"), earlier("five minutes"), pi("five minutes"), pi("both"), own("five minutes"), own("both")]) {
		for (const atStart of [true, false]) {
			const verdict = agrees(confirmedHour, { reports: [answer("hour"), report], routeMs: HOUR }, atStart);
			assert.deepEqual(verdict.agrees ? undefined : verdict.why, "write", `${report.from} ${report.written}, ${atStart ? "at the start" : "later"}`);
		}
	}
	assert.deepEqual(agrees(fiveDefault, { reports: [answer("both")], routeMs: FIVE }, true), { agrees: false, why: "write", report: answer("both"), ms: FIVE }, "the answer's own, into both");
	// Longer is against too: not the lifetime counted with.
	assert.equal(agrees(fiveDefault, { reports: [answer("five minutes"), pi("hour")], routeMs: FIVE }, false).agrees, false);
	assert.deepEqual(agrees(confirmedHour, { reports: [answer("hour")], routeMs: FIVE }, false), { agrees: false, why: "route", routeMs: FIVE });
	assert.deepEqual(agrees(noBreakdown, { reports: [answer("no breakdown")], routeMs: undefined }, false), { agrees: false, why: "route", routeMs: undefined }, "unknown");
	// What agrees: writes of the same lifetime, reads, writes without breakdown.
	assert.deepEqual(agrees(confirmedHour, { reports: [answer("hour"), pi("hour"), pi("nothing"), own("hour"), own("nothing")], routeMs: HOUR }, false), { agrees: true });
	assert.deepEqual(agrees(noBreakdown, { reports: [answer("no breakdown"), pi("no breakdown"), own("no breakdown")], routeMs: 1_800_000 }, false), { agrees: true }, "no breakdown: never against");
});

test("against, for a lifetime the request states: at the start both ways (its answer, the model's latest write, the route); after it, only what shows a shorter lifetime", () => {
	// At the start (as Part A decides): the data must be the stated lifetime, the answer's write (or the latest before it) too.
	assert.deepEqual(agrees(statedHour, { reports: [answer("nothing")], routeMs: 7_200_000 }, true), { agrees: false, why: "route", routeMs: 7_200_000 });
	assert.deepEqual(agrees(statedHour, { reports: [answer("nothing")], routeMs: undefined }, true), { agrees: true }, "no data: the stated hour");
	assert.equal(agrees(statedHour, { reports: [answer("five minutes")], routeMs: HOUR }, true).agrees, false);
	assert.equal(agrees(statedHour, { reports: [answer("nothing"), earlier("both")], routeMs: HOUR }, true).agrees, false, "a mixed write before it");
	assert.equal(agrees({ ms: FIVE, stated: true, confirm: false }, { reports: [answer("hour")], routeMs: FIVE }, true).agrees, false, "the answer's own write, longer");
	// After it: shorter only.
	assert.deepEqual(agrees(statedHour, { reports: [answer("hour")], routeMs: 7_200_000 }, false), { agrees: true }, "the route now longer");
	assert.deepEqual(agrees(statedHour, { reports: [answer("hour")], routeMs: undefined }, false), { agrees: true }, "the route now unknown: the stated hour");
	assert.deepEqual(agrees(statedHour, { reports: [answer("hour")], routeMs: FIVE }, false), { agrees: false, why: "route", routeMs: FIVE });
	for (const report of [pi("five minutes"), pi("both"), own("five minutes"), own("both")]) {
		assert.equal(agrees(statedHour, { reports: [answer("hour"), report], routeMs: HOUR }, false).agrees, false, `${report.from} ${report.written}`);
	}
	assert.deepEqual(agrees({ ms: FIVE, stated: true, confirm: false }, { reports: [answer("five minutes"), pi("hour"), own("both")], routeMs: FIVE }, false), { agrees: true }, "longer, or both on a five-minute request");
});

test("the countdown after a hand-over: the shortest lifetime read, a write in both as the shorter; when in doubt, expired", () => {
	assert.equal(shortestMs(confirmedHour, { reports: [answer("hour"), pi("both")], routeMs: HOUR }), FIVE);
	assert.equal(shortestMs(confirmedHour, { reports: [answer("hour"), own("five minutes")], routeMs: HOUR }), FIVE);
	assert.equal(shortestMs(confirmedHour, { reports: [answer("hour")], routeMs: FIVE }), FIVE);
	assert.equal(shortestMs(confirmedHour, { reports: [answer("hour")], routeMs: 7_200_000 }), HOUR, "never longer than the period's");
	assert.equal(shortestMs({ ms: FIVE, stated: false, confirm: false }, { reports: [answer("five minutes")], routeMs: undefined }), 0, "unknown: expired");
	assert.equal(shortestMs(noBreakdown, { reports: [], routeMs: undefined }), 0, "unknown: expired");
	assert.equal(shortestMs(statedHour, { reports: [answer("hour")], routeMs: undefined }), HOUR);
});
