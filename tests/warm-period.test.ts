// The period's rule (warm-period.ts), driven directly through every row of its table.
import assert from "node:assert/strict";
import { test } from "node:test";
import { end, leave, mayLeave, settle, WAITING, type WarmPhase } from "../warm-period.ts";

const out = (id = 1, sentAt = 275_000): WarmPhase => leave(WAITING, id, sentAt);
const ENDED: WarmPhase = { phase: "ended", stop: "missed", reason: "the refresh read only 49% from the cache, so it wrote the context again" };

test("waiting: the refresh that passes the last gate leaves, and the period is out", () => {
	assert.equal(mayLeave(WAITING), true);
	assert.deepEqual(leave(WAITING, 7, 275_000), { phase: "out", id: 7, sentAt: 275_000 });
	// After a hit it is waiting again, and the next one may leave.
	const again = settle(out(1, 275_000), 1, { hit: true });
	assert.equal(mayLeave(again), true);
	assert.deepEqual(leave(again, 2, 550_000), { phase: "out", id: 2, sentAt: 550_000 });
});

test("out: nothing else leaves, whatever happens, until that refresh settles", () => {
	const state = out(1);
	assert.equal(mayLeave(state), false);
	// A second refresh prepared meanwhile does not leave; the state is unchanged.
	assert.equal(leave(state, 2, 400_000), state);
	// The settlement of any other refresh does not take it out of "out".
	assert.equal(settle(state, 2, { hit: true }), state);
	assert.equal(settle(state, 2, { hit: false, stop: "unknown", reason: "x" }), state);
});

test("out → waiting: it settled having reported a hit, the expiry counted from its send time", () => {
	assert.deepEqual(settle(out(3, 275_000), 3, { hit: true }), { phase: "waiting", refreshedAt: 275_000 });
});

test("out → ended: it settled any other way, with the reason", () => {
	for (const [stop, reason] of [
		["missed", "the refresh read only 49% from the cache, so it wrote the context again"],
		["unknown", "the refresh reported no usage, so what it cost is unknown"],
		["unknown", "the refresh was cancelled before it reported usage, so what it cost is unknown"],
		["failed", "overloaded"],
	] as const) {
		assert.deepEqual(settle(out(4), 4, { hit: false, stop, reason }), { phase: "ended", stop, reason });
	}
});

test("waiting or out → ended: budget, time limit, unable, a failure before it left", () => {
	for (const from of [WAITING, out(5)]) {
		for (const stop of ["budget", "limit", "unable", "failed"] as const) {
			const ended = end(from, stop, `because ${stop}`);
			assert.deepEqual(ended, { phase: "ended", stop, reason: `because ${stop}` });
			assert.equal(mayLeave(ended), false);
		}
	}
	// Ended while out: that refresh's settlement, a hit included, changes nothing.
	const ended = end(out(6), "budget", "spent");
	assert.equal(settle(ended, 6, { hit: true }), ended);
});

test("ended: nothing moves it; only a new real answer starts a new period, at waiting", () => {
	assert.equal(mayLeave(ENDED), false);
	assert.equal(leave(ENDED, 9, 1), ENDED);
	assert.equal(settle(ENDED, 9, { hit: true }), ENDED);
	assert.equal(end(ENDED, "budget", "later"), ENDED, "the first reason stays");
	assert.deepEqual(WAITING, { phase: "waiting" });
});
