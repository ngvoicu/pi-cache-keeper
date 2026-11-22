// The period's rule (warm-period.ts), driven directly through every row of its table.
import assert from "node:assert/strict";
import { test } from "node:test";
import { answerToPi, end, leave, mayLeave, onAgainst, settle, WAITING, warmer, type Warmer, type WarmPhase } from "../warm-period.ts";

const out = (id = 1, sentAt = 275_000): WarmPhase => leave(WAITING, id, sentAt);
const ENDED: WarmPhase = { phase: "ended", stop: "missed", reason: "the refresh read only 49% from the cache, so it wrote the context again" };

test("waiting: the refresh that passes the last gate leaves, and the period is out", () => {
	assert.equal(mayLeave(WAITING), true);
	assert.deepEqual(leave(WAITING, 7, 275_000), { phase: "out", id: 7, sentAt: 275_000 });
	// After a hit it is waiting again, and the next one may leave.
	const again = settle(out(1, 275_000), 1, { hit: true });
	assert.equal(mayLeave(again.state), true);
	assert.deepEqual(leave(again.state, 2, 550_000), { phase: "out", id: 2, sentAt: 550_000 }, "the hit's time is the clock's, not the phase's");
});

test("out: nothing else leaves, whatever happens, until that refresh settles", () => {
	const state = out(1);
	assert.equal(mayLeave(state), false);
	// A second refresh prepared meanwhile does not leave; the state is unchanged.
	assert.equal(leave(state, 2, 400_000), state);
	// The settlement of any other refresh does not take it out of "out".
	assert.deepEqual(settle(state, 2, { hit: true }), { state });
	assert.deepEqual(settle(state, 2, { hit: false, stop: "unknown", reason: "x" }), { state });
});

test("out → waiting: it settled having reported a hit, the expiry counted from its send time", () => {
	assert.deepEqual(settle(out(3, 275_000), 3, { hit: true }), { state: { phase: "waiting" }, hitSentAt: 275_000 });
});

test("out → ended: it settled any other way, with the reason", () => {
	for (const [stop, reason] of [
		["missed", "the refresh read only 49% from the cache, so it wrote the context again"],
		["unknown", "the refresh reported no usage, so what it cost is unknown"],
		["unknown", "the refresh was cancelled before it reported usage, so what it cost is unknown"],
		["failed", "overloaded"],
	] as const) {
		assert.deepEqual(settle(out(4), 4, { hit: false, stop, reason }), { state: { phase: "ended", stop, reason } });
	}
});

test("waiting → ended: the refresh failed before it left, so nothing was sent", () => {
	assert.deepEqual(end(WAITING, "failed", "no API key"), { phase: "ended", stop: "failed", reason: "no API key" });
});

test("waiting or out → ended: budget, time limit, unable", () => {
	for (const from of [WAITING, out(5)]) {
		for (const stop of ["budget", "limit", "unable"] as const) {
			const ended = end(from, stop, `because ${stop}`);
			assert.deepEqual(ended, { phase: "ended", stop, reason: `because ${stop}`, ...(from.phase === "out" ? { out: { id: 5, sentAt: 275_000 } } : {}) });
			assert.equal(mayLeave(ended), false);
		}
	}
	// Ended while out: that refresh's settlement leaves it ended; a hit it reports still counts for the expiry.
	const ended = end(out(6, 275_000), "budget", "spent");
	assert.deepEqual(settle(ended, 6, { hit: true }), { state: ended, hitSentAt: 275_000 });
	assert.deepEqual(settle(ended, 6, { hit: false, stop: "missed", reason: "x" }), { state: ended });
	assert.deepEqual(settle(ended, 7, { hit: true }), { state: ended }, "another refresh's hit: nothing");
});

test("ended: nothing moves it; only a new real answer starts a new period, at waiting", () => {
	assert.equal(mayLeave(ENDED), false);
	assert.equal(leave(ENDED, 9, 1), ENDED);
	assert.deepEqual(settle(ENDED, 9, { hit: true }), { state: ENDED });
	assert.equal(end(ENDED, "budget", "later"), ENDED, "the first reason stays");
	assert.deepEqual(WAITING, { phase: "waiting" });
});

// ------------------------------------------------------------------------------------------ who warms, what Pi is told

const PHASES: [string, WarmPhase][] = [
	["waiting", WAITING],
	["out", out(1)],
	["ended", ENDED],
];
const BOOLS = [false, true];

