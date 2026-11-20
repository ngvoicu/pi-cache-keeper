// The clock of a keep-warm period (cache-clock.ts): what it reads from each sequence of facts the reviews replayed, the
// start's verdicts, and two properties over random sequences.
import assert from "node:assert/strict";
import test from "node:test";
import { cacheView, PeriodClock, startFacts, type CacheView, type RequestCache } from "../cache-clock.ts";
import { agrees, FIVE_MINUTES_MS, ONE_HOUR_MS, periodLifetime, requestLifetime, routeLifetime, type Report } from "../lifetime-evidence.ts";

const S = 1000;
const HOUR = ONE_HOUR_MS;
const FIVE = FIVE_MINUTES_MS;
type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h?: number };

// A gateway model and its branch: the user's message, the period's answer at `at`, and Pi's refreshes recorded after it.
const model = (api: string, promptCache?: { short?: number; long?: number }) =>
	({ provider: "gw", id: "m", api, baseUrl: "https://gateway.invalid", promptCache, contextWindow: 1_000_000, maxTokens: 8192, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }) as never;
function branch(answer: Usage, at = 0) {
	const entries: unknown[] = [
		{ type: "message", id: "u", parentId: null, timestamp: new Date(at).toISOString(), message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: at } },
		{ type: "message", id: "a", parentId: "u", timestamp: new Date(at).toISOString(), message: { role: "assistant", content: [], timestamp: at, stopReason: "stop", provider: "gw", model: "m", usage: answer } },
	];
	return {
		entries: entries as never[],
		// Pi's refresh, recorded at `at`.
		pi: (recordedAt: number, usage: Usage) => entries.push({ type: "usage", id: `w${entries.length}`, parentId: null, kind: "cache_warm", provider: "gw", model: "m", usage, timestamp: new Date(recordedAt).toISOString() }),
	};
}
const PLAIN: RequestCache = { tier: "short", markers: [{ at: "system[0].cache_control", tier: "short", ms: FIVE, implied: true }], mixed: false };
const STATED_HOUR: RequestCache = { tier: "long", markers: [{ at: "system[0].cache_control", tier: "long", ms: HOUR }], mixed: false };
const NO_MARKER: RequestCache = { tier: "short", markers: [], mixed: false };
const HOUR_ANSWER: Usage = { input: 2, output: 5, cacheRead: 0, cacheWrite: 600_000, cacheWrite1h: 600_000 };
const READ: Usage = { input: 2, output: 5, cacheRead: 180_000, cacheWrite: 0 };
const FIVE_WRITE: Usage = { input: 5, output: 1, cacheRead: 570_000, cacheWrite: 30_000, cacheWrite1h: 0 };

// A clock started on the facts as they are at the start, and a reading at any later point.
function started(api: string, route: { short?: number; long?: number }, cache: RequestCache, answer: Usage, routeKey = "A") {
	const m = model(api, route);
	const b = branch(answer);
	const r = startFacts(m, b.entries, cache.tier);
	const atStart = route[cache.tier];
	const start = PeriodClock.start({ facts: r, api, cache, dataMs: atStart === undefined ? undefined : atStart * S, routeKey });
	assert.ok("clock" in start, `the period starts: ${"declined" in start ? start.declined.reason : ""}`);
	const { clock } = start;
	const read = (o: { route?: { short?: number; long?: number }; routeKey?: string } = {}): CacheView => {
		const now = model(api, o.route ?? route);
		const dataMs = (o.route ?? route)[cache.tier];
		return cacheView(now, b.entries, { clock, on: true, routeKey: o.routeKey ?? routeKey, dataMs: dataMs === undefined ? undefined : dataMs * S, requested: cache.tier });
	};
	return { clock, read, pi: b.pi };
}
const seconds = (v: CacheView) => ({ sendBy: v.sendBy === undefined ? undefined : v.sendBy / S, goneBy: v.goneBy === undefined ? undefined : v.goneBy / S, lifetime: v.lifetime && v.lifetime.ms / S, unknown: v.unknown });

