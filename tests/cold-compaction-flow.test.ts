// The cold compaction model in the extension's session_before_compact handler (design/cold-compaction-model.md, section
// 7, tests 9 to 22), driven as Pi drives it, with a fake registry whose models answer canned text: no request leaves.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";

// The trace path and settings are read from the agent directory, so it is set before the extension loads.
const dir = mkdtempSync(join(tmpdir(), "pcc-cold-"));
process.env.PI_CODING_AGENT_DIR = dir;
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => {
	throw new Error("no network in tests");
}) as typeof fetch;
const ALL_OFF = { compactAtPercent: 0, compactAtTokens: 0, compactBeforeExpiry: false, keepWarmMinutes: 0, modelData: false, cacheRetention: "short" };
const writeSettings = (keeper: Record<string, unknown>) => writeFileSync(join(dir, "settings.json"), JSON.stringify({ cacheKeeper: { ...ALL_OFF, ...keeper } }));
writeSettings({});
const { default: cacheKeeper } = await import("../index.ts");
test.after(() => {
	globalThis.fetch = realFetch;
	delete process.env.PI_CODING_AGENT_DIR;
	rmSync(dir, { recursive: true, force: true });
});

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const HOUR = 3_600_000;
const GEMINI = "google/gemini-2.5-flash";

const cost = (input: number, output: number) => ({ input, output, cacheRead: input / 10, cacheWrite: 0 });
const opus = () => ({ provider: "anthropic", id: "claude-opus-4-5", api: "anthropic-messages", promptCache: { short: 3600, long: 3600 } as unknown, contextWindow: 1_000_000, maxTokens: 64_000, reasoning: true, cost: { ...cost(5, 25), cacheWrite: 6.25 } });
const gemini = () => ({ provider: "google", id: "gemini-2.5-flash", api: "google-generative-ai", contextWindow: 1_048_576, maxTokens: 65_536, reasoning: true, cost: cost(0.3, 2.5) as Any, thinkingLevelMap: undefined as unknown });

const usageOf = (input: number, output: number, total = 0) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } });
const answer = (text: string | undefined, over: Record<string, unknown> = {}) => ({
	role: "assistant",
	content: text === undefined ? [] : [{ type: "text", text }],
	api: "google-generative-ai",
	provider: "google",
	model: "gemini-2.5-flash",
	usage: usageOf(48_000, 3_000, 0.0219),
	stopReason: "stop",
	timestamp: Date.now(),
	...over,
});

// The conversation to summarize: a user's ask, an answer with a tool call, a long tool result.
const history = [
	{ role: "user", content: [{ type: "text", text: "Fix the bug in src/a.ts." }], timestamp: 10 },
	{ role: "assistant", content: [{ type: "text", text: "Reading it." }, { type: "toolCall", id: "t1", name: "read", arguments: { path: "src/a.ts" } }], api: "anthropic-messages", provider: "anthropic", model: "claude-opus-4-5", usage: usageOf(0, 0), stopReason: "toolUse", timestamp: 11 },
	{ role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "x".repeat(50_000) }], isError: false, timestamp: 12 },
];
const preparation = (over: Record<string, unknown> = {}) => ({
	firstKeptEntryId: "u",
	messagesToSummarize: history,
	turnPrefixMessages: [],
	isSplitTurn: false,
	tokensBefore: 600_000,
	previousSummary: undefined,
	fileOps: { read: new Set(["src/a.ts"]), written: new Set<string>(), edited: new Set(["src/b.ts"]) },
	settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
	...over,
});
// A compaction Pi wrote earlier, whose file lists Pi would not carry forward into an extension's summary.
const earlier = { type: "compaction", id: "c0", parentId: null, timestamp: new Date(0).toISOString(), summary: "Earlier work.", firstKeptEntryId: "u", tokensBefore: 300_000, details: { readFiles: ["src/old.ts"], modifiedFiles: ["src/older.ts"] } };

