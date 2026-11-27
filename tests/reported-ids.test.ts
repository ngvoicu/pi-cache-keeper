// What a proxy reports is cleaned once, where the report is read: no later use (the footer, /cache-keeper's model data
// line, the lookup against providers.dev's data) can print an id raw.
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatFooter, lookupsText, servedView, type FooterView } from "../footer.ts";
import {
	cleanReportedId,
	describeFound,
	factsOf,
	findFacts,
	loadStore,
	lookupsFor,
	parseAnsweredEvent,
	parseUpstreamsEvent,
	REPORTED_ID_CLUSTERS,
	REPORTED_ID_CODE_UNITS,
	type DataStore,
} from "../model-data.ts";

const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "providers-dev-entries.json"), "utf8")) as { data: Array<{ provider: string; model: string }> };
const providers: DataStore["providers"] = {};
for (const entry of fixture.data) (providers[entry.provider] ??= {})[entry.model] = factsOf(entry);

const COMBINING = "\u0301".repeat(10_000);
/** No control, format, private-use or surrogate character, and no line or paragraph separator. */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/u;
const clusters = (text: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;

// The reviewer's cases. `matches`: once cleaned, the id is one providers.dev's data has (anthropic/claude-opus-5-5).
const CASES: Array<{ name: string; provider: unknown; model?: unknown; cleaned?: string; matches: boolean }> = [
	{ name: "an escape character, at the start", provider: "\u001banthropic", cleaned: "anthropic", matches: true },
	{ name: "an escape sequence inside", provider: "anth\u001b[31mropic", cleaned: "anth [31mropic", matches: false },
	{ name: "a newline, at the end", provider: "anthropic\n", cleaned: "anthropic", matches: true },
	{ name: "a newline inside", provider: "anthr\nopic", cleaned: "anthr opic", matches: false },
	{ name: "a bidi override, at the start", provider: "\u202eanthropic", cleaned: "anthropic", matches: true },
	{ name: "a bidi override inside", provider: "anth\u202eropic", cleaned: "anth ropic", matches: false },
	{ name: "10,000 combining characters after the id", provider: `anthropic${COMBINING}`, matches: false },
	{ name: "10,000 combining characters alone", provider: COMBINING, matches: false },
	{ name: "a model id with a newline", provider: "anthropic", model: "claude-opus-5-5\n", cleaned: "anthropic", matches: true },
	{ name: "a model id of 10,000 combining characters", provider: "anthropic", model: `claude${COMBINING}`, cleaned: "anthropic", matches: false },
];

test("an id is cleaned and bounded: control and format characters out, at most so many clusters and code units", () => {
	for (const { name, provider } of CASES) {
		const out = cleanReportedId(provider);
		assert.ok(out, name);
		assert.doesNotMatch(out, UNSAFE, name);
		assert.ok(clusters(out) <= REPORTED_ID_CLUSTERS, `${name}: ${clusters(out)} clusters`);
		assert.ok(out.length <= REPORTED_ID_CODE_UNITS, `${name}: ${out.length} code units`);
	}
	for (const { name, provider, model, cleaned } of CASES) if (cleaned && model === undefined) assert.equal(cleanReportedId(provider), cleaned, name);
	assert.equal(cleanReportedId("x".repeat(10_000)), `${"x".repeat(REPORTED_ID_CLUSTERS - 1)}…`);
	assert.equal(cleanReportedId("模".repeat(1000))!.length, REPORTED_ID_CLUSTERS);
	assert.equal(cleanReportedId("devin"), "devin");
	// What is not a string, or nothing once cleaned, can't be read.
	for (const bad of [{ id: "anthropic" }, ["anthropic"], 7, null, "", " \n\u202e\u0000 "]) assert.equal(cleanReportedId(bad), undefined, JSON.stringify(bad));
});

test("an upstream whose id is not a string, or empty once cleaned, is unreadable: the report says the route is unknown", () => {
	const answered = (upstream: unknown) => parseAnsweredEvent({ provider: "provimux", model: "claude-opus-5-5", upstreams: [upstream] });
	assert.deepEqual(answered({ provider: { name: "anthropic" }, subscription: true })?.upstreams, []);
	assert.deepEqual(answered({ provider: "anthropic", model: { id: "x" } })?.upstreams, []);
	assert.deepEqual(answered({ provider: "\u0000\u001b" })?.upstreams, []);
	assert.deepEqual(answered({ provider: "\u202eanthropic\n", model: "claude-opus-5-5\r\n", subscription: false })?.upstreams, [{ provider: "anthropic", model: "claude-opus-5-5", subscription: false }]);
	// The list of what may serve a model is cleaned the same way.
	const list = parseUpstreamsEvent({
		provider: "provimux",
		models: { "claude-opus-5-5": { upstreams: [{ provider: "anthropic\u001b[2J", subscription: true }], fallbacks: [{ provider: `devin${COMBINING}` }] } },
	});
	const route = list?.models["claude-opus-5-5"];
	assert.deepEqual(route?.upstreams, [{ provider: "anthropic [2J", subscription: true }]);
	assert.ok(route?.fallbacks?.[0].provider.startsWith("devin"));
	assert.ok(route!.fallbacks![0].provider.length <= REPORTED_ID_CODE_UNITS);
	assert.deepEqual(parseUpstreamsEvent({ provider: "provimux", models: { m: { upstreams: [{ provider: { x: 1 } }] } } })?.models.m.upstreams, []);
});

test("the cleaned id is what is looked up, matched or missing, and what /cache-keeper's model data line prints", () => {
	const model = { provider: "provimux", id: "claude-opus-5-5" };
	for (const { name, provider, model: reportedModel, matches } of CASES) {
		const event = parseAnsweredEvent({ provider: "provimux", model: model.id, upstreams: [{ provider, ...(reportedModel === undefined ? {} : { model: reportedModel }), subscription: false }] });
		const upstreams = event!.upstreams;
		assert.equal(upstreams.length, 1, name);
		const lookups = lookupsFor(model, { upstreams });
		const found = findFacts(lookups, providers);
		assert.equal(found.refs.length > 0, matches, `${name}: ${found.refs.join(", ")}`);
		const line = `${describeFound(found)}; looked up as ${lookupsText(lookups)}`;
		assert.doesNotMatch(line, UNSAFE, name);
		assert.ok(line.length < 1_000, `${name}: ${line.length} code units`);
		if (matches) assert.match(describeFound(found), /^anthropic\/claude-opus-5-5: /, name);
		else assert.match(describeFound(found), /^none for this model$/, name);
	}
});

test("in the footer, at every width from 1 to 200: no unsafe character, and no wider than the width (or the countdown's shortest form)", () => {
	const view = (served: ReturnType<typeof servedView>): FooterView => ({
		countdown: { state: "warm", ms: 59 * 60_000 },
		lifetimes: { inUse: "long", short: { seconds: 300 }, long: { seconds: 3600 } },
		price: { via: "api", rates: { input: 5, output: 25 } },
		data: { served },
	});
	const shortest = visibleWidth(formatFooter({ countdown: { state: "warm", ms: 59 * 60_000 } }, 1)!);
	for (const { name, provider, model } of CASES) {
		const upstreams = parseAnsweredEvent({ provider: "provimux", model: "m", upstreams: [{ provider, ...(model === undefined ? {} : { model }), subscription: false }] })!.upstreams;
		for (let width = 1; width <= 200; width++) {
			const line = formatFooter(view(servedView(upstreams)), width)!;
			assert.doesNotMatch(line, UNSAFE, `${name} at ${width}`);
			assert.ok(visibleWidth(line) <= Math.max(width, shortest), `${name} at ${width}: ${visibleWidth(line)} columns`);
			assert.ok(line.length <= 4 * Math.max(width, shortest) + 8, `${name} at ${width}: ${line.length} code units`);
		}
	}
});

test("a model id given empty, or empty once cleaned, makes the upstream unreadable; one not given is the upstream's own model", () => {
	const answered = (upstream: unknown) => parseAnsweredEvent({ provider: "provimux", model: "claude-opus-5-5", upstreams: [upstream] })!.upstreams;
	assert.deepEqual(answered({ provider: "devin", subscription: true }), [{ provider: "devin", subscription: true }]);
	assert.deepEqual(answered({ provider: "devin", model: "", subscription: true }), []);
	assert.deepEqual(answered({ provider: "devin", model: " \n\u202e ", subscription: true }), []);
	assert.deepEqual(answered({ provider: "devin", model: null }), []);
});

// Routes saved by an earlier version, before reports were cleaned: they go through the same parser as a report.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
function withSavedStore<T>(write: (path: string) => void, read: () => T): T {
	const dir = mkdtempSync(join(tmpdir(), "pck-store-"));
	const before = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		write(join(dir, "cache-keeper-models.json"));
		return read();
	} finally {
		if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = before;
		rmSync(dir, { recursive: true, force: true });
	}
}

