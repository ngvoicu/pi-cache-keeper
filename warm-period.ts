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
 * | ended   | nothing: only a new real answer starts a new period (a new state); a hit reported by the refresh that was out when it ended still counts for the expiry | |
 *
 * In `out` nothing leaves for the period, whatever else happens (a run that sent nothing, Pi's own refresh moving the
 * expiry, the 10-minute release of the per-model hold): only the settlement of that refresh, by its id, takes it out.
 * Being left to Pi (two refreshes in a row without a hit) is not a state here: the period is no longer owned. Passing
 * hold-ups move nothing and the period stays waiting: too late for this expiry, Pi busy, held by another refresh of the
 * model, cancelled before it left.
 */
export type WarmPhase = (
	| { readonly phase: "waiting" }
	| { readonly phase: "out"; readonly id: number; /** When it passed the last gate. */ readonly sentAt: number }
	| {
			readonly phase: "ended";
			readonly stop: WarmStop;
			readonly reason: string;
			/** The refresh that was out when warming ended: a hit it still reports counts for the expiry. */
			readonly out?: { readonly id: number; readonly sentAt: number };
	  }
) & {
	/** When the latest of the period's refreshes that reported a hit left (passed the last gate), in any state. */
	readonly refreshedAt?: number;
};

/** How a refresh that left settled: it reported a hit, or anything else, with why warming ends. */
export type WarmSettlement = { hit: true } | { hit: false; stop: WarmStop; reason: string };

/** A new period: nothing has left yet. */
export const WAITING: WarmPhase = { phase: "waiting" };

/** Whether a refresh of this period may leave now: only while waiting. */
export function mayLeave(state: WarmPhase): boolean {
	return state.phase === "waiting";
}

const kept = (state: WarmPhase) => (state.refreshedAt === undefined ? {} : { refreshedAt: state.refreshedAt });

/** waiting → out: the refresh `id` passed the last gate and leaves at `at`. In any other state it does not leave. */
export function leave(state: WarmPhase, id: number, at: number): WarmPhase {
	return state.phase === "waiting" ? { phase: "out", id, sentAt: at, ...kept(state) } : state;
}

/**
 * out → waiting or ended: the refresh `id` settled. A hit, whatever came after it, refreshes the cache from its send
 * time; anything else ends warming. A settlement of another refresh, or in another state, changes nothing.
 */
export function settle(state: WarmPhase, id: number, outcome: WarmSettlement): WarmPhase {
	// Ended while it was out (the budget, say): it stays ended, but the cache its hit renewed is counted from it.
	if (state.phase === "ended") return state.out?.id === id && outcome.hit ? { ...state, refreshedAt: state.out.sentAt } : state;
	if (state.phase !== "out" || state.id !== id) return state;
	return outcome.hit ? { phase: "waiting", refreshedAt: state.sentAt } : { phase: "ended", stop: outcome.stop, reason: outcome.reason, ...kept(state) };
}

/** waiting or out → ended (budget, time limit, unable; from waiting also a failure before the refresh left). Once ended, it stays. */
export function end(state: WarmPhase, stop: WarmStop, reason: string): WarmPhase {
	if (state.phase === "ended") return state;
	return { phase: "ended", stop, reason, ...kept(state), ...(state.phase === "out" ? { out: { id: state.id, sentAt: state.sentAt } } : {}) };
}

/**
 * An owned period's expiry, from its own facts only: the later of the time of the real answer that started it and the
 * moment its latest refresh that reported a hit left, plus the period's lifetime. Both are at or before the moment the
 * provider renewed the cache, so this is never later than the true expiry. Nothing else moves it: not the start of a
 * refresh's preparation, not another period's settlement, not Pi's own refresh entries or when they were recorded.
 */
export function expiryOf(state: WarmPhase, answeredAt: number, lifetimeMs: number): number {
	return Math.max(answeredAt, state.refreshedAt ?? answeredAt) + lifetimeMs;
}