test("the reviewer's budget sequence: ten hits on the confirmed hour, the eleventh reads 95% and writes the rest into the five-minute cache: 37,920 s", () => {
	const c = started("anthropic-messages", { short: 3600, long: 3600 }, PLAIN, HOUR_ANSWER);
	for (let n = 1; n <= 10; n++) {
		c.clock.hit(n * 3420 * S);
		c.clock.wrote("nothing");
		assert.equal(c.read().sendBy, (n * 3420 + 3600) * S, `after refresh ${n}`);
	}
	c.clock.hit(37_620 * S);
	c.clock.wrote("five minutes");
	const v = c.read();
	assert.deepEqual(seconds(v), { sendBy: 37_920, goneBy: 37_920, lifetime: 300, unknown: undefined });
	assert.equal(v.lifetime?.source, "the shortest lifetime read since");
	assert.equal(v.against?.reason, "the extension's refresh reports a 5 min cache write; the request's cache lasts 60 min by the route's data");
});

test("the same write on the first refresh: 3,720 s", () => {
	const c = started("anthropic-messages", { short: 3600, long: 3600 }, PLAIN, HOUR_ANSWER);
	c.clock.hit(3420 * S);
	c.clock.wrote("five minutes");
	assert.deepEqual(seconds(c.read()), { sendBy: 3720, goneBy: 3720, lifetime: 300, unknown: undefined });
});

test("a Chat Completions gateway: the refresh at 3,420 s misses and the gateway announces its 150-second route: unknown, gone by 150 s", () => {
	const c = started("openai-completions", { short: 3600, long: 3600 }, NO_MARKER, READ);
	c.clock.wrote("no breakdown");
	c.clock.served("B");
	const v = c.read({ routeKey: "B", route: { short: 150 } });
	assert.deepEqual(seconds(v), { sendBy: undefined, goneBy: 150, lifetime: 150, unknown: "the route changed" });
	assert.equal(v.against?.label, "the route's lifetime changed");
});

for (const variant of ["route B's refresh read everything", "route B's refresh wrote the rest into the five-minute cache"]) {
	test(`a route that returns: ${variant} at 3,420 s, then route A is reported again at 3,450 s: unknown for good, gone by 3,720 s`, () => {
		const c = started("anthropic-messages", { short: 3600, long: 3600 }, PLAIN, HOUR_ANSWER);
		c.clock.hit(3420 * S);
		c.clock.wrote(variant.includes("five") ? "five minutes" : "nothing");
		// The settlement reads while B is the route.
		assert.equal(c.read({ routeKey: "B", route: { short: 300, long: 3600 } }).unknown, "the route changed");
		const back = c.read({ routeKey: "A" });
		assert.deepEqual(seconds(back), { sendBy: undefined, goneBy: 3720, lifetime: 300, unknown: "the route changed" });
		// The first evidence against is kept: the route's lifetime read under B.
		assert.equal(back.against?.reason, "the request's cache now lasts 5 min by the route's data, the cached request was written with 60 min");
	});
}

test("a 300-second route announced at 100 s as a 150-second one: gone by 150 s; as a 600-second one: gone by 300 s, then by 571 s after Pi's refresh at 271 s", () => {
	const shorter = started("openai-completions", { short: 300, long: 300 }, NO_MARKER, READ);
	shorter.clock.served("B");
	assert.deepEqual(seconds(shorter.read({ routeKey: "B", route: { short: 150 } })), { sendBy: undefined, goneBy: 150, lifetime: 150, unknown: "the route changed" });
	const longer = started("openai-completions", { short: 300, long: 300 }, NO_MARKER, READ);
	longer.clock.served("B");
	assert.deepEqual(seconds(longer.read({ routeKey: "B", route: { short: 600 } })), { sendBy: undefined, goneBy: 300, lifetime: 300, unknown: "the route changed" });
	longer.pi(271 * S, { input: 4, output: 1, cacheRead: 1_000_000, cacheWrite: 0 });
	assert.deepEqual(seconds(longer.read({ routeKey: "B", route: { short: 600 } })), { sendBy: undefined, goneBy: 571, lifetime: 300, unknown: "the route changed" });
});

test("a covered period: Pi's refresh recorded at 273 s writes into the five-minute cache, the gateway names its API key's route: gone by 573 s", () => {
	const c = started("anthropic-messages", { short: 3600, long: 3600 }, PLAIN, HOUR_ANSWER);
	c.pi(273 * S, FIVE_WRITE);
	c.clock.served("key");
	assert.deepEqual(seconds(c.read({ routeKey: "key", route: { short: 300, long: 3600 } })), { sendBy: undefined, goneBy: 573, lifetime: 300, unknown: "the route changed" });
});