test("a store written by 0.10.7 with hostile ids loads cleaned, exactly as the same routes said in a report", () => {
	// tests/fixtures/store-0.10.7-hostile-ids.json: what 0.10.7's parseUpstreamsEvent and saveStore wrote for these routes
	// (escape sequences, a newline, a bidi override, 10,000 combining marks, a 10,000-character id, an empty model id, which 0.10.7 saved as none given),
	// with every character outside printable ASCII written as a \u escape: the same JSON value.
	const fixture = join(FIXTURES, "store-0.10.7-hostile-ids.json");
	const saved = JSON.parse(readFileSync(fixture, "utf8")) as { upstreams: { provimux: Record<string, unknown> } };
	const loaded = withSavedStore((path) => copyFileSync(fixture, path), loadStore);
	const routes = loaded.upstreams.provimux;
	assert.deepEqual(routes, parseUpstreamsEvent({ provider: "provimux", models: saved.upstreams.provimux })!.models);
	assert.deepEqual(Object.keys(routes), Object.keys(saved.upstreams.provimux));
	for (const [id, route] of Object.entries(routes)) {
		for (const upstream of [...route.upstreams, ...(route.fallbacks ?? [])]) {
			for (const value of [upstream.provider, upstream.model ?? ""]) {
				assert.doesNotMatch(value, UNSAFE, id);
				assert.ok(clusters(value) <= REPORTED_ID_CLUSTERS && value.length <= REPORTED_ID_CODE_UNITS, `${id}: ${value.length} code units`);
			}
		}
	}
	assert.deepEqual(routes["gpt-6.1-sol"].upstreams, [{ provider: "openai-codex", model: "gpt-6.1-sol", subscription: true }]);
	assert.deepEqual(routes["claude-opus-5-5"].fallbacks, [{ provider: "anthropic fake line", subscription: false }]);
	// 0.10.7 read an empty model id as none given and saved the upstream without one: the upstream's own model.
	assert.deepEqual(routes["devin/swe-2"].upstreams, [{ provider: "devin", subscription: true }]);
});

test("a saved route the parser refuses is not loaded; the rest of the store is", () => {
	const loaded = withSavedStore(
		(path) =>
			writeFileSync(
				path,
				JSON.stringify({
					version: 1,
					providers: { anthropic: { "claude-opus-5-5": { short: 300 } } },
					upstreams: {
						provimux: { kept: { upstreams: [{ provider: "anthropic\u001b[0m" }] }, "not a list": { upstreams: "anthropic" }, number: 5, "no upstreams": {} },
						"": { m: { upstreams: [{ provider: "anthropic" }] } },
						"all refused": { m: { upstreams: null } },
						"not an object": "provimux",
					},
					written: {},
				}),
			),
		loadStore,
	);
	assert.deepEqual(loaded.upstreams, { provimux: { kept: { upstreams: [{ provider: "anthropic [0m" }] } } });
	assert.deepEqual(Object.keys(loaded.providers), ["anthropic"]);
});
