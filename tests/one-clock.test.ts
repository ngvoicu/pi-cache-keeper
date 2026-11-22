// One clock, one warmer: the source holds the two questions apart. When does a cache expire is cache-clock.ts's alone;
// who warms a period, and what Pi's warming is told, is warm-period.ts's alone. index.ts reads the cache in one place
// (`look`) and names no lifetime or expiry of its own making.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("..", import.meta.url);
const source = (name: string) => readFileSync(new URL(name, root), "utf8");
const sources = readdirSync(root).filter((name) => name.endsWith(".ts"));
// What a file imports from where: each import statement's names and its module.
const imports = (text: string) => [...text.matchAll(/^\s*import\s([^;]*?)\sfrom\s"([^"]+)";/gms)].map((m) => ({ names: m[1], from: m[2] }));
const count = (text: string, piece: string) => text.split(piece).length - 1;
// The body of an arrow function declared as `const name = ` at the closure's level, up to its closing line.
const body = (text: string, name: string) => {
	const start = text.indexOf(`\tconst ${name} = `);
	assert.ok(start >= 0, `${name} is declared`);
	return text.slice(start, text.indexOf("\n\t};", start));
};

test("index.ts names no lifetime or expiry of its own making: it imports none of the clock's parts, and reads no expiry but the clock's", () => {
	const index = source("index.ts");
	for (const { names, from } of imports(index)) {
		for (const name of ["cacheState", "agrees", "shortestMs", "PeriodLifetime", "expiryOf"]) assert.doesNotMatch(names, new RegExp(`\\b${name}\\b`), `index.ts imports ${name} from ${from}`);
	}
	for (const piece of ["as SendBy", ".expiresAt", ".refreshedAt", "piRefreshes", 'action: "stop"']) assert.equal(count(index, piece), 0, `index.ts contains ${piece}`);
});

test("the two owners do not see each other: the clock imports no warmer, the warmer no clock, no evidence and no cache state", () => {
	const from = (name: string) => imports(source(name)).map((i) => i.from);
	for (const module of ["./warm-period.ts", "./index.ts"]) assert.ok(!from("cache-clock.ts").includes(module), `cache-clock.ts imports ${module}`);
	for (const module of ["./cache-clock.ts", "./lifetime-evidence.ts", "./cache-state.ts"]) assert.ok(!from("warm-period.ts").includes(module), `warm-period.ts imports ${module}`);
});

test("one door per paid request, one read: index.ts sends in two places, reads the cache in `look` and starts a period's facts in `goIdle`", () => {
	const index = source("index.ts");
	assert.equal(count(index, "streamSimple("), 2, "the refresh and the summary");
	assert.equal(count(index, "cacheView("), 1);
	assert.equal(count(body(index, "look"), "cacheView("), 1, "inside look");
	assert.equal(count(index, "startFacts("), 1);
	assert.equal(count(body(index, "goIdle"), "startFacts("), 1, "inside goIdle");
});

test("only the clock asks the evidence: no other source file calls agrees or shortestMs", () => {
	for (const name of sources.filter((n) => n !== "cache-clock.ts")) {
		// Their definitions in lifetime-evidence.ts are not calls.
		const text = source(name).replace(/function (agrees|shortestMs)\(/g, "");
		assert.doesNotMatch(text, /\b(agrees|shortestMs)\(/, `${name} calls the evidence`);
	}
});

// The ways around the clock a check of the build found the tests above let through.
test("index.ts takes from cache-state.ts only what is not the cache's reading", () => {
	const names = imports(source("index.ts"))
		.filter((i) => i.from === "./cache-state.ts")
		.flatMap((i) => i.names.replace(/[{}]/g, "").split(",").map((n) => n.replace(/^\s*type\s+/, "").trim()).filter(Boolean));
	assert.deepEqual(names.sort(), ["cacheTier", "hasExplicitPromptCache", "isKimiOnMoonshot", "lifetimeFor"]);
});

test("no source file takes the cache state, the evidence or the clock as a whole: no namespace or dynamic import of them", () => {
	for (const name of sources) {
		const text = source(name);
		assert.doesNotMatch(text, /import\s*\*\s*as\s+\w+\s+from\s+"\.\/(cache-state|lifetime-evidence|cache-clock)\.ts"/, `${name}: namespace import`);
		assert.doesNotMatch(text, /import\(\s*["'`]\.\/(cache-state|lifetime-evidence|cache-clock)\.ts/, `${name}: dynamic import`);
	}
});

test("only the clock reads the cache state: no other source file calls cacheState", () => {
	for (const name of sources.filter((n) => n !== "cache-clock.ts")) {
		// Its definition in cache-state.ts is not a call.
		assert.doesNotMatch(source(name).replace(/function cacheState\(/g, ""), /\bcacheState\(/, `${name} calls cacheState`);
	}
});

test("the period's starting lifetime, kept for the log, is read in one place only: the record of a hand-over", () => {
	const index = source("index.ts");
	assert.equal(count(index, ".logged"), 1);
	assert.equal(count(body(index, "handTo"), ".logged"), 1);
});

test("a stop has one place each: only stop-record.ts names the record; index.ts compares a record once, inside obeyStop, makes a period stopped once, and samples the user's message once", () => {
	for (const name of sources.filter((n) => n !== "stop-record.ts")) assert.equal(count(source(name), "cache-keeper-stop.json"), 0, `${name} names the record`);
	const index = source("index.ts");
	assert.equal(count(index, "covers("), 1);
	assert.equal(count(body(index, "obeyStop"), "covers("), 1, "inside obeyStop");
	assert.equal(count(index, ".stopped ="), 1);
	assert.equal(count(body(index, "obeyStop"), ".stopped ="), 1, "inside obeyStop");
	assert.equal(count(index, "noteMessage("), 1);
	assert.equal(count(index, "writeStop("), 1, "the command");
});