test("a stated hour, the route now giving its tier five minutes, Pi's refresh recorded at 350 s: sendable until 300 s, gone by 650 s", () => {
	const c = started("anthropic-messages", { short: 300, long: 3600 }, STATED_HOUR, { input: 2, output: 5, cacheRead: 600_000, cacheWrite: 0 });
	c.pi(350 * S, { input: 5, output: 1, cacheRead: 600_000, cacheWrite: 0, cacheWrite1h: 0 });
	assert.deepEqual(seconds(c.read({ route: { short: 300, long: 300 } })), { sendBy: 300, goneBy: 650, lifetime: 300, unknown: undefined });
});

test("the route's data five minutes, then an hour again, on the same route: the floor stays at five minutes, the evidence against is kept", () => {
	const c = started("anthropic-messages", { short: 3600, long: 3600 }, PLAIN, HOUR_ANSWER);
	assert.deepEqual(seconds(c.read()), { sendBy: 3600, goneBy: 3600, lifetime: 3600, unknown: undefined });
	assert.equal(c.read().against, undefined);
	c.read({ route: { short: 300, long: 3600 } });
	const back = c.read();
	assert.deepEqual(seconds(back), { sendBy: 300, goneBy: 300, lifetime: 300, unknown: undefined });
	assert.equal(back.against?.label, "the route's lifetime changed");
});

test("no lifetime can be read any more for a request that states none: unknown, and nothing is gone by", () => {
	const c = started("openai-completions", { short: 1800, long: 1800 }, NO_MARKER, READ);
	const v = c.read({ route: {} });
	assert.deepEqual(seconds(v), { sendBy: undefined, goneBy: undefined, lifetime: undefined, unknown: "no lifetime can be read" });
	assert.equal(v.against?.reason, "the request's cache now lasts an unknown time, the cached request was written with 30 min");
});

test("outside a taken period the reading is the plain one; keep-warm switched off adds the clock's latest hit; another branch is read as itself", () => {
	const c = started("anthropic-messages", { short: 300, long: 300 }, PLAIN, READ);
	const m = model("anthropic-messages", { short: 300, long: 300 });
	const b = branch(READ);
	assert.deepEqual(cacheView(m, b.entries), { regime: "plain", cached: true, replied: true, answeredAt: 0, lifetime: { ms: FIVE, source: "declared by the model" }, sendBy: FIVE });
	c.clock.hit(275 * S);
	const off = cacheView(m, b.entries, { clock: c.clock, on: false, routeKey: "A", dataMs: FIVE, requested: "short" });
	assert.deepEqual([off.regime, off.sendBy], ["plain", 575 * S]);
	// Another branch, whose answer is not the period's.
	const other = branch(READ, 60 * S);
	assert.deepEqual(cacheView(m, other.entries, { clock: c.clock, on: true, routeKey: "A", dataMs: FIVE, requested: "short" }).sendBy, 360 * S);
	// Pi's refreshes move the plain reading, never the period's sending edge.
	b.pi(270 * S, { input: 4, output: 1, cacheRead: 600_000, cacheWrite: 0, cacheWrite1h: 0 });
	assert.equal(cacheView(m, b.entries).sendBy, 570 * S);
	const v = cacheView(m, b.entries, { clock: c.clock, on: true, routeKey: "A", dataMs: FIVE, requested: "short" });
	assert.deepEqual([v.regime, v.sendBy, v.goneBy], ["period", 575 * S, 575 * S]);
});

// ---------------------------------------------------------------------------------------------------------- the start

