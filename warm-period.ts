import type { WarmStop } from "./trace.ts";

/**
 * Where an owned idle period's refreshes stand, as one of three states; only the functions below move it.
 *
 * | State   | Event                                                                 | Next                          |
 * |---------|-----------------------------------------------------------------------|-------------------------------|
 * | waiting | the refresh passes the last gate and leaves (`leave`)                 | out                           |
 * | waiting | the refresh fails before it leaves (`end`, "failed"): nothing sent, nothing spent or counted | ended |
 * | out     | it settles having reported a hit, however it ended afterwards        | waiting, refreshed at its send |
 * | out     | it settles any other way (a miss, no prompt usage, cancelled or failed before reporting) | ended   |
 * | waiting, out | budget, time limit, unable (`end`)                              | ended                         |
 * | ended   | nothing: only a new real answer starts a new period (a new state)     |                               |
 *
 * In `out` nothing leaves for the period, whatever else happens (a run that sent nothing, Pi's own refresh moving the
 * expiry, the 10-minute release of the per-model hold): only the settlement of that refresh, by its id, takes it out.
 * Being left to Pi (two refreshes in a row without a hit) is not a state here: the period is no longer owned. Passing
 * hold-ups move nothing and the period stays waiting: too late for this expiry, Pi busy, held by another refresh of the
 * model, cancelled before it left.
 */
export type WarmPhase =
	| { readonly phase: "waiting"; /** The send time of the latest refresh that reported a hit, if any. */ readonly refreshedAt?: number }
	| { readonly phase: "out"; readonly id: number; readonly sentAt: number }
	| { readonly phase: "ended"; readonly stop: WarmStop; readonly reason: string };

/** How a refresh that left settled: it reported a hit, or anything else, with why warming ends. */
export type WarmSettlement = { hit: true } | { hit: false; stop: WarmStop; reason: string };

/** A new period: nothing has left yet. */
export const WAITING: WarmPhase = { phase: "waiting" };

/** Whether a refresh of this period may leave now: only while waiting. */
export function mayLeave(state: WarmPhase): boolean {
	return state.phase === "waiting";
}

/** waiting → out: the refresh `id` passed the last gate and leaves at `at`. In any other state it does not leave. */
export function leave(state: WarmPhase, id: number, at: number): WarmPhase {
	return state.phase === "waiting" ? { phase: "out", id, sentAt: at } : state;
}

/**
 * out → waiting or ended: the refresh `id` settled. A hit, whatever came after it, refreshes the cache from its send
 * time; anything else ends warming. A settlement of another refresh, or in another state, changes nothing.
 */
export function settle(state: WarmPhase, id: number, outcome: WarmSettlement): WarmPhase {
	if (state.phase !== "out" || state.id !== id) return state;
	return outcome.hit ? { phase: "waiting", refreshedAt: state.sentAt } : { phase: "ended", stop: outcome.stop, reason: outcome.reason };
}

/** waiting or out → ended (budget, time limit, unable; from waiting also a failure before the refresh left). Once ended, it stays. */
export function end(state: WarmPhase, stop: WarmStop, reason: string): WarmPhase {
	return state.phase === "ended" ? state : { phase: "ended", stop, reason };
}
