import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isPlainObject } from "./cached-request.ts";
import { writeAtomic } from "./model-data.ts";

/**
 * `/cache-keeper-stop`'s record, and what a window remembers of it (see docs/stop-warming.md, section 3). The only file
 * that names the record's path, reads it or writes it, and the only one that holds what a window remembers.
 *
 * The record sits in Pi's agent directory, beside the settings: every Pi window that uses that directory reads it before
 * it sends anything. A period obeys the record in place if it is not the one its window had seen at the user's latest
 * message when the period started: no clock is compared.
 */

/** A stop as it is recorded: `id` is what is compared, `at` is for display only. */
export interface StopRecord {
	readonly id: string;
	readonly at: number;
}
/** One reading: the record, none (no file, no directory), or why it can't be read. */
export type StopRead = StopRecord | null | { readonly unreadable: string };

const FILE = "cache-keeper-stop.json";
const stopPath = () => join(getAgentDir(), FILE);
const label = (path: string) => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);

/** `cache-keeper-stop.json` in Pi's agent directory, with `~` for the home directory. */
export function stopPathLabel(): string {
	return label(stopPath());
}
/** The agent directory, written the same way: what the command names as its reach. */
export function agentDirLabel(): string {
	return label(getAgentDir());
}

/** Reads the record. Never throws. */
export function readStop(): StopRead {
	let text: string;
	try {
		text = readFileSync(stopPath(), "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return null;
		return { unreadable: error instanceof Error ? error.message : String(error) };
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return { unreadable: "it is not JSON" };
	}
	if (!isPlainObject(value)) return { unreadable: "it is not a JSON object" };
	if (value.version !== 1) return { unreadable: `its version is not 1 (${JSON.stringify(value.version) ?? "none"})` };
	if (typeof value.id !== "string" || !value.id) return { unreadable: "it has no id" };
	if (typeof value.at !== "number" || !Number.isFinite(value.at)) return { unreadable: "its time is not a number" };
	return { id: value.id, at: value.at };
}

/** Writes a new record (a new random `id`, `at` as given), whole: a temporary file, then a rename. Throws where it can't. */
export function writeStop(at: number): StopRecord {
	const record = { id: randomUUID(), at };
	writeAtomic(stopPath(), `${JSON.stringify({ version: 1, ...record })}\n`);
	return record;
}

/** Whether a period whose window had seen `seen` (a record's id, or none) obeys `record`: its id is not `seen`. */
export function covers(record: StopRecord, seen: string | null): boolean {
	return record.id !== seen;
}

/**
 * What the Pi process remembers, for each of its sessions: the record's id in place at the user's latest message to it.
 * Pi loads the extension again (a new instance, its modules imported afresh) on /new, /resume, /fork and /reload, so it
 * is kept on `globalThis` under a registered symbol: every instance in the process finds it, and it ends with the process.
 */
const STOP_SEEN = Symbol.for("pi-cache-keeper.stop-seen");
interface StopSeen {
	/** The record in place when the process first loaded the extension (none where there was none, or it was unreadable). */
	atLoad: string | null;
	/** Per session, at the user's latest message to it. */
	sessions: Map<string, string | null>;
	/** At the latest message to any session of the process; absent before the first. */
	latest?: { id: string | null };
	/** Per session, the stops said there. */
	said: Map<string, Set<string>>;
	/** Per session, the answer its latest period started from, and what that period had seen. */
	periods: Map<string, { answeredAt: number | undefined; seen: string | null }>;
}
function store(): StopSeen | undefined {
	return (globalThis as Record<symbol, unknown>)[STOP_SEEN] as StopSeen | undefined;
}

/** Called once per load of the extension, first thing: on the first call in a process, samples the record in place. */
export function rememberLoad(): void {
	const found = store();
	if (found?.sessions instanceof Map && found.said instanceof Map) {
		if (!(found.periods instanceof Map)) found.periods = new Map();
		return;
	}
	const read = readStop();
	const atLoad = read !== null && "id" in read ? read.id : null;
	(globalThis as Record<symbol, unknown>)[STOP_SEEN] = { atLoad, sessions: new Map(), said: new Map(), periods: new Map() } satisfies StopSeen;
}

/** The user's message reached the session with `id` in place (null: no record). */
export function noteMessage(session: string, id: string | null): void {
	rememberLoad();
	const seen = store() as StopSeen;
	seen.sessions.set(session, id);
	seen.latest = { id };
}

/** What the session had seen at the user's last message; else what any session of the process had at the latest one; else at load. */
export function seenFor(session: string): string | null {
	rememberLoad();
	const seen = store() as StopSeen;
	if (seen.sessions.has(session)) return seen.sessions.get(session) ?? null;
	return seen.latest ? seen.latest.id : seen.atLoad;
}

/**
 * What a period that starts now in the session has seen. A period started again from the same answer (a /reload, which
 * builds the period of the answer it already had) keeps what the session's period of that answer had seen: what the
 * user's message sampled since is taken up only by the period of a new real answer. Else what `seenFor` gives.
 */
export function seenAtStart(session: string, answeredAt: number | undefined): string | null {
	rememberLoad();
	const periods = (store() as StopSeen).periods;
	const last = periods.get(session);
	if (answeredAt !== undefined && last?.answeredAt === answeredAt) return last.seen;
	const seen = seenFor(session);
	periods.set(session, { answeredAt, seen });
	return seen;
}

/** Whether the stop `id` is said in this session for the first time; true once per session and id, and it remembers. */
export function firstSaid(session: string, id: string): boolean {
	rememberLoad();
	const said = (store() as StopSeen).said;
	const ids = said.get(session) ?? new Set<string>();
	said.set(session, ids);
	if (ids.has(id)) return false;
	ids.add(id);
	return true;
}