// The start cases of tests/lifetime-evidence.test.ts, each built as the facts and request the period starts from.
const answerUsage: Record<Report["written"], Usage> = {
	nothing: { input: 2, output: 5, cacheRead: 600_000, cacheWrite: 0 },
	hour: { input: 2, output: 5, cacheRead: 0, cacheWrite: 120_000, cacheWrite1h: 120_000 },
	"five minutes": { input: 2, output: 5, cacheRead: 0, cacheWrite: 120_000, cacheWrite1h: 0 },
	both: { input: 2, output: 5, cacheRead: 0, cacheWrite: 180_000, cacheWrite1h: 4_096 },
	"no breakdown": { input: 2, output: 5, cacheRead: 0, cacheWrite: 120_000 },
};
const START_CASES: { label: string; cache: RequestCache; dataMs: number | undefined; answer: Report["written"]; earlier?: Report["written"]; pi?: Report["written"] }[] = [
	{ label: "a confirmed hour, the answer writing the hour", cache: PLAIN, dataMs: HOUR, answer: "hour" },
	...(["nothing", "five minutes", "no breakdown", "both"] as const).map((answer) => ({ label: `a confirmed hour, the answer: ${answer}`, cache: PLAIN, dataMs: HOUR, answer })),
	{ label: "a confirmed hour, only an earlier answer wrote the hour", cache: PLAIN, dataMs: HOUR, answer: "nothing", earlier: "hour" },
	{ label: "a 30-minute route for a marker without ttl", cache: PLAIN, dataMs: 1_800_000, answer: "hour" },
	...(["both", "five minutes"] as const).map((earlier) => ({ label: `a confirmed hour, an earlier answer wrote ${earlier}`, cache: PLAIN, dataMs: HOUR, answer: "nothing" as const, earlier })),
	...(["five minutes", "both"] as const).map((pi) => ({ label: `a confirmed hour, Pi's refresh wrote ${pi}`, cache: PLAIN, dataMs: HOUR, answer: "hour" as const, pi })),
	{ label: "five minutes by the marker's default, the answer into both", cache: PLAIN, dataMs: FIVE, answer: "both" },
	{ label: "a stated hour, the route's data two hours", cache: STATED_HOUR, dataMs: 7_200_000, answer: "nothing" },
	{ label: "a stated hour, no data", cache: STATED_HOUR, dataMs: undefined, answer: "nothing" },
	{ label: "a stated hour, the answer wrote five minutes", cache: STATED_HOUR, dataMs: HOUR, answer: "five minutes" },
	{ label: "a stated hour, an earlier answer wrote into both", cache: STATED_HOUR, dataMs: HOUR, answer: "nothing", earlier: "both" },
	{ label: "a stated five minutes, the answer wrote the hour", cache: { tier: "short", markers: [{ at: "system[0].cache_control", tier: "short", ms: FIVE }], mixed: false }, dataMs: FIVE, answer: "hour" },
];
const LABELS: Record<string, RegExp> = { unconfirmed: /^route's lifetime unconfirmed$/, route: /^(lifetime differs from the data|the route's lifetime changed)$/, write: /^(both tiers written|Pi's refresh wrote otherwise|mixed cache write|the answer's write lasts otherwise)$/ };

test("the start: every start case of the evidence's own tests gives the same verdict through the clock", () => {
	for (const c of START_CASES) {
		const route = c.dataMs === undefined ? {} : { [c.cache.tier]: c.dataMs / S };
		const m = model("anthropic-messages", route);
		const entries: unknown[] = [];
		if (c.earlier) entries.push({ type: "message", id: "e", parentId: null, timestamp: new Date(0).toISOString(), message: { role: "assistant", content: [], timestamp: 0, stopReason: "stop", provider: "gw", model: "m", usage: answerUsage[c.earlier] } });
		entries.push({ type: "message", id: "a", parentId: null, timestamp: new Date(S).toISOString(), message: { role: "assistant", content: [], timestamp: S, stopReason: "stop", provider: "gw", model: "m", usage: answerUsage[c.answer] } });
		if (c.pi) entries.push({ type: "usage", id: "w", parentId: null, kind: "cache_warm", provider: "gw", model: "m", usage: answerUsage[c.pi], timestamp: new Date(2 * S).toISOString() });
		const facts = startFacts(m, entries as never[], c.cache.tier);
		// The verdict of lifetime-evidence.ts on the same facts.
		const asked = requestLifetime("anthropic-messages", c.cache.markers.find((x) => !x.implied)?.ms, c.cache.markers.find((x) => x.implied)?.ms);
		const lifetime = periodLifetime(asked, c.dataMs)!;
		const reports: Report[] = [{ from: "answer", written: c.answer }];
		if (c.earlier && (c.answer === "nothing" || c.answer === "no breakdown")) reports.push({ from: "earlier answer", written: c.earlier });
		if (c.pi) reports.push({ from: "Pi's refresh", written: c.pi });
		const verdict = agrees(lifetime, { reports, routeMs: routeLifetime(asked, c.dataMs) }, true);
		// The start facts count with the period's lifetime where they agree (the data, or the bucket that confirms it).
		const start = PeriodClock.start({ facts: { ...facts, lifetime: { ms: lifetime.ms, source: "declared by the model" } }, api: "anthropic-messages", cache: c.cache, dataMs: c.dataMs, routeKey: "A" });
		assert.equal("clock" in start, verdict.agrees, c.label);
		if (!verdict.agrees && "declined" in start) assert.match(start.declined.label, LABELS[verdict.why], c.label);
	}
});

