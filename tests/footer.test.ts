import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import { fitParts, footerParts, formatFooter, lifetimesView, priceAt, sentView, tierInUse, type FooterView, type Tone } from "../footer.ts";
import { requestCache } from "../keep-warm.ts";
import { factsOf, findFacts, lookupsFor, type DataStore } from "../model-data.ts";

// Real entries of https://providers.dev/api/v1/entries, as the model-data tests read them.
const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "providers-dev-entries.json"), "utf8")) as { data: Array<{ provider: string; model: string }> };
const providers: DataStore["providers"] = {};
for (const entry of fixture.data) (providers[entry.provider] ??= {})[entry.model] = factsOf(entry);

const MIN = 60_000;
const HOUR = 3_600_000;
// Claude on the Anthropic API with the longer cache: what the footer shows most of the time.
const claude: FooterView = {
	lifetimes: { inUse: "long", short: { seconds: 300 }, long: { seconds: 3600 } },
	sent: { what: { lifetimes: [HOUR], tiers: [] }, conflict: false },
	price: { via: "api", rates: { input: 5, output: 25 } },
	data: {},
};
const warm = (ms: number, view: FooterView = claude): FooterView => ({ countdown: { state: "warm", ms }, ...view });
const paint = (text: string, tone: Tone) => `<${tone}>${text}</>`;

test("the footer, wide: the countdown, then the cache lifetimes with the one in use, what was sent, and the price", () => {
	assert.equal(formatFooter(warm(59 * MIN)), "cache warm · 59m left · long 1h (in use) · short 5m · sent 1h · api $5/$25 per M");
	assert.equal(formatFooter(warm(25_000)), "cache warm · 0:25 left · long 1h (in use) · short 5m · sent 1h · api $5/$25 per M");
	assert.equal(formatFooter({ countdown: { state: "cold" }, ...claude }), "cache cold · next message full price · long 1h (in use) · short 5m · sent 1h · api $5/$25 per M");
	assert.equal(formatFooter({ countdown: { state: "running" }, ...claude }), "cache in use · long 1h (in use) · short 5m · sent 1h · api $5/$25 per M");
	assert.equal(formatFooter({ countdown: { state: "refreshing" }, ...claude }), "cache warm · refreshing · long 1h (in use) · short 5m · sent 1h · api $5/$25 per M");
	// No countdown (no answer yet, or none since a compaction): the values alone.
	assert.equal(formatFooter(claude), "long 1h (in use) · short 5m · sent 1h · api $5/$25 per M");
	// A 12-hour cache counts in hours.
	assert.match(formatFooter(warm(11 * HOUR + 59 * MIN))!, /^cache warm · 11h 59m left · /);
	assert.equal(formatFooter({}), undefined);
});

test("the footer's colours: the last 30 seconds and errors in the warning colour, what explains them muted, the rest dim", () => {
	assert.equal(
		formatFooter(warm(25_000), Infinity, paint),
		"<warning>cache warm · 0:25 left</> · long 1h<dim> (in use)</> · <dim>short </><dim>5m</> · <dim>sent 1h</> · api $5/$25<dim> per M</>",
	);
	assert.equal(formatFooter({ countdown: { state: "cold" } }, Infinity, paint), "<dim>cache cold · next message full price</>");
	assert.equal(formatFooter({ countdown: { state: "warm", ms: 31_000 } }, Infinity, paint), "cache warm · 0:31 left");
	assert.equal(formatFooter({ keepWarm: { fallback: true } }, Infinity, paint), "<warning>⚠ keep-warm: Pi's after 2 refreshes without a hit (/cache-keeper-warm)</>");
	assert.equal(formatFooter({ keepWarm: { leftToPi: "thinking on" } }, Infinity, paint), "<muted>keep-warm: Pi's (thinking on)</>");
	const guess = lifetimesView({ short: 300 }, { tier: "long" }, findFacts(lookupsFor({ provider: "openai", id: "gpt-6.1-sol" }, { subscription: true }), providers));
	assert.equal(formatFooter({ lifetimes: guess }, Infinity, paint), "long <warning>?</><dim> (in use)</> · <dim>short </><dim>5m</><warning> ⚠</>");
});

