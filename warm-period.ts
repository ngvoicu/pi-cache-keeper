import type { WarmStop } from "./trace.ts";

/**
 * The only owner of "who warms this period", and of what Pi's own warming is told. It sees no lifetime and no expiry:
 * the cache's clock is cache-clock.ts's, and reaches this file only as what its reading says (`goneBy`, evidence
 * against the period, the cache lasting to the end of the window), through index.ts.
 *
 * Where a taken idle period's refreshes stand, as one of three states; only the functions below move it.
 *
 * | State   | Event                                                                 | Next                          |
 * |---------|-----------------------------------------------------------------------|-------------------------------|
 * | waiting | the refresh passes the last gate and leaves (`leave`)                 | out                           |
 * | waiting | the refresh fails before it leaves (`end`, "failed"): nothing sent, nothing spent or counted | ended |
 * | out     | it settles having reported a hit, however it ended afterwards        | waiting; the hit counts from its send |
 * | out     | it settles any other way (a miss, no prompt usage, cancelled or failed before reporting) | ended   |
 * | waiting, out | budget, time limit, unable (`end`)                              | ended                         |
 * | ended   | nothing: only a new real answer starts a new period (a new state); a hit reported by the refresh that was out when it ended still counts for the cache | |
 *
 * In `out` nothing leaves for the period, whatever else happens (a run that sent nothing, Pi's own refresh, the 10-minute
 * release of the per-model hold): only the settlement of that refresh, by its id, takes it out. Passing hold-ups move
 * nothing and the period stays waiting: too late for this expiry, Pi busy, held by another refresh of the model,
 * cancelled before it left.
 */
export type WarmPhase =
	| { readonly phase: "waiting" }
	| { readonly phase: "out"; readonly id: number; /** When it passed the last gate. */ readonly sentAt: number }
	| {
			readonly phase: "ended";
			readonly stop: WarmStop;
			readonly reason: string;
			/** The refresh that was out when warming ended: a hit it still reports counts for the cache. */
			readonly out?: { readonly id: number; readonly sentAt: number };
	  };

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
 * out → waiting or ended: the refresh `id` settled. A hit, whatever came after it, renewed the cache when it left
 * (`hitSentAt`: the clock is told by the same call); anything else ends warming. A settlement of another refresh, or in
 * another state, changes nothing.
 */
export function settle(state: WarmPhase, id: number, outcome: WarmSettlement): { state: WarmPhase; hitSentAt?: number } {
	// Ended while it was out (the budget, say): it stays ended, but the cache its hit renewed is counted from it.
	if (state.phase === "ended") return state.out?.id === id && outcome.hit ? { state, hitSentAt: state.out.sentAt } : { state };
	if (state.phase !== "out" || state.id !== id) return { state };
	return outcome.hit ? { state: WAITING, hitSentAt: state.sentAt } : { state: { phase: "ended", stop: outcome.stop, reason: outcome.reason } };
}

/** waiting or out → ended (budget, time limit, unable; from waiting also a failure before the refresh left). Once ended, it stays. */
export function end(state: WarmPhase, stop: WarmStop, reason: string): WarmPhase {
	if (state.phase === "ended") return state;
	return { phase: "ended", stop, reason, ...(state.phase === "out" ? { out: { id: state.id, sentAt: state.sentAt } } : {}) };
}

/**
 * Who warms a period:
 * - Pi: the extension did not take it at its start (`taken`: nothing kept it from it, keep-warm read on then), or
 *   keep-warm reads off now, or two refreshes in a row without a hit left the model to Pi (`fellBack`);
 * - Pi, handed over: taken, and handed over since, on evidence against its lifetime or because its request was let go;
 * - nobody: taken, warming ended and not handed over: Pi's own warming stays stopped;
 * - the extension: otherwise (waiting, or a refresh out).
 */
export type Warmer = "the extension" | "nobody" | "Pi" | "Pi, handed over";
export function warmer(p: { taken: boolean; on: boolean; fellBack: boolean; handedOver: boolean; warm: WarmPhase }): Warmer {
	if (!p.taken || !p.on || p.fellBack) return "Pi";
	if (p.handedOver) return "Pi, handed over";
	return p.warm.phase === "ended" ? "nobody" : "the extension";
}

/**
 * What evidence against a period's lifetime, or its request let go, does to it. The extension's period (waiting, out)
 * ends its warming ("unable") and is handed over; a period whose warming ended on its time limit or as "unable" is handed
 * over; one ended on its budget, a miss, an unreported or a failed refresh stays as it is (Pi's warming stays stopped),
 * and so does a period already Pi's.
 */
export function onAgainst(w: Warmer, state: WarmPhase): "end and hand over" | "hand over" | "stays" {
	if (w === "the extension") return "end and hand over";
	if (w === "nobody" && state.phase === "ended" && (state.stop === "limit" || state.stop === "unable")) return "hand over";
	return "stays";
}

/**
 * What Pi's own warming is told when it asks while Pi is idle (`idle`): "stop" while the extension warms the period or
 * nobody does; for a period handed over to Pi, "stop" only at or after `goneBy`, when nothing seen (Pi's own refreshes
 * included) says the cache can be alive; nothing where no lifetime can be read (`goneBy` undefined), and nothing for a
 * period that is Pi's. The only place "stop" is written.
 */
export function answerToPi(o: { warmer: Warmer; idle: boolean; goneBy: number | undefined; now: number }): "stop" | undefined {
	if (!o.idle || o.warmer === "Pi") return undefined;
	if (o.warmer === "Pi, handed over") return o.goneBy !== undefined && o.now >= o.goneBy ? "stop" : undefined;
	return "stop";
}