interface Call {
	model: Any;
	context: Any;
	options: Any;
}
interface Options {
	/** The picked model, "" for off. */
	cold?: string;
	/** Other settings over ALL_OFF. */
	settings?: Record<string, unknown>;
	/** The models the registry lists (the session's own and gemini by default). */
	models?: Any[];
	noAuth?: string[];
	subscriptions?: string[];
	/** The cold model's answer to each request (a thrown error, a message, or a promise of one). */
	coldAnswer?: (call: Call, n: number) => unknown;
	/** The session model's answer to the cached path's request. */
	sessionAnswer?: "summary" | Error | Record<string, unknown>;
	/** No request before the compaction. */
	noRequest?: boolean;
	/** The model has no cache lifetime. */
	noLifetime?: boolean;
	hasUI?: boolean;
}

function harness(o: Options = {}) {
	writeSettings({ coldCompactionModel: o.cold ?? GEMINI, ...o.settings });
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const spies = { setModel: 0, setThinkingLevel: 0, appended: [] as Any[] };
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
		registerEntryRenderer: () => {},
		events: { on: () => () => {}, emit: () => {} },
		registerCommand: () => {},
		appendEntry: (type: string, data: unknown) => spies.appended.push({ type, data }),
		getThinkingLevel: () => "high",
		setModel: async () => {
			spies.setModel++;
			return true;
		},
		setThinkingLevel: () => {
			spies.setThinkingLevel++;
		},
	};
	cacheKeeper(pi as never);
	const session = opus();
	if (o.noLifetime) session.promptCache = undefined;
	const models = o.models ?? [session, gemini()];
	const user = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 };
	const reply = { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 1_000, stopReason: "stop", provider: "anthropic", model: "claude-opus-4-5", api: "anthropic-messages", usage: { input: 2, output: 5, cacheRead: 600_000, cacheWrite: 0, totalTokens: 600_007, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
	const branch: Any[] = [
		{ type: "message", id: "u", parentId: null, timestamp: new Date(0).toISOString(), message: user },
		{ type: "message", id: "a", parentId: "u", timestamp: new Date(1_000).toISOString(), message: reply },
	];
	const sent = { model: "claude-opus-4-5", max_tokens: 64_000, system: "s", messages: [{ role: "user", content: "hi" }], thinking: { type: "adaptive" } };
	const calls: Call[] = [];
	const coldCalls = () => calls.filter((call) => call.model.provider !== session.provider || call.model.id !== session.id);
	const sessionCalls = () => calls.filter((call) => call.model.provider === session.provider && call.model.id === session.id);
	const registry = {
		getAvailable: () => models,
		find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: (m: Any) => !(o.noAuth ?? []).includes(m.provider),
		isUsingOAuth: (m: Any) => (o.subscriptions ?? []).includes(m.provider),
		getProvider: (provider: string) => ((o.subscriptions ?? []).includes(provider) ? { auth: { oauth: { isSubscription: true } } } : undefined),
		streamSimple: (model: Any, context: Any, options: Any) => {
			const call = { model, context, options };
			calls.push(call);
			const isSession = model.provider === session.provider && model.id === session.id;
			const result = (async () => {
				if (isSession) {
					const how = o.sessionAnswer ?? "summary";
					if (how instanceof Error) throw how;
					await options.onPayload?.({ ...sent, messages: [...sent.messages, { role: "user", content: "Summarize." }] });
					if (how === "summary") return { ...answer("The cached summary."), provider: session.provider, model: session.id, usage: { ...usageOf(5, 2_000), cacheRead: 600_000 } };
					return { ...answer(undefined), provider: session.provider, model: session.id, ...how };
				}
				const made = o.coldAnswer ? await o.coldAnswer(call, coldCalls().length) : answer(`Summary ${coldCalls().length}.\n\n<read-files>\nsrc/a.ts\n</read-files>`);
				return made;
			})();
			result.catch(() => {});
			return { result: () => result };
		},
	};
	const ctx: Any = {
		hasUI: o.hasUI ?? false,
		ui: { notify: () => {}, setStatus: () => {}, theme: { fg: (_tone: string, text: string) => text, bold: (text: string) => text } },
		cwd: dir,
		model: session,
		isIdle: () => true,
		hasPendingMessages: () => false,
		isProjectTrusted: () => false,
		getContextUsage: () => ({ tokens: 600_000 }),
		sessionManager: { getBranch: () => branch, getSessionId: () => "s1", getSessionFile: () => undefined, buildSessionProjection: () => ({ messages: history }) },
		modelRegistry: registry,
		compact: () => {},
	};
	const emit = (event: string, payload: unknown = {}) => handlers.get(event)?.(payload, ctx);
	if (!o.noRequest) {
		emit("context_with_system", { messages: [user] });
		emit("before_provider_request", { payload: sent });
		emit("message_end", { message: reply });
	}
	const compaction = (reason: "manual" | "threshold" | "overflow", e: { preparation?: Any; customInstructions?: string; signal?: AbortSignal; entries?: Any[] } = {}) =>
		emit("session_before_compact", {
			type: "session_before_compact",
			reason,
			preparation: e.preparation ?? preparation(),
			branchEntries: e.entries ?? [...branch],
			customInstructions: e.customInstructions,
			signal: e.signal ?? new AbortController().signal,
		}) as Promise<Any>;
	// Compacting when full: the extension starts it after a turn (with the Pi interface), and Pi calls the handler.
	const full = (e: { entries?: Any[] } = {}) => {
		let started: Promise<Any> | undefined;
		ctx.compact = () => {
			started = compaction("manual", e);
		};
		ctx.hasUI = true;
		emit("agent_settled");
		assert.ok(started, "compacting when full started");
		return started as Promise<Any>;
	};
	return { ctx, emit, compaction, full, calls, coldCalls, sessionCalls, spies, session, models };
}

const records = () =>
	readFileSync(join(dir, "cache-keeper.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.filter((r) => r.event === "compact");
const lastRecord = () => records().at(-1);

// Each test starts its clock at 1 s, the reply's landing, with the cache warm for an hour.
const clock = (t: { after: (fn: () => void) => void }) => {
	mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 1_000 });
	writeFileSync(join(dir, "cache-keeper.jsonl"), "");
	t.after(() => mock.timers.reset());
};
const expire = () => mock.timers.tick(HOUR + 1_000);

const assertColdCompaction = (result: Any, label: string, h: ReturnType<typeof harness>) => {
	assert.ok(result?.compaction, `${label}: a compaction`);
	const c = result.compaction;
	assert.match(c.summary, /^Summary 1\./, `${label}: the fake model's text`);
	assert.equal(c.firstKeptEntryId, "u", label);
	assert.equal(c.tokensBefore, 600_000, label);
	assert.deepEqual(c.usage, answer("").usage, `${label}: the fake's usage`);
	assert.deepEqual(c.details, { readFiles: ["src/a.ts", "src/old.ts"], modifiedFiles: ["src/b.ts", "src/older.ts"] }, `${label}: the file lists include the previous compaction's`);
	assert.match(c.summary, /<read-files>\nsrc\/a\.ts\nsrc\/old\.ts\n<\/read-files>\n\n<modified-files>\nsrc\/b\.ts\nsrc\/older\.ts\n<\/modified-files>$/, label);
	assert.equal(h.coldCalls().length, 1, `${label}: one request to the cold model`);
	const record = lastRecord();
	assert.equal(record.outcome, "cold", label);
	assert.equal(record.cold.model, GEMINI, label);
};

// 9
test("off: on a cold cache the handler returns nothing and the registry is never asked", async (t) => {
	clock(t);
	const h = harness({ cold: "" });
	for (const name of ["getAvailable", "find", "hasConfiguredAuth", "streamSimple"]) {
		h.ctx.modelRegistry[name] = () => assert.fail(`${name} was called`);
	}
	expire();
	assert.equal(await h.compaction("manual"), undefined);
	assert.deepEqual([lastRecord().outcome, lastRecord().reason, lastRecord().cold], ["fallback", "the prompt cache has expired", undefined]);
});

// 10
test("set, warm cache: the cached path writes the summary on the session's model; the cold model gets no request", async (t) => {
	clock(t);
	const h = harness();
	const result = await h.compaction("manual");
	assert.match(result.compaction.summary, /^The cached summary\./);
	assert.equal(h.coldCalls().length, 0);
	assert.equal(h.sessionCalls().length, 1);
	assert.equal(lastRecord().outcome, "cached");
	assert.equal(lastRecord().cold, undefined);
});

// 11
test("trigger 1, the cache is cold: an expired cache, no request yet, a model changed since the last request, for /compact, Pi's threshold, the overflow recovery and compacting when full", async (t) => {
	const states = {
		expired: { options: {}, before: () => expire(), reason: "the prompt cache has expired" },
		"no request": { options: { noRequest: true }, before: () => {}, reason: "no request since the session started or compacted, or since the model or branch changed" },
		"model changed": { options: {}, before: (h: ReturnType<typeof harness>) => (h.ctx.model = { ...opus(), id: "claude-sonnet-4-6" }), reason: "the model changed since the last request" },
	} as const;
	for (const [state, s] of Object.entries(states)) {
		for (const trigger of ["manual", "threshold", "overflow", "full"] as const) {
			mock.timers.reset();
			clock(t);
			const h = harness({ ...s.options, settings: trigger === "full" ? { compactAtPercent: 50 } : {} });
			if (state === "model changed") h.models.push({ ...opus(), id: "claude-sonnet-4-6" });
			s.before(h);
			const entries = [earlier, ...h.ctx.sessionManager.getBranch()];
			const result = await (trigger === "full" ? h.full({ entries }) : h.compaction(trigger, { entries }));
			const label = `${state}, ${trigger}`;
			assertColdCompaction(result, label, h);
			assert.equal(lastRecord().trigger, trigger, label);
			assert.equal(lastRecord().reason, trigger === "overflow" ? "the last request overflowed the context window" : s.reason, label);
			assert.equal(h.sessionCalls().length, 0, `${label}: the session's model is not asked on a cold cache`);
		}
	}
});

// 12
test("the request it sent: to the picked model, Pi's summarizer prompt, the conversation in <conversation>, the model's own output limit, no reasoning where it can be off and the lowest level where not, no cache", async (t) => {
	clock(t);
	const h = harness();
	expire();
	await h.compaction("manual");
	const [call] = h.coldCalls();
	assert.equal(`${call.model.provider}/${call.model.id}`, GEMINI);
	const [system, ask] = call.context.messages;
	assert.equal(system.role, "system");
	assert.match(system.content, /^You are a context summarization assistant/);
	const prompt = ask.content[0].text;
	assert.match(prompt, /^<conversation>\n\[User\]: Fix the bug in src\/a\.ts\.\n\n\[Assistant\]: Reading it\.\n\n\[Assistant tool calls\]: read\(path="src\/a\.ts"\)\n\n\[Tool result\]: x{2000}/);
	assert.ok(!prompt.includes("x".repeat(2_001)), "the tool result cut to 2,000 characters");
	assert.ok(call.options.maxTokens === undefined || call.options.maxTokens <= 65_536);
	assert.equal(call.options.reasoning, undefined, "thinking off");
	assert.equal(call.options.cacheRetention, "none");
	assert.equal(call.options.apiKey, undefined, "no key of the extension's own: the registry's at request time");
	assert.equal(lastRecord().cold.thinking, "off");
	// A model that can't turn thinking off gets its lowest level.
	mock.timers.reset();
	clock(t);
	const always = { ...gemini(), thinkingLevelMap: { off: null, minimal: null } };
	const h2 = harness({ models: [opus(), always] });
	expire();
	await h2.compaction("manual");
	assert.equal(h2.coldCalls()[0].options.reasoning, "low");
	assert.equal(lastRecord().cold.thinking, "low");
});

// 13
test("a previous summary is sent as <previous-summary>; a split turn sends two requests and sums their usage; /compact instructions are in the prompt", async (t) => {
	clock(t);
	const h = harness();
	expire();
	const prefix = [{ role: "user", content: [{ type: "text", text: "Now the tests." }], timestamp: 20 }];
	const result = await h.compaction("manual", {
		preparation: preparation({ previousSummary: "Earlier work.", isSplitTurn: true, turnPrefixMessages: prefix }),
		customInstructions: "keep the file names",
	});
	const [first, second] = h.coldCalls().map((call) => call.context.messages.find((m: Any) => m.role === "user").content[0].text);
	assert.equal(h.coldCalls().length, 2);
	assert.match(first, /<previous-summary>\nEarlier work\.\n<\/previous-summary>/);
	assert.match(first, /Additional focus: keep the file names$/);
	// The turn's prefix, in Pi's split-turn prompt (worded by the Pi installed: from 1.x it carries the instructions too).
	assert.match(second, /\[User\]: Now the tests\./);
	assert.doesNotMatch(second, /Fix the bug/);
	assert.equal(result.compaction.usage.input, 96_000, "both requests' usage");
	assert.equal(result.compaction.usage.output, 6_000);
	assert.match(result.compaction.summary, /^Summary 1\.\s+---\n\n\*\*Turn Context \(split turn\):\*\*\n\nSummary 2\./);
	assert.equal(lastRecord().cold.requests, 2);
});

// 14
test("before expiry: a cache that went cold at the gate cancels, and the cold model gets no request", async (t) => {
	clock(t);
	const h = harness({ settings: { compactBeforeExpiry: true, minContextTokens: 100_000 }, hasUI: true });
	let started: Promise<Any> | undefined;
	// The session's own summary request takes 21 s to leave (a credential lookup): the cache has expired by then.
	const stream = h.ctx.modelRegistry.streamSimple;
	h.ctx.modelRegistry.streamSimple = (model: Any, context: Any, options: Any) => {
		if (model.id === "claude-opus-4-5") mock.timers.tick(21_000);
		return stream(model, context, options);
	};
	h.ctx.compact = () => {
		started = h.compaction("manual");
	};
	h.emit("agent_settled");
	while (!started && Date.now() < HOUR) mock.timers.tick(1_000);
	assert.ok(started, "compacting before expiry started");
	assert.deepEqual(await started, { cancel: true });
	assert.equal(h.coldCalls().length, 0);
	assert.deepEqual([lastRecord().trigger, lastRecord().outcome, lastRecord().reason, lastRecord().cold], ["expiry", "cancelled", "the prompt cache expired before the summary request left", undefined]);
});

// 15
test("each case decided before sending: nothing is returned, no request is sent, and the record says why", async (t) => {
	const cases: [string, Options, string][] = [
		["the session's own model", { cold: "anthropic/claude-opus-4-5" }, "it is the session's own model"],
		["a model Pi no longer lists", { cold: "google/gemini-9" }, "Pi no longer lists it"],
		["no credentials", { noAuth: ["google"] }, "Pi has no credentials for google"],
		["no window", { models: [opus(), { ...gemini(), contextWindow: 0 }] }, "it declares no context window"],
		["too small", { models: [opus(), { ...gemini(), contextWindow: 4_000, maxTokens: 2_000 }] }, "it needs about 3k tokens and its window is 4k"],
		["a virtual model", { models: [opus(), { ...gemini(), api: "pi-virtual" }] }, "it is a virtual model"],
		["through pi-claude-bridge", { models: [opus(), { ...gemini(), api: "claude-bridge" }] }, "it runs through pi-claude-bridge"],
	];
	for (const [label, options, why] of cases) {
		mock.timers.reset();
		clock(t);
		const h = harness(options);
		expire();
		assert.equal(await h.compaction("manual"), undefined, label);
		assert.equal(h.calls.length, 0, `${label}: nothing sent`);
		const record = lastRecord();
		assert.deepEqual([record.outcome, record.reason, record.cold.skipped], ["fallback", "the prompt cache has expired", why], label);
	}
});

// 16
test("each failure after sending: a thrown error, an error answer, the output limit, a tool call, an empty text; nothing is returned, one request was sent, the reason is recorded", async (t) => {
	const cases: [string, Options["coldAnswer"], string][] = [
		["thrown", () => Promise.reject(new Error("socket hang up")), "its request failed: socket hang up"],
		["error answer", () => answer(undefined, { stopReason: "error", errorMessage: "401 invalid key" }), "its request failed: 401 invalid key"],
		["output limit", () => answer("half a summ", { stopReason: "length" }), "the summary hit the output limit"],
		["tool call", () => answer(undefined, { stopReason: "toolUse", content: [{ type: "toolCall", id: "x", name: "read", arguments: {} }] }), "the model called a tool instead of writing the summary"],
		["empty", () => answer("  "), "it returned no summary text"],
	];
	for (const [label, coldAnswer, why] of cases) {
		mock.timers.reset();
		clock(t);
		const h = harness({ coldAnswer });
		expire();
		assert.equal(await h.compaction("manual"), undefined, label);
		assert.equal(h.coldCalls().length, 1, `${label}: one request, no retry`);
		assert.deepEqual([lastRecord().outcome, lastRecord().cold.skipped], ["fallback", why], label);
	}
});

// 17
test("an abort before the cold request sends none and cancels; an abort during it cancels; no compaction is returned", async (t) => {
	clock(t);
	const before = harness();
	expire();
	const early = new AbortController();
	early.abort();
	assert.deepEqual(await before.compaction("manual", { signal: early.signal }), { cancel: true });
	assert.equal(before.calls.length, 0);
	assert.deepEqual([lastRecord().outcome, lastRecord().reason], ["cancelled", "the compaction was aborted"]);

	mock.timers.reset();
	clock(t);
	const during = new AbortController();
	let release: () => void = () => {};
	const h = harness({
		coldAnswer: () =>
			new Promise((resolve) => {
				release = () => resolve(answer("Partial", { stopReason: "aborted" }));
			}),
	});
	expire();
	const pending = h.compaction("manual", { signal: during.signal });
	await new Promise((resolve) => setImmediate(resolve));
	during.abort();
	release();
	assert.deepEqual(await pending, { cancel: true });
	assert.equal(h.coldCalls().length, 1);
	assert.deepEqual([lastRecord().outcome, lastRecord().reason], ["cancelled", "the compaction was aborted"]);
	// A split turn aborted during its first request sends no second one.
	mock.timers.reset();
	clock(t);
	const split = new AbortController();
	const h2 = harness({
		coldAnswer: () => {
			split.abort();
			return answer("", { stopReason: "aborted" });
		},
	});
	expire();
	const prefix = [{ role: "user", content: [{ type: "text", text: "Now the tests." }], timestamp: 20 }];
	assert.deepEqual(await h2.compaction("manual", { signal: split.signal, preparation: preparation({ isSplitTurn: true, turnPrefixMessages: prefix }) }), { cancel: true });
	assert.equal(h2.coldCalls().length, 1, "nothing is sent after the abort");
});

// 18
test("after a cold summary: the session's model and thinking level were not set, ctx.model is the same object, and the captured request is still the session's", async (t) => {
	clock(t);
	// Trigger 2 on a warm cache, then the same compaction with the session's model answering: the cached path still has
	// the session's own request to send from.
	let refuse = true;
	const h = harness({ sessionAnswer: new Error("429 rate limited") });
	const model = h.ctx.model;
	assert.ok((await h.compaction("manual")).compaction);
	assert.equal(lastRecord().outcome, "cold");
	assert.equal(h.spies.setModel, 0);
	assert.equal(h.spies.setThinkingLevel, 0);
	assert.equal(h.ctx.model, model);
	refuse = false;
	const stream = h.ctx.modelRegistry.streamSimple;
	h.ctx.modelRegistry.streamSimple = (m: Any, context: Any, options: Any) =>
		m.provider === "anthropic" && !refuse
			? {
					result: async () => {
						await options.onPayload({ model: "claude-opus-4-5", max_tokens: 64_000, system: "s", messages: [{ role: "user", content: "hi" }, { role: "user", content: "Summarize." }], thinking: { type: "adaptive" } });
						return { ...answer("The cached summary."), usage: { ...usageOf(5, 2_000), cacheRead: 600_000 } };
					},
				}
			: stream(m, context, options);
	const again = await h.compaction("manual");
	assert.match(again.compaction.summary, /^The cached summary\./);
	assert.equal(lastRecord().outcome, "cached");
	assert.equal(lastRecord().lastRequest.messages, 1, "the request captured from the session, not the cold one");
});

// 19
test("a model with no cache lifetime whose last answer used the cache: the cached path is tried, not the cold model", async (t) => {
	clock(t);
	const h = harness({ noLifetime: true });
	mock.timers.tick(2 * HOUR);
	const result = await h.compaction("manual");
	assert.match(result.compaction.summary, /^The cached summary\./);
	assert.equal(h.coldCalls().length, 0);
	assert.equal(lastRecord().outcome, "cached");
	assert.equal(lastRecord().cache.lifetimeSeconds, undefined);
});

// 20
test("every other setting off: /compact, Pi's threshold and the overflow recovery on a cold cache are written by the cold model", async (t) => {
	for (const trigger of ["manual", "threshold", "overflow"] as const) {
		mock.timers.reset();
		clock(t);
		const h = harness({ settings: ALL_OFF });
		expire();
		const result = await h.compaction(trigger, { entries: [earlier, ...h.ctx.sessionManager.getBranch()] });
		assertColdCompaction(result, trigger, h);
	}
});

// 21
test("trigger 2, the session's model refuses the summary on a warm cache: a thrown rate limit, an error answer; and with a cold model that can't, Pi's own compaction", async (t) => {
	clock(t);
	const thrown = harness({ sessionAnswer: new Error("429 rate_limit_error: This request would exceed your rate limit") });
	assert.ok((await thrown.compaction("manual")).compaction);
	assert.equal(thrown.sessionCalls().length, 1);
	assert.deepEqual([lastRecord().outcome, lastRecord().reason], ["cold", "the summary request failed: 429 rate_limit_error: This request would exceed your rate limit"]);

	mock.timers.reset();
	clock(t);
	const quota = harness({ sessionAnswer: { stopReason: "error", errorMessage: "You have reached your weekly usage limit" } });
	assert.ok((await quota.compaction("manual")).compaction);
	assert.deepEqual([lastRecord().outcome, lastRecord().reason], ["cold", "You have reached your weekly usage limit"]);

	mock.timers.reset();
	clock(t);
	const cant = harness({ sessionAnswer: new Error("429 rate limited"), noAuth: ["google"] });
	assert.equal(await cant.compaction("manual"), undefined, "Pi's own compaction");
	assert.equal(cant.coldCalls().length, 0);
	assert.deepEqual([lastRecord().outcome, lastRecord().reason, lastRecord().cold.skipped], ["fallback", "the summary request failed: 429 rate limited", "Pi has no credentials for google"]);
});

// 22
test("trigger 3, the conversation doesn't fit the session's model: a switch to a smaller window, an overflow, too little room for a cached summary; and a cold model too small too", async (t) => {
	const small = { ...opus(), id: "claude-haiku-4-5", contextWindow: 200_000 };
	const cases: [string, (h: ReturnType<typeof harness>) => Promise<Any>, string][] = [
		[
			"switched to a smaller model",
			(h) => {
				h.models.push(small);
				h.ctx.model = small;
				return h.compaction("manual");
			},
			"the model changed since the last request",
		],
		["overflow", (h) => h.compaction("overflow"), "the last request overflowed the context window"],
		["no room", (h) => h.compaction("threshold", { preparation: preparation({ tokensBefore: 990_000 }) }), "only 6k tokens of the context window are left for the summary (it needs 16k)"],
	];
	for (const [label, run, reason] of cases) {
		mock.timers.reset();
		clock(t);
		const h = harness();
		const result = await run(h);
		assert.match(result.compaction.summary, /^Summary 1\./, label);
		assert.deepEqual([lastRecord().outcome, lastRecord().reason], ["cold", reason], label);
	}
	mock.timers.reset();
	clock(t);
	const tiny = harness({ models: [opus(), { ...gemini(), contextWindow: 8_000, maxTokens: 4_000 }] });
	assert.equal(await tiny.compaction("overflow"), undefined);
	assert.equal(tiny.calls.length, 0);
	const record = lastRecord();
	assert.deepEqual([record.outcome, record.cold.skipped, record.cold.window], ["fallback", "it needs about 3k tokens and its window is 8k", 8_000]);
});

// ------------------------------------------------------------------- the review's findings (0.10.0, round 1)

const splitPrep = () => preparation({ isSplitTurn: true, turnPrefixMessages: [{ role: "user", content: [{ type: "text", text: "Now the tests." }], timestamp: 20 }] });

// Finding 1: a reply that doesn't end in a normal stop is a failure, whatever it carries, and nothing more is sent.
test("review 1: a reply that ends aborted (the local signal live), in an error or at the output limit, after partial text, is a failure: no prefix request, Pi's own compaction", async (t) => {
	const cases: [string, Record<string, unknown>, RegExp][] = [
		["aborted upstream", { stopReason: "aborted", errorMessage: "upstream cancelled" }, /^its request ended early \(aborted\): upstream cancelled$/],
		["error after text", { stopReason: "error", errorMessage: "stream reset" }, /^its request failed: stream reset$/],
		["output limit", { stopReason: "length" }, /^the summary hit the output limit$/],
	];
	for (const [label, end, why] of cases) {
		mock.timers.reset();
		clock(t);
		const h = harness({ coldAnswer: (_call, n) => (n === 1 ? answer("Partial checkpoint from cancelled upstream", end) : answer("Completed prefix")) });
		expire();
		assert.equal(await h.compaction("manual", { preparation: splitPrep() }), undefined, label);
		assert.equal(h.coldCalls().length, 1, `${label}: the prefix is not sent`);
		const record = lastRecord();
		assert.equal(record.outcome, "fallback", label);
		assert.match(record.cold.skipped, why, label);
		assert.equal(record.cold.requests, 1, `${label}: the requests really sent`);
	}
});

// Finding 2: emptiness is checked after the file lists are taken out.
test("review 2: a reply holding only file lists is no summary: Pi's own compaction runs", async (t) => {
	clock(t);
	const h = harness({ coldAnswer: () => answer("<read-files>\na.ts\n</read-files>\n\n<modified-files>\nb.ts\n</modified-files>") });
	expire();
	assert.equal(await h.compaction("manual"), undefined);
	assert.deepEqual([lastRecord().outcome, lastRecord().cold.skipped], ["fallback", "it returned no summary text"]);
});

// Finding 6: a split turn whose history summary is empty sends no prefix; the record counts what was really sent.
test("review 6: an empty history summary on a split turn stops before the prefix; an Esc during the first request is a cancel that counts one request", async (t) => {
	clock(t);
	const h = harness({ coldAnswer: (_call, n) => answer(n === 1 ? "  " : "A complete prefix") });
	expire();
	assert.equal(await h.compaction("manual", { preparation: splitPrep() }), undefined);
	assert.equal(h.coldCalls().length, 1);
	assert.deepEqual([lastRecord().outcome, lastRecord().cold.skipped, lastRecord().cold.requests], ["fallback", "it returned no summary text", 1]);

	mock.timers.reset();
	clock(t);
	const esc = new AbortController();
	const h2 = harness({
		coldAnswer: () => {
			esc.abort();
			return answer("Partial", { stopReason: "aborted" });
		},
	});
	expire();
	assert.deepEqual(await h2.compaction("manual", { signal: esc.signal, preparation: splitPrep() }), { cancel: true });
	assert.equal(h2.coldCalls().length, 1);
	assert.deepEqual([lastRecord().outcome, lastRecord().cold.requests], ["cancelled", 1]);
});

// Finding 4a: the output cap the fit rule assumed is the one passed with the request.
test("review 4a: the request carries the output cap the fit rule computed, less the thinking a model that can't turn it off adds", async (t) => {
	const { coldFit, coldNeedTokens, coldRequestTokens } = await import("../cold-compaction.ts");
	const need = coldNeedTokens(coldRequestTokens(preparation() as Any));
	for (const [label, model, reserve] of [
		["thinking off", { ...gemini(), contextWindow: 200_000, maxTokens: 200_000 }, 0],
		["lowest level low", { ...gemini(), contextWindow: 200_000, maxTokens: 200_000, thinkingLevelMap: { off: null, minimal: null } }, 2_048],
	] as const) {
		mock.timers.reset();
		clock(t);
		const h = harness({ models: [opus(), model] });
		expire();
		assert.ok((await h.compaction("manual")).compaction, label);
		const fit = coldFit(model as Any, need);
		assert.equal(fit.fits, true);
		const budget = 200_000 - need - 4_000;
		// Never above the cap the fit assumed; Pi 1.x passes none of its own, so it is that cap; Pi 0.87.0 passes a lower one
		// (0.8 of reserveTokens), which stays.
		const sent = h.coldCalls()[0].options.maxTokens;
		assert.equal(typeof sent, "number", label);
		assert.ok(sent <= budget - reserve, `${label}: ${sent}`);
		assert.ok(sent === budget - reserve || sent === Math.floor(0.8 * 16_384), `${label}: ${sent}`);
	}
});