test("keep-warm in the footer: why it ended, why a period is Pi's, and two misses in a row, right after the countdown", () => {
	const ended = (stop: "budget" | "limit" | "missed" | "failed" | "unable", amounts = "$1.98 spent, a miss costs $2.07") => formatFooter(warm(24_000, { keepWarm: { ended: { stop, limit: "2 h", amounts } }, ...claude }));
	const values = " · long 1h (in use) · short 5m · sent 1h · api $5/$25 per M";
	// The rule at work: muted, after any error.
	assert.equal(ended("budget"), `cache warm · 0:24 left · keep-warm ended (budget reached): $1.98 spent, a miss costs $2.07${values}`);
	assert.equal(ended("limit", "$0.36 spent, a miss costs $2.07"), `cache warm · 0:24 left · keep-warm ended (2 h limit): $0.36 spent, a miss costs $2.07${values}`);
	assert.equal(ended("budget", "10 of 10 refreshes"), `cache warm · 0:24 left · keep-warm ended (budget reached): 10 of 10 refreshes${values}`);
	// Something gone wrong: marked.
	assert.equal(ended("missed"), `cache warm · 0:24 left · ⚠ keep-warm ended (a refresh missed the cache): $1.98 spent, a miss costs $2.07${values}`);
	assert.equal(ended("failed"), `cache warm · 0:24 left · ⚠ keep-warm ended (a refresh failed): $1.98 spent, a miss costs $2.07${values}`);
	assert.equal(ended("unable"), `cache warm · 0:24 left · ⚠ keep-warm ended (the request can't be re-sent): $1.98 spent, a miss costs $2.07${values}`);
	// Two misses in a row: also with the cache cold, and with no countdown at all.
	assert.equal(formatFooter({ countdown: { state: "cold" }, keepWarm: { fallback: true }, ...claude }), `cache cold · next message full price · ⚠ keep-warm: Pi's after 2 refreshes without a hit (/cache-keeper-warm)${values}`);
	assert.equal(formatFooter({ keepWarm: { fallback: true }, ...claude }), `⚠ keep-warm: Pi's after 2 refreshes without a hit (/cache-keeper-warm)${values}`);
	assert.equal(formatFooter(warm(5 * MIN, { keepWarm: { leftToPi: "several cache lifetimes" }, ...claude })), `cache warm · 5m left · keep-warm: Pi's (several cache lifetimes)${values}`);
	assert.equal(formatFooter(warm(5 * MIN, { keepWarm: { pending: true }, ...claude })), `cache warm · 5m left · keep-warm: from your next message${values}`);
});

test("the cache lifetimes: the countdown's for the tier in use, the model's own for the other, a guess and a partial answer marked, unknown said", () => {
	// Pi's catalog (or the user's override) declares both.
	assert.deepEqual(lifetimesView({ short: 300, long: 3600 }, { tier: "long", seconds: 3600 }), { inUse: "long", short: { seconds: 300 }, long: { seconds: 3600 } });
	// The countdown's lifetime where nothing is declared for the tier (OpenAI's 30-minute minimum, a tier the provider reports).
	assert.equal(formatFooter({ lifetimes: lifetimesView(undefined, { tier: "long", seconds: 1800 }) }), "long 30m (in use) · short unknown");
	// Nothing known at all.
	assert.equal(formatFooter({ lifetimes: lifetimesView(undefined, { tier: "long" }) }), "cache lifetime unknown");
	// Claude Code picks the tier for the bridge: short then long, neither in use.
	assert.equal(formatFooter({ lifetimes: lifetimesView({ short: 3600, long: 3600 }, {}) }), "short 1h · long 1h");

	// providers.dev: a login's values, sure.
	const login = findFacts(lookupsFor({ provider: "cliproxyapi", id: "claude-opus-5-5" }, { upstreams: [{ provider: "anthropic", model: "claude-opus-5-5", subscription: true }] }), providers);
	assert.equal(formatFooter({ lifetimes: lifetimesView({ short: 3600, long: 3600 }, { tier: "long" }, login) }), "long 1h (in use) · short 1h");
	// Login or key, not known: the key's 5 minutes is the smaller short lifetime, a guess.
	const either = findFacts(lookupsFor({ provider: "cliproxyapi", id: "claude-opus-5-5" }, { upstreams: [{ provider: "anthropic" }] }), providers);
	assert.equal(formatFooter({ lifetimes: lifetimesView({ short: 300, long: 3600 }, { tier: "short" }, either) }), "short 5m ⚠ (in use) · long 1h");
	// A value of Pi's own in place of the guess is Pi's, not a guess.
	assert.equal(formatFooter({ lifetimes: lifetimesView({ short: 600, long: 3600 }, { tier: "long" }, either) }), "long 1h (in use) · short 10m");
	// Pi's ChatGPT login on OpenAI: the long lifetime only the API key has is not used.
	const chatgpt = findFacts(lookupsFor({ provider: "openai", id: "gpt-6.1-sol" }, { subscription: true }), providers);
	assert.equal(formatFooter({ lifetimes: lifetimesView({ short: 300 }, { tier: "long" }, chatgpt) }), "long ? (in use) · short 5m ⚠");
	// A lifetime evaluations found unsafe (0) is not one.
	const terra = findFacts([{ provider: "openai-codex", model: "gpt-6.1-terra" }], providers);
	assert.equal(formatFooter({ lifetimes: lifetimesView(undefined, { tier: "short" }, terra) }), "cache lifetime unknown");
});

