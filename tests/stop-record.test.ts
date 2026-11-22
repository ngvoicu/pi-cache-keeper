import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The record lives in the agent directory, so it is set before the module loads.
const dir = mkdtempSync(join(tmpdir(), "pcc-stop-"));
process.env.PI_CODING_AGENT_DIR = dir;
const stop = await import("../stop-record.ts");
const { covers, firstSaid, noteMessage, readStop, rememberLoad, seenFor, stopPathLabel, writeStop } = stop;

const path = join(dir, "cache-keeper-stop.json");
const SEEN = Symbol.for("pi-cache-keeper.stop-seen");
const newProcess = () => delete (globalThis as Record<symbol, unknown>)[SEEN];
const clear = () => rmSync(path, { force: true });

test("written and read back; two writes have different ids; no temporary file is left, and a leftover one is not read", () => {
	clear();
	const first = writeStop(1_000);
	assert.deepEqual(readStop(), first);
	assert.equal(first.at, 1_000);
	const second = writeStop(2_000);
	assert.notEqual(second.id, first.id);
	assert.deepEqual(readStop(), second);
	assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
	writeFileSync(`${path}.99999.tmp`, "{");
	assert.deepEqual(readStop(), second, "a leftover temporary file is nobody's");
	rmSync(`${path}.99999.tmp`);
	assert.match(stopPathLabel(), /cache-keeper-stop\.json$/);
});

test("no file, and no directory, read as none", () => {
	clear();
	assert.equal(readStop(), null);
	const saved = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(dir, "not-there");
	try {
		assert.equal(readStop(), null);
	} finally {
		process.env.PI_CODING_AGENT_DIR = saved;
	}
});

test("what is not a record reads as unreadable, each with a reason; reading never throws", () => {
	for (const [text, reason] of [
		["", /not JSON/],
		["not json", /not JSON/],
		["[1]", /not a JSON object/],
		['{"version":2,"id":"x","at":1}', /version is not 1/],
		['{"version":1,"at":1}', /no id/],
		['{"version":1,"id":"","at":1}', /no id/],
		['{"version":1,"id":"x","at":"14:02"}', /time is not a number/],
	] as const) {
		writeFileSync(path, text);
		const read = readStop();
		assert.ok(read && "unreadable" in read, `${JSON.stringify(text)} is unreadable`);
		assert.match(read.unreadable, reason);
	}
	// A directory where the file should be: it can't be opened.
	clear();
	mkdirSync(path);
	try {
		const read = readStop();
		assert.ok(read && "unreadable" in read);
	} finally {
		rmSync(path, { recursive: true });
	}
});

test("covers: the record seen is not obeyed, another one and one where none was seen are", () => {
	const record = { id: "a", at: 1 };
	assert.equal(covers(record, "a"), false);
	assert.equal(covers(record, "b"), true);
	assert.equal(covers(record, null), true);
});

test("what a window remembers: sampled at the first load, not again; a session's own message; else the latest of any session; else the load's", () => {
	clear();
	newProcess();
	const before = writeStop(1);
	rememberLoad();
	assert.equal(seenFor("s1"), before.id, "the record in place at load");
	const later = writeStop(2);
	rememberLoad();
	assert.equal(seenFor("s1"), before.id, "a later load (a /reload) samples nothing");
	noteMessage("s1", later.id);
	assert.equal(seenFor("s1"), later.id, "the session's own message");
	assert.equal(seenFor("s2"), later.id, "a session without one: the latest message to any session");
	noteMessage("s2", null);
	assert.equal(seenFor("s2"), null);
	assert.equal(seenFor("s1"), later.id, "a message to another session changes nothing here");
	assert.equal(seenFor("s3"), null, "the latest of any session");

	// The module loaded again in the same process (Pi's /reload imports it afresh): the same memory.
	newProcess();
	clear();
	rememberLoad();
	assert.equal(seenFor("s1"), null, "no record at load: none");
	writeFileSync(path, "{");
	newProcess();
	rememberLoad();
	assert.equal(seenFor("s1"), null, "an unreadable record at load samples none");
});

test("the memory is the process's: a second copy of the module finds it", async () => {
	clear();
	newProcess();
	const record = writeStop(3);
	rememberLoad();
	noteMessage("s9", record.id);
	const again = await import(`../stop-record.ts?copy=${Date.now()}`);
	assert.equal(again.seenFor("s9"), record.id);
	again.rememberLoad();
	assert.equal(again.seenFor("s9"), record.id, "a later load samples nothing");
});

test("firstSaid: once per session and stop", () => {
	newProcess();
	assert.equal(firstSaid("s1", "a"), true);
	assert.equal(firstSaid("s1", "a"), false);
	assert.equal(firstSaid("s2", "a"), true);
	assert.equal(firstSaid("s1", "b"), true);
});