test("who warms: every combination of stopped, taken, keep-warm on, two misses on the model, handed over, and the phase", () => {
	let rows = 0;
	for (const stopped of BOOLS)
		for (const taken of BOOLS)
			for (const on of BOOLS)
				for (const fellBack of BOOLS)
					for (const handedOver of BOOLS)
						for (const [phase, warm] of PHASES) {
							// The table of the design: a stop first, whatever else holds; then Pi where not taken, keep-warm off or two
							// misses; then handed over; then ended.
							const expected: Warmer = stopped ? "nobody, stopped" : !taken || !on || fellBack ? "Pi" : handedOver ? "Pi, handed over" : phase === "ended" ? "nobody" : "the extension";
							assert.equal(warmer({ stopped, taken, on, fellBack, handedOver, warm }), expected, JSON.stringify({ stopped, taken, on, fellBack, handedOver, phase }));
							rows++;
						}
	assert.equal(rows, 96);
});

test("a stop ends warming from waiting and from out; from out a hit the refresh still reports counts for the cache, a miss does not", () => {
	assert.deepEqual(end(WAITING, "stopped", "given at 14:02"), { phase: "ended", stop: "stopped", reason: "given at 14:02" });
	const stopped = end(out(4, 275_000), "stopped", "given at 14:02");
	assert.deepEqual(stopped, { phase: "ended", stop: "stopped", reason: "given at 14:02", out: { id: 4, sentAt: 275_000 } });
	assert.deepEqual(settle(stopped, 4, { hit: true }), { state: stopped, hitSentAt: 275_000 });
	assert.deepEqual(settle(stopped, 4, { hit: false, stop: "missed", reason: "x" }), { state: stopped });
});

test("evidence against, or the request let go: the extension's period ends and is handed over; one ended on its limit or as unable is handed over; the rest stays", () => {
	const ended = (stop: "budget" | "limit" | "missed" | "failed" | "unable" | "unknown" | "stopped"): WarmPhase => ({ phase: "ended", stop, reason: stop });
	assert.equal(onAgainst("the extension", WAITING), "end and hand over");
	assert.equal(onAgainst("the extension", out(1)), "end and hand over");
	for (const stop of ["limit", "unable"] as const) assert.equal(onAgainst("nobody", ended(stop)), "hand over", stop);
	for (const stop of ["budget", "missed", "failed", "unknown"] as const) assert.equal(onAgainst("nobody", ended(stop)), "stays", stop);
	for (const who of ["Pi", "Pi, handed over", "nobody, stopped"] as const) for (const [, warm] of PHASES) assert.equal(onAgainst(who, warm), "stays", who);
	// A stopped period is never handed over to Pi, whatever its warming ended on.
	for (const stop of ["limit", "unable", "stopped"] as const) assert.equal(onAgainst("nobody, stopped", ended(stop)), "stays", stop);
});

test("what Pi is told: stop while the extension warms or nobody does, a stopped period included; after a hand-over only at or after goneBy; never while busy, never for Pi's own", () => {
	const S = 1000;
	for (const who of ["the extension", "nobody", "nobody, stopped", "Pi", "Pi, handed over"] as const)
		for (const idle of BOOLS)
			for (const goneBy of [undefined, 300 * S])
				for (const now of [299 * S, 300 * S, 301 * S]) {
					const expected = !idle || who === "Pi" ? undefined : who === "Pi, handed over" ? (goneBy !== undefined && now >= goneBy ? "stop" : undefined) : "stop";
					assert.equal(answerToPi({ warmer: who, idle, goneBy, now }), expected, JSON.stringify({ who, idle, goneBy, now }));
				}
	// The four sequences of the design, Pi asking in a period handed over to it.
	const handed = (goneBy: number | undefined, at: number) => answerToPi({ warmer: "Pi, handed over", idle: true, goneBy: goneBy === undefined ? undefined : goneBy * S, now: at * S });
	assert.equal(handed(150, 270), "stop", "a 300-second route announced as 150 s at 100 s: stopped at 270 s");
	assert.equal(handed(300, 270), undefined, "announced as 600 s: Pi refreshes at 270 s");
	assert.equal(handed(571, 540), undefined, "then, after Pi's receipt at 271 s, at 540 s too");
	assert.equal(handed(573, 543), undefined, "the covered period, Pi's receipt at 273 s: Pi's request at 543 s goes out");
	assert.equal(handed(3600, 270), undefined, "a model switch away and back on the hour route: Pi refreshes at 270 s");
	assert.equal(handed(undefined, 99_999), undefined, "no lifetime readable: never stopped");
});