test("what was sent: what the request's cache markers state, against the lifetime in use and the retention in force", () => {
	const anthropic = (ttl?: string) => ({ system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", ...(ttl ? { ttl } : {}) } }], messages: [], max_tokens: 1 });
	const both = { short: 300, long: 3600 };
	const sent = (payload: Record<string, unknown>, inUse: { tier?: "short" | "long"; ms?: number }, retention: "short" | "long" = "long", declared: { short?: number; long?: number } = both) =>
		formatFooter({ sent: sentView(requestCache(payload), inUse, declared, retention) }, Infinity, paint);
	// What the countdown counts: dim.
	assert.equal(sent(anthropic("1h"), { tier: "long", ms: HOUR }), "<dim>sent 1h</>");
	// A cache_control without ttl states no lifetime: it asks for the short tier, whatever that lasts on the route.
	assert.equal(sent(anthropic(), { tier: "short", ms: 5 * MIN }, "short"), "<dim>sent short</>");
	// A stated "5m" is shown as stated.
	assert.equal(sent(anthropic("5m"), { tier: "short", ms: 5 * MIN }, "short"), "<dim>sent 5m</>");
	// The request asked for the short tier while the retention says long, and the provider wrote that: said, muted.
	assert.equal(sent(anthropic(), { tier: "short", ms: 5 * MIN }), "<muted>sent short (retention long)</>");
	// A proxy on a subscription login, retention short: the short tier lasts an hour on this route and the answer
	// reported the one-hour write. The same lifetime under another tier's name is no difference (it said "⚠ sent 5m").
	const hourBoth = { short: 3600, long: 3600 };
	assert.equal(sent(anthropic(), { tier: "long", ms: HOUR }, "short", hourBoth), "<dim>sent short</>");
	assert.equal(sent(anthropic("1h"), { tier: "short", ms: HOUR }, "long", hourBoth), "<dim>sent 1h</>", "a stated hour, the hour in use under the short tier's name");
	// A stated lifetime that is not the one in use is a difference, whatever the route gives the tier.
	assert.equal(sent(anthropic("5m"), { tier: "long", ms: HOUR }, "short", hourBoth), "<warning>⚠ sent 5m</>");
	// No lifetime stated and none on the route for the tier asked: nothing to compare, no warning.
	assert.equal(sent(anthropic(), { tier: "long", ms: HOUR }, "short", { long: 3600 }), "<dim>sent short</>");
	// Mixed markers warn as before; the unstated one is named by its tier.
	const mixed = { system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", ttl: "1h" } }], messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }] };
	assert.equal(sent(mixed, { tier: "long", ms: HOUR }), "<warning>⚠ sent 1h + short</>");
	// Asked for 1 hour, the provider wrote 5 minutes: the countdown runs on another lifetime than the request asked for.
	assert.equal(sent(anthropic("1h"), { tier: "short", ms: 5 * MIN }), "<warning>⚠ sent 1h</>");
	// GPT on OpenAI with the longer cache: a 12-hour shared prefix and the 30-minute conversation.
	const gpt = { input: [{ role: "developer", content: [{ type: "input_text", text: "s", prompt_cache_breakpoint: { mode: "explicit", ttl: "12h" } }] }], prompt_cache_options: { mode: "explicit", ttl: "30m" } };
	assert.equal(sent(gpt, { tier: "long", ms: 12 * HOUR }), "<warning>⚠ sent 30m + 12h</>");
	// No marker: the provider's default cache, the short tier.
	assert.equal(sent({ messages: [] }, { tier: "short", ms: 5 * MIN }, "short"), "<dim>sent default cache</>");
	assert.equal(sent({ messages: [] }, { tier: "long", ms: HOUR }), "<warning>⚠ sent default cache</>", "the countdown counts the long tier's hour");
	assert.equal(sent({ messages: [] }, { tier: "long" }, "long", { short: 1800 }), "<muted>sent default cache (retention long)</>", "no lifetime is counted, so nothing to contradict");
	// Kimi's 1-hour option, and OpenAI's extended retention, which states no lifetime.
	assert.equal(sent({ messages: [], prompt_cache_retention: "24h", prompt_cache_options: { mode: "implicit", ttl: "1h" } }, { tier: "long", ms: HOUR }), "<dim>sent 1h</>");
	assert.equal(sent({ input: [], prompt_cache_retention: "24h" }, { tier: "long", ms: HOUR }), "<dim>sent long</>");
	// A marker the extension does not read.
	assert.equal(sent({ messages: [], cache_control: { type: "persistent" } }, { tier: "long", ms: HOUR }), "<warning>⚠ sent a cache marker it can't read</>");
	// The rules still read the documented 5 minutes for an unstated marker; only the footer tells the two apart.
	assert.deepEqual(requestCache(anthropic()).markers, [{ at: "system[0].cache_control", tier: "short", ms: 300_000, implied: true }]);
	assert.deepEqual(requestCache(anthropic("5m")).markers, [{ at: "system[0].cache_control", tier: "short", ms: 300_000 }]);
});

test("what was sent, wide and narrow: a proxy on a subscription login, Anthropic's API at either retention, a stated lifetime that differs", () => {
	const control = (ttl?: string) => requestCache({ system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", ...(ttl ? { ttl } : {}) } }], messages: [] });
	const line = (view: FooterView, width = Infinity) => formatFooter(view, width);
	// A proxy on a subscription login, retention short, short and long an hour each, the one-hour write reported.
	const proxy: FooterView = {
		countdown: { state: "running" },
		lifetimes: { inUse: "long", short: { seconds: 3600 }, long: { seconds: 3600 } },
		sent: sentView(control(), { tier: "long", ms: HOUR }, { short: 3600, long: 3600 }, "short"),
		price: { via: "sub", subscription: true },
	};
	assert.equal(line(proxy), "cache in use · long 1h (in use) · short 1h · sent short · sub, no per-token price");
	assert.equal(line(proxy, 60), "cache in use · long 1h · short 1h · sent short · sub");
	assert.equal(line(proxy, 40), "cache in use · long 1h · short 1h · sub", "what was sent goes first when it agrees");
	// Anthropic's API, retention short: the 5-minute write reported.
	const shortApi: FooterView = {
		countdown: { state: "warm", ms: 4 * MIN },
		lifetimes: { inUse: "short", short: { seconds: 300 }, long: { seconds: 3600 } },
		sent: sentView(control(), { tier: "short", ms: 5 * MIN }, { short: 300, long: 3600 }, "short"),
		price: { via: "api", rates: { input: 3, output: 15 } },
	};
	assert.equal(line(shortApi), "cache warm · 4m left · short 5m (in use) · long 1h · sent short · api $3/$15 per M");
	assert.equal(line(shortApi, 60), "warm 4m · short 5m · long 1h · sent short · api $3/$15");
	// Retention long: the request states the hour.
	const longApi: FooterView = { ...shortApi, countdown: { state: "warm", ms: 59 * MIN }, lifetimes: { ...shortApi.lifetimes!, inUse: "long" }, sent: sentView(control("1h"), { tier: "long", ms: HOUR }, { short: 300, long: 3600 }, "long") };
	assert.equal(line(longApi), "cache warm · 59m left · long 1h (in use) · short 5m · sent 1h · api $3/$15 per M");
	assert.equal(line(longApi, 60), "warm 59m · long 1h · short 5m · sent 1h · api $3/$15");
	// The request states an hour and the provider wrote 5 minutes: a real difference, kept past the values.
	const differs: FooterView = { ...shortApi, sent: sentView(control("1h"), { tier: "short", ms: 5 * MIN }, { short: 300, long: 3600 }, "long") };
	assert.equal(line(differs), "cache warm · 4m left · short 5m (in use) · long 1h · ⚠ sent 1h · api $3/$15 per M");
	assert.equal(line(differs, 40), "warm 4m · short 5m · long 1h · ⚠ sent 1h");
	assert.equal(line(differs, 30), "warm 4m · short 5m · ⚠ sent 1h");
	assert.equal(line(differs, 20), "warm 4m · ⚠ sent 1h");
});

test("the tier in use: the one the request asked for where the route's lifetime for it is the countdown's; without a request, the lifetime decides", () => {
	const HOUR_S = 3600;
	const hourBoth = { short: HOUR_S, long: HOUR_S };
	const anthropic = { short: 300, long: HOUR_S };
	// A route whose short tier lasts an hour: asked short, the one-hour write reported (the bucket names it "long").
	assert.equal(tierInUse({ asked: "short", countdownMs: HOUR, route: hourBoth, retention: "short", fallback: "long" }), "short");
	assert.equal(tierInUse({ asked: "short", countdownMs: HOUR, route: hourBoth, retention: "long", fallback: "long" }), "short", "the request, not the retention");
	// Anthropic's API: the tier asked and the bucket agree.
	assert.equal(tierInUse({ asked: "short", countdownMs: 5 * MIN, route: anthropic, retention: "short", fallback: "short" }), "short");
	assert.equal(tierInUse({ asked: "long", countdownMs: HOUR, route: anthropic, retention: "long", fallback: "long" }), "long");
	// Asked for the hour, written as 5 minutes: what is in use is the 5-minute tier.
	assert.equal(tierInUse({ asked: "long", countdownMs: 5 * MIN, route: anthropic, retention: "long", fallback: "short" }), "short");
	// No request read (after /reload, /resume, /fork, a compaction or /tree): the tier whose lifetime is the countdown's,
	// and where both tiers have it, the retention in force.
	assert.equal(tierInUse({ countdownMs: 5 * MIN, route: anthropic, retention: "long", fallback: "short" }), "short");
	assert.equal(tierInUse({ countdownMs: HOUR, route: anthropic, retention: "short", fallback: "long" }), "long");
	assert.equal(tierInUse({ countdownMs: HOUR, route: hourBoth, retention: "short", fallback: "long" }), "short");
	assert.equal(tierInUse({ countdownMs: HOUR, route: hourBoth, retention: "long", fallback: "short" }), "long");
	// Nothing to go by (no lifetime on the route for it, or no countdown lifetime): the tier as before.
	assert.equal(tierInUse({ countdownMs: HOUR, route: undefined, retention: "short", fallback: "long" }), "long");
	assert.equal(tierInUse({ asked: "short", countdownMs: undefined, route: hourBoth, retention: "short", fallback: "long" }), "long");
	// Formats whose answers report no write bucket: the tier asked is the retention's, and reads as before.
	assert.equal(tierInUse({ asked: "short", countdownMs: 30 * MIN, route: { short: 1800, long: 43_200 }, retention: "short", fallback: "short" }), "short");
	assert.equal(tierInUse({ asked: "long", countdownMs: HOUR, route: { short: 300, long: HOUR_S }, retention: "long", fallback: "long" }), "long");
	assert.equal(tierInUse({ asked: "short", countdownMs: 12 * HOUR, route: { short: 1800, long: 43_200 }, retention: "long", fallback: "long" }), "long", "GPT's 30-minute conversation marker, the countdown on the 12 hours");
});

test("the price in use: per million tokens at the context size; on a subscription the prices counted with, none per token only without any; unknown said", () => {
	const tiered = { input: 1.25, output: 10, tiers: [{ inputTokensAbove: 200_000, input: 2.5, output: 15 }] };
	assert.deepEqual(priceAt(tiered, 150_000), { input: 1.25, output: 10 });
	assert.deepEqual(priceAt(tiered, 250_000), { input: 2.5, output: 15, above: 200_000 });
	assert.deepEqual(priceAt(tiered), { input: 1.25, output: 10 });
	const price = (view: FooterView["price"]) => formatFooter({ price: view });
	assert.equal(price({ via: "api", rates: priceAt(tiered, 250_000) }), "api $2.5/$15 per M above 200k");
	assert.equal(price({ via: "api", rates: { input: 0.075, output: 0.3 } }), "api $0.075/$0.3 per M");
	// A subscription login with prices: the ones the extension counts with, not what is billed per token.
	assert.equal(price({ via: "sub", subscription: true, rates: { input: 5, output: 25 } }), "sub, counted at $5/$25 per M");
	assert.equal(formatFooter({ price: { via: "sub", subscription: true, rates: { input: 5, output: 25 } } }, Infinity, paint), "<muted>sub, counted at $5/$25</><dim> per M</>");
	assert.equal(price({ via: "sub", subscription: true, rates: priceAt(tiered, 250_000) }), "sub, counted at $2.5/$15 per M above 200k");
	assert.equal(formatFooter({ price: { via: "sub", subscription: true, rates: { input: 5, output: 25 } } }, 20), "sub, counted $5/$25");
	assert.equal(formatFooter({ price: { via: "sub", subscription: true, rates: { input: 5, output: 25 } } }, 10), "sub");
	// Without any price (every rate zero): none per token.
	assert.equal(price({ via: "sub", subscription: true }), "sub, no per-token price");
	assert.equal(formatFooter({ price: { via: "sub", subscription: true } }, 10), "sub");
	assert.equal(price({ subscription: true }), "no per-token price", "Claude Code through the bridge");
	assert.equal(price({ via: "sub or api", rates: { input: 2, output: 10 } }), "sub or api $2/$10 per M");
	assert.equal(price({ via: "api" }), "api, price unknown");
	assert.equal(price({ via: "api", partial: true }), "api, price ?");
	assert.equal(formatFooter({ price: { via: "sub or api", rates: { input: 2, output: 10 } } }, 18), "sub/api $2/$10");
});

test("a countdown on another model's tier is said to be so, right after it, and only beside a countdown that says how long", () => {
	const kimi: FooterView = { lifetimes: { inUse: "short", short: { seconds: 300 }, long: { seconds: 3600 } }, countdownTier: "long", price: { via: "api", rates: { input: 3, output: 15 } } };
	assert.equal(formatFooter(warm(59 * MIN, kimi)), "cache warm · 59m left · ⚠ countdown on another model's long tier · short 5m (in use) · long 1h · api $3/$15 per M");
	assert.equal(formatFooter({ countdown: { state: "cold" }, ...kimi }), "cache cold · next message full price · ⚠ countdown on another model's long tier · short 5m (in use) · long 1h · api $3/$15 per M");
	assert.equal(formatFooter({ countdown: { state: "running" }, ...kimi }), "cache in use · short 5m (in use) · long 1h · api $3/$15 per M");
	assert.equal(formatFooter(kimi), "short 5m (in use) · long 1h · api $3/$15 per M");
	assert.equal(formatFooter(warm(59 * MIN, kimi), 60), "warm 59m · ⚠ countdown: other model · short 5m · api $3/$15");
	assert.equal(formatFooter(warm(59 * MIN, kimi), 14), "warm 59m · ⚠");
});

test("providers.dev in the footer: an answer from elsewhere, no data, stale data, PI_OFFLINE, a guess", () => {
	const values = { lifetimes: claude.lifetimes, price: claude.price };
	assert.equal(formatFooter(warm(4 * MIN, { ...values, data: { served: "api" } })), "cache warm · 4m left · ⚠ answered by an API key · long 1h (in use) · short 5m · api $5/$25 per M");
	assert.equal(formatFooter({ ...values, data: { served: "sub" } }), "⚠ answered by a login · long 1h (in use) · short 5m · api $5/$25 per M");
	assert.equal(formatFooter({ lifetimes: { inUse: "long", short: {}, long: {} }, price: { via: "api", rates: { input: 2, output: 10 } }, data: { fetch: "failed" } }), "⚠ providers.dev: no data, fetch failed · cache lifetime unknown · api $2/$10 per M");
	assert.equal(formatFooter({ ...values, data: { staleMs: 26 * HOUR } }), "⚠ providers.dev refresh failed: data 26h old · long 1h (in use) · short 5m · api $5/$25 per M");
	assert.equal(formatFooter({ ...values, data: { staleMs: 40 * MIN } }), "⚠ providers.dev refresh failed: data 40m old · long 1h (in use) · short 5m · api $5/$25 per M");
	assert.equal(formatFooter({ ...values, data: { staleMs: 3 * 24 * HOUR } }), "⚠ providers.dev refresh failed: data 3d old · long 1h (in use) · short 5m · api $5/$25 per M");
	assert.equal(formatFooter({ ...values, data: { fetch: "offline" } }), "long 1h (in use) · short 5m · api $5/$25 per M · providers.dev: no data (PI_OFFLINE)");
	assert.equal(formatFooter({ ...values, data: { noEntry: true } }), "long 1h (in use) · short 5m · api $5/$25 per M · providers.dev: no data for this model");
	const guessed = { lifetimes: { inUse: "long" as const, short: { seconds: 300, mark: "guess" as const }, long: { mark: "partial" as const } }, price: { via: "sub or api" as const, rates: { input: 2, output: 10 } } };
	assert.equal(formatFooter({ ...guessed, data: { guess: "access" } }), "long ? (in use) · short 5m ⚠ · sub or api $2/$10 per M · ⚠ login or API key unknown: shorter values");
	assert.equal(formatFooter({ ...guessed, price: { via: "sub", subscription: true }, data: { guess: "login" } }), "long ? (in use) · short 5m ⚠ · sub, no per-token price · ⚠ no entry for this login: shorter values");
});

test("narrow terminals: wording goes first, then the least important values; the countdown and errors stay", () => {
	const line = warm(59 * MIN);
	assert.equal(formatFooter(line, 80), "cache warm · 59m left · long 1h (in use) · short 5m · sent 1h · api $5/$25 per M");
	assert.equal(formatFooter(line, 79), "cache warm · 59m left · long 1h (in use) · short 5m · sent 1h · api $5/$25");
	assert.equal(formatFooter(line, 60), "warm 59m · long 1h · short 5m · sent 1h · api $5/$25");
	assert.equal(formatFooter(line, 40), "warm 59m · long 1h · api $5/$25", "what was sent goes first, when it agrees with the countdown, then the other lifetime");
	assert.equal(formatFooter(line, 30), "warm 59m · long 1h · short 5m", "then the price, and the other lifetime fits again");
	assert.equal(formatFooter(line, 20), "warm 59m · long 1h");
	assert.equal(formatFooter(line, 10), "warm 59m", "the countdown alone");
	assert.equal(formatFooter(line, 5), "warm 59m", "never dropped: Pi cuts what does not fit");
	// The wide wording comes back, the most important first, as far as it fits.
	assert.equal(formatFooter(warm(59 * MIN, { lifetimes: claude.lifetimes }), 51), "cache warm · 59m left · long 1h (in use) · short 5m");
	assert.equal(formatFooter(warm(59 * MIN, { lifetimes: claude.lifetimes }), 50), "cache warm · 59m left · long 1h · short 5m");

	// An error outlasts every value, and keeps its detail longer than the countdown its words.
	const failed = warm(25_000, { keepWarm: { ended: { stop: "failed", limit: "2 h", amounts: "$0.18 spent, a miss costs $2.07" } }, ...claude });
	assert.equal(formatFooter(failed, 100), "warm 0:25 · ⚠ keep-warm ended: a refresh failed · long 1h · short 5m · sent 1h · api $5/$25");
	assert.equal(formatFooter(failed, 60), "warm 0:25 · ⚠ keep-warm failed · long 1h · api $5/$25");
	assert.equal(formatFooter(failed, 30), "warm 0:25 · ⚠ keep-warm failed");
	assert.equal(formatFooter(failed, 14), "warm 0:25 · ⚠", "at the last, the mark alone");
	const fallback = { countdown: { state: "cold" as const }, keepWarm: { fallback: true as const }, ...claude };
	assert.equal(formatFooter(fallback, 100), "cold · ⚠ keep-warm: Pi's after 2 without a hit · long 1h · short 5m · sent 1h · api $5/$25");
	assert.equal(formatFooter(fallback, 24), "cold · ⚠ keep-warm: Pi's");
	assert.equal(formatFooter(fallback, 14), "cold · ⚠");
	// A request that asked for another lifetime than the countdown counts outlasts the values too.
	const gpt: FooterView = warm(11 * HOUR, {
		keepWarm: { leftToPi: "several cache lifetimes" },
		lifetimes: { inUse: "long", short: { seconds: 1800 }, long: { seconds: 43_200 } },
		sent: { what: { lifetimes: [30 * MIN, 12 * HOUR], tiers: [] }, conflict: true },
		price: { via: "api", rates: { input: 1.25, output: 10 } },
		data: {},
	});
	assert.equal(formatFooter(gpt), "cache warm · 11h left · keep-warm: Pi's (several cache lifetimes) · long 12h (in use) · short 30m · ⚠ sent 30m + 12h · api $1.25/$10 per M");
	assert.equal(formatFooter(gpt, 80), "warm 11h · keep-warm: Pi's · long 12h · ⚠ sent 30m+12h · api $1.25/$10");
	assert.equal(formatFooter(gpt, 40), "warm 11h · long 12h · ⚠ sent 30m+12h", "a part that fits again after a larger one went comes back");
	assert.equal(formatFooter(gpt, 26), "warm 11h · ⚠ sent 30m+12h");
});

test("at every width from 1 to 200 columns, in every state: within the width, and no value outlasts an error", () => {
	const views: FooterView[] = [
		warm(59 * MIN),
		warm(59 * MIN, { ...claude, price: { via: "sub", subscription: true, rates: { input: 4, output: 20, above: 200_000 } } }),
		warm(59 * MIN, { lifetimes: { inUse: "short", short: { seconds: 3600 }, long: { seconds: 3600 } }, sent: { what: { lifetimes: [], tiers: ["short"] }, conflict: false }, price: { via: "sub", subscription: true } }),
		{ countdown: { state: "running" }, lifetimes: { inUse: "long", short: { seconds: 3600 }, long: { seconds: 3600 } }, sent: { what: { lifetimes: [], tiers: ["short"] }, conflict: false }, price: { via: "sub", subscription: true } },
		warm(59 * MIN, { ...claude, lifetimes: { inUse: "short", short: { seconds: 300 }, long: { seconds: 3600 } }, countdownTier: "long", data: { served: "api" } }),
		{ countdown: { state: "cold" }, keepWarm: { fallback: true }, ...claude },
		warm(24_000, { keepWarm: { ended: { stop: "budget", limit: "24 h", amounts: "$1.98 spent, a miss costs $2.07" } }, ...claude }),
		warm(24_000, { keepWarm: { ended: { stop: "missed", limit: "2 h", amounts: "$1.22 spent, a miss costs $2.07" } }, ...claude, data: { served: "api", staleMs: 30 * HOUR } }),
		{ lifetimes: { inUse: "long", short: { seconds: 300, mark: "guess" }, long: { mark: "partial" } }, price: { via: "sub or api", partial: true }, data: { guess: "access", fetch: "offline", noEntry: true } },
		{ lifetimes: { inUse: "long", short: {}, long: {} }, sent: { what: "none", conflict: false, retention: "long" }, price: { via: "api" }, data: { fetch: "failed" } },
		warm(11 * HOUR, {
			keepWarm: { leftToPi: "several cache lifetimes" },
			lifetimes: { inUse: "long", short: { seconds: 1800 }, long: { seconds: 43_200 } },
			sent: { what: { lifetimes: [30 * MIN, 12 * HOUR], tiers: [] }, conflict: true },
			price: { via: "api", rates: { input: 1.25, output: 10 } },
			data: { served: "sub" },
		}),
	];
	const text = (form: { text: string }[]) => form.map((piece) => piece.text).join("");
	const isValue = (first: string) => /^(long|short|cache lifetime|api|sub|sent [^⚠])/.test(first);
	for (const view of views) {
		const parts = footerParts(view);
		const smallest = Math.min(...parts.filter((part) => part.keep).map((part) => visibleWidth(text(part.forms.at(-1)!))));
		for (let width = 1; width <= 200; width++) {
			const line = formatFooter(view, width)!;
			if (width >= smallest) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
			const shown = fitParts(parts, width);
			const bareMarks = parts.filter((part, i) => shown[i] !== undefined && text(part.forms[shown[i] as number]) === "⚠").length;
			assert.ok(bareMarks <= 1, `${width}: one bare mark at most: ${line}`);
			// An error not shown in words is stood for by the bare mark whenever a value is shown.
			const errorCut = parts.some((part, i) => part.lastResort && (shown[i] === undefined || text(part.forms[shown[i] as number]) === "⚠"));
			const valueShown = parts.some((part, i) => shown[i] !== undefined && isValue(text(part.forms[0])));
			if (errorCut && valueShown) assert.equal(bareMarks, 1, `${width}: ${line}`);
		}
	}
});