test("the start: a lifetime the start facts do not count with, or none at all, is declined", () => {
	const m = model("anthropic-messages", { short: 3600, long: 3600 });
	const facts = startFacts(m, branch(HOUR_ANSWER).entries, "short");
	assert.deepEqual(PeriodClock.start({ facts: { ...facts, lifetime: { ms: FIVE, source: "x" } }, api: "anthropic-messages", cache: PLAIN, dataMs: HOUR, routeKey: "A" }), {
		declined: { label: "lifetime differs from the data", reason: "the request's cache lifetime does not match the model data" },
	});
	assert.deepEqual(PeriodClock.start({ facts, api: "openai-completions", cache: NO_MARKER, dataMs: undefined, routeKey: "A" }), { declined: { label: "no cache lifetime", reason: "the cache lifetime is unknown" } });
});

// -------------------------------------------------------------------------------------------------------- properties

// A small deterministic generator, so a failure names its seed.
const random = (seed: number) => () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);

test("over random sequences of facts: the sending edge moves later only in the read after a hit, never once the route changed; the lifetime never rises", () => {
	const writes = [{ input: 4, output: 1, cacheRead: 600_000, cacheWrite: 0, cacheWrite1h: 0 }, FIVE_WRITE, { input: 4, output: 1, cacheRead: 0, cacheWrite: 600_000, cacheWrite1h: 600_000 }, { input: 4, output: 1, cacheRead: 0, cacheWrite: 180_000, cacheWrite1h: 4_096 }];
	const owns = ["nothing", "hour", "five minutes", "both", "no breakdown"] as const;
	const routes = [{ short: 3600, long: 3600 }, { short: 300, long: 3600 }, { short: 150 }, {}, { short: 7200, long: 7200 }];
	for (let seed = 1; seed <= 300; seed++) {
		const next = random(seed);
		const pick = <T>(list: readonly T[]) => list[Math.floor(next() * list.length)];
		const [api, cache, answer, route] = pick([
			["anthropic-messages", PLAIN, HOUR_ANSWER, { short: 3600, long: 3600 }],
			["anthropic-messages", STATED_HOUR, READ, { short: 300, long: 3600 }],
			["openai-completions", NO_MARKER, READ, { short: 1800, long: 1800 }],
		] as const);
		const c = started(api, route, cache, answer);
		let now = 0;
		let hitSince = false;
		let changed = false;
		let before = c.read();
		for (let step = 0; step < 40; step++) {
			now += Math.floor(next() * 600) * S;
			const what = next();
			let view: CacheView;
			if (what < 0.25) {
				c.clock.hit(now);
				hitSince = true;
				continue;
			} else if (what < 0.35) {
				c.clock.wrote(pick(owns));
				continue;
			} else if (what < 0.45) {
				c.pi(now, pick(writes));
				view = c.read();
			} else if (what < 0.55) {
				changed = true;
				view = c.read({ routeKey: "B" });
			} else if (what < 0.75) view = c.read({ route: pick(routes) });
			else view = c.read();
			const label = `seed ${seed}, step ${step}`;
			if (changed) assert.equal(view.sendBy, undefined, `${label}: never once the route changed`);
			if (before.sendBy !== undefined && view.sendBy !== undefined && view.sendBy > before.sendBy) assert.ok(hitSince, `${label}: later only after a hit`);
			if (before.sendBy === undefined) assert.equal(view.sendBy, undefined, `${label}: unknown stays unknown`);
			if (before.lifetime === undefined) assert.equal(view.lifetime, undefined, `${label}: no lifetime stays none`);
			else if (view.lifetime) assert.ok(view.lifetime.ms <= before.lifetime.ms, `${label}: the lifetime never rises`);
			hitSince = false;
			before = view;
		}
	}
});
