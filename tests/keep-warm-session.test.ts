// Pi's real session runtime around the extension: /new and /reload while a refresh is still streaming. Pi invalidates
// the old extension context on replacement; anything the extension does with it afterwards throws, and an error thrown
// out of a callback ends Pi. The refresh must settle without a throw, and what it showed (a miss, a hit, nothing) must
// still be counted. No network: the adapter's transport is in memory, and the global fetch rejects.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "pcc-session-"));
process.env.PI_CODING_AGENT_DIR = dir;
const cwd = join(dir, "project");
mkdirSync(cwd);
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => {
	throw new Error("no network in tests");
}) as typeof fetch;
process.on("exit", () => {
	globalThis.fetch = realFetch;
	rmSync(dir, { recursive: true, force: true });
});

const base = new URL("../node_modules/@earendil-works/", import.meta.url);
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const load = async (path: string): Promise<Any> => import(new URL(path, base).href).catch(() => undefined);
const runtimeModule = await load("pi-coding-agent/dist/core/agent-session-runtime.js");
const servicesModule = await load("pi-coding-agent/dist/core/agent-session-services.js");
const sessionModule = await load("pi-coding-agent/dist/core/session-manager.js");
const catalog = await load("pi-ai/dist/models.generated.js");
const anthropic = await load("pi-ai/dist/api/anthropic-messages.js");
const transcript = await load("pi-ai/dist/utils/transcript.js");
const warmerModule = await load("pi-coding-agent/dist/core/cache-warmer.js");
const skip = runtimeModule && servicesModule && sessionModule && catalog && anthropic && transcript && warmerModule ? false : "the installed Pi has no session runtime to drive";

const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
const STORE = Symbol.for("pi-cache-keeper.warm-misses");
const store = () => (globalThis as Record<symbol, { counts: Map<string, number>; fallback: Map<string, number> } | undefined>)[STORE];
const flush = () => new Promise((resolve) => setImmediate(resolve));
const encoder = new TextEncoder();
const packet = (event: { type: string }) => encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);

const MODEL_KEY = "anthropic/claude-sonnet-4-6";
// What Anthropic reports: a write goes into the cache of the tier asked for (the 1-hour one for the long tier).
const usage = (read: number, write: number, tier: "short" | "long" = "short") => ({
	input_tokens: 5,
	cache_read_input_tokens: read,
	cache_creation_input_tokens: write,
	output_tokens: 1,
	cache_creation: { ephemeral_5m_input_tokens: tier === "short" ? write : 0, ephemeral_1h_input_tokens: tier === "long" ? write : 0 },
});
const messageStart = (read: number, write: number, tier: "short" | "long" = "short") => ({ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [], stop_reason: null, usage: usage(read, write, tier) } });
const end = [{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }, { type: "message_stop" }];
const sse = (body: ReadableStream) => new Response(body, { headers: { "content-type": "text/event-stream" } });
const closed = (events: { type: string }[]) =>
	sse(
		new ReadableStream({
			start(c) {
				for (const e of events) c.enqueue(packet(e));
				c.close();
			},
		}),
	);

interface Session {
	runtime: Any;
	runner: Any;
	/** One real request and its answer, which read the whole cache; then Pi goes idle. */
	answer: () => Promise<void>;
	/** The clock, second by second, letting what is due land. */
	ticks: (seconds: number) => Promise<void>;
	decide: () => Promise<unknown>;
	/** The real request of the latest answer, as Pi's own warming would keep it warm. */
	request: () => { model: Any; context: Any; options: Any };
	/** The extension's footer as last set (with `ui`). */
	footer: () => string | undefined;
}

// Pi's real session runtime with this extension, Claude Sonnet 4.6 on Anthropic's API, keep-warm on: by default the
// 5-minute cache (the short tier), a 2-hour goal, 120,000 cached prompt tokens. Each of the extension's refreshes goes
// through the real Anthropic adapter to `refresh` (n: the how-manieth, from 1), which sees the request's body.
async function inRuntime(
	refresh: (n: number, signal: AbortSignal, body: Any) => Response,
	scenario: (session: Session) => Promise<void>,
	o: {
		tier?: "short" | "long";
		keepWarmMinutes?: number;
		prompt?: number;
		/** An interactive session (Pi's TUI mode with a UI context), rather than none. */
		ui?: boolean;
		/** A session saved to a file in the agent directory, rather than in memory. */
		persisted?: boolean;
		/** More extensions, loaded after this one. */
		extensions?: string[];
	} = {},
) {
	const tier = o.tier ?? "short";
	writeFileSync(
		join(dir, "settings.json"),
		JSON.stringify({ cacheKeeper: { modelData: false, keepWarmMinutes: o.keepWarmMinutes ?? 120, cacheRetention: tier, compactBeforeExpiry: false, compactAtPercent: 0 }, cacheWarming: "idle", packages: [] }),
	);
	delete (globalThis as Record<symbol, unknown>)[STORE];
	const model = catalog.MODELS.anthropic["claude-sonnet-4-6"];
	const loader = {
		additionalExtensionPaths: [new URL("../index.ts", import.meta.url).pathname, ...(o.extensions ?? [])],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		disabledBuiltinExtensions: ["mcp", "codemode", "tool-search"],
		systemPrompt: "Review code.",
	};
	const factory = async ({ sessionManager, sessionStartEvent }: Any) => {
		const services = await servicesModule.createAgentSessionServices({ cwd, agentDir: dir, resourceLoaderOptions: loader });
		const { session } = await servicesModule.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model });
		return { session, services, diagnostics: services.diagnostics };
	};
	const runtime = await runtimeModule.createAgentSessionRuntime(factory, {
		cwd,
		agentDir: dir,
		sessionManager: o.persisted ? sessionModule.SessionManager.create(cwd, join(dir, "sessions")) : sessionModule.SessionManager.inMemory(cwd),
	});
	const thrown: unknown[] = [];
	const onThrow = (error: unknown) => thrown.push(error);
	process.on("uncaughtException", onThrow);
	process.on("unhandledRejection", onThrow);
	const runner = runtime.session.extensionRunner;
	let lastStatus: string | undefined;
	if (o.ui) {
		const uiContext = { ...runner.getUIContext(), theme: { fg: (_tone: string, text: string) => text }, notify: () => {}, setStatus: (_key: string, text: string | undefined) => (lastStatus = text) };
		await runtime.session.bindExtensions({ mode: "tui", uiContext, onError: () => {} });
	} else await runtime.session.bindExtensions({ onError: () => {} });
	const ctx = runner.createContext();
	const sessions = runtime.session.sessionManager;
	let refreshes = 0;
	ctx.modelRegistry.streamSimple = (m: Any, context: Any, options: Any) =>
		anthropic.streamSimple(m, context, { ...options, apiKey: "sk-fixture", maxRetries: 0, cacheRetention: tier, fetch: async (_input: unknown, init?: { body?: unknown }) => refresh(++refreshes, options.signal, JSON.parse(String(init?.body))) });
	mock.timers.reset();
	mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 100_000_000 });
	const prior: unknown[] = [];
	let lastRequest: { model: Any; context: Any; options: Any } | undefined;
	const session: Session = {
		runtime,
		runner,
		answer: async () => {
			await runner.emit({ type: "agent_start" });
			const ask = { role: "user", timestamp: Date.now(), content: [{ type: "text", text: prior.length ? "Continue." : "Read the change." }] };
			prior.push(ask);
			sessions.appendMessage(ask);
			const messages = await runner.emitContext(transcript.normalizeContext({ systemPrompt: "Review code.", messages: prior, tools }).messages);
			lastRequest = { model, context: { messages }, options: { apiKey: "sk-fixture", maxTokens: 8192, cacheRetention: tier } };
			const answer = await anthropic
				.streamSimple(model, { messages }, {
					apiKey: "sk-fixture",
					maxTokens: 8192,
					cacheRetention: tier,
					onPayload: (payload: unknown) => runner.emitBeforeProviderRequest(payload),
					fetch: async () => closed([messageStart(o.prompt ?? 120_000, 0, tier), ...end]),
				})
				.result();
			assert.equal(answer.stopReason, "stop");
			await runner.emitMessageEnd({ type: "message_end", message: answer });
			sessions.appendMessage(answer);
			prior.push(answer);
			await runner.emit({ type: "agent_settled", aborted: false });
		},
		ticks: async (seconds) => {
			for (let i = 0; i < seconds; i++) {
				mock.timers.tick(1000);
				await flush();
			}
		},
		decide: () => runner.emitCacheWarmingDecision({ type: "cache_warming_decision", action: "warm", timestamp: Date.now() }),
		request: () => lastRequest!,
		footer: () => lastStatus,
	};
	try {
		await scenario(session);
	} finally {
		mock.timers.reset();
		await runtime.dispose();
		process.off("uncaughtException", onThrow);
		process.off("unhandledRejection", onThrow);
	}
	return { thrown, refreshes, counts: Object.fromEntries(store()?.counts ?? []), fallback: [...(store()?.fallback.keys() ?? [])] };
}

for (const replace of ["new", "reload"] as const) {
	for (const shows of ["miss", "hit", "nothing"] as const) {
		test(`/${replace} while a refresh that reported ${shows === "nothing" ? "nothing" : `a ${shows}`} is still streaming: nothing throws, and ${shows === "miss" ? "the miss is counted" : "nothing is counted"}`, { skip }, async () => {
			// The refresh's stream reports what it read (or nothing), then stays open until the session goes.
			const open = (_n: number, signal: AbortSignal) =>
				sse(
					new ReadableStream({
						start(controller) {
							if (shows === "miss") controller.enqueue(packet(messageStart(0, 120_000)));
							if (shows === "hit") controller.enqueue(packet(messageStart(120_000, 0)));
							signal.addEventListener("abort", () => controller.error(new Error("cancelled")), { once: true });
						},
					}),
				);
			const result = await inRuntime(open, async (s) => {
				await s.answer();
				assert.equal(await s.decide(), "stop", "owned");
				// To the refresh, 25 s before the 5-minute expiry; it is still streaming when the session is replaced.
				await s.ticks(276);
				if (replace === "reload") await s.runtime.session.reload();
				else await s.runtime.newSession();
				await s.ticks(20);
			});
			assert.equal(result.refreshes, 1, "the refresh went out");
			assert.deepEqual(result.thrown, [], "nothing thrown out of a callback");
			assert.deepEqual(result.counts, shows === "miss" ? { [MODEL_KEY]: 1 } : {}, "the count");
			assert.deepEqual(result.fallback, []);
		});
	}
}

// The reviewer's sequence: a first refresh misses; the second also reports a miss, then the user's next message cancels
// it, but its stream takes long to settle; the next period's refresh falls due meanwhile. However the settlements fall,
// at most two refreshes go out, both misses, and the model is left to Pi once the second is known.
for (const [when, releaseAt] of [
	["before the next refresh falls due", 120],
	["while the next refresh is held", 280],
	["after the next period's cache expired", 400],
] as const) {
	test(`never a third paid miss: the cancelled second miss settles ${when}`, { skip }, async () => {
		let release: (() => void) | undefined;
		const respond = (n: number, signal: AbortSignal) => {
			if (n !== 2) return closed([messageStart(0, 120_000), ...end]);
			// Reported a miss; ignores the cancellation until released.
			return sse(
				new ReadableStream({
					start(controller) {
						controller.enqueue(packet(messageStart(0, 120_000)));
						release = () => controller.error(new Error("cancelled"));
						void signal;
					},
				}),
			);
		};
		const decisions: unknown[] = [];
		const result = await inRuntime(respond, async (s) => {
			await s.answer();
			await s.ticks(276); // the first refresh: a miss
			await s.answer();
			await s.ticks(276); // the second refresh goes out, reports a miss, stays open
			await s.answer(); // the user's next message cancels it; its stream does not settle yet
			for (let t = 0; t < 330; t++) {
				if (t === releaseAt) release?.();
				if (t === 270) decisions.push(await s.decide());
				await s.ticks(1);
			}
			if (releaseAt >= 330) release?.();
			await s.ticks(5);
			decisions.push(await s.decide());
		});
		assert.deepEqual(result.thrown, []);
		assert.equal(result.refreshes, 2, "two refreshes went out, both misses; no third");
		assert.deepEqual(result.fallback, [MODEL_KEY], "left to Pi once the second miss is known");
		// Once the model is left to Pi, Pi is not told to stop: Pi's own proposal stands.
		assert.equal(decisions.at(-1), "warm");
		if (releaseAt < 270) assert.equal(decisions[0], "warm", "known before Pi's proposal: not stopped");
	});
}

// The reviewer's first sequence, with Pi's real CacheWarmer asking at its own cadence (and the extension answering):
// the extension's refresh at 275 s reports a hit, then a run that sends nothing cancels it at 277 s. The hit moves the
// period back to waiting with the expiry counted from that refresh, so the next one goes out 275 s later, before the
// 5-minute entry expires; at 8a2d287 none went out and the cache expired at 575 s.
test("a refresh that reported a hit, then cancelled by a run that sent nothing: the next refresh goes out on time, with Pi's real CacheWarmer told to stop", { skip }, async () => {
	const sentAt: number[] = [];
	const piSent: number[] = [];
	const decisions: unknown[] = [];
	const respond = (n: number, signal: AbortSignal) => {
		sentAt.push(Date.now());
		if (n > 1) return closed([messageStart(120_000, 0), ...end]);
		// Reports the hit, then stays open until cancelled.
		return sse(
			new ReadableStream({
				start(controller) {
					controller.enqueue(packet(messageStart(120_000, 0)));
					signal.addEventListener("abort", () => controller.error(new Error("cancelled")), { once: true });
				},
			}),
		);
	};
	let answeredAt = 0;
	const result = await inRuntime(respond, async (s) => {
		await s.answer();
		answeredAt = Date.now();
		// Pi's own warming for that answer, as Pi starts it with the request and switches it to idle when the run settles.
		const warmer = new warmerModule.CacheWarmer(
			{
				streamSimple: (m: Any, context: Any, options: Any) => {
					piSent.push(Date.now());
					return anthropic.streamSimple(m, context, { ...options, fetch: async () => closed([messageStart(120_000, 0), ...end]) });
				},
			},
			s.runtime.session.sessionManager,
			() => "idle",
			async (event: Any) => {
				const action = await s.runner.emitCacheWarmingDecision(event);
				decisions.push({ at: (Date.now() - answeredAt) / 1000, proposed: event.action, answer: action });
				return action;
			},
		);
		warmer.start(s.request(), () => true);
		warmer.onAgentSettled();
		await s.ticks(277);
		// A run that sends nothing: it cancels the refresh, which had reported its hit.
		await s.runner.emit({ type: "agent_start" });
		await s.runner.emit({ type: "agent_settled", aborted: true });
		await s.ticks(330);
		warmer.cancel();
	});
	assert.deepEqual(result.thrown, []);
	const seconds = sentAt.map((at) => Math.round((at - answeredAt) / 1000));
	assert.equal(seconds[0], 275, "the first refresh, 25 s before the 5-minute expiry");
	assert.equal(seconds[1], 550, "the next one 275 s after the cancelled hit, before the entry it refreshed expires at 575 s");
	assert.deepEqual(piSent, [], "Pi's warming sent nothing: told to stop");
	// At this harness's 120k-token prompt Pi's own economics propose "stop" too; the extension's answer is "stop" either way.
	assert.deepEqual(
		decisions.map((d) => ({ ...(d as object), proposed: undefined })),
		[{ at: 270, proposed: undefined, answer: "stop" }],
		"Pi asked once, at its own 270 s, and was answered stop",
	);
	assert.deepEqual(result.counts, {}, "a hit: nothing counted");
});

// ------------------------------------------------------------------- both direct Anthropic tiers, through Pi's runtime

// Claude on Anthropic's own API with Pi's real adapter, short (the 5-minute cache) and long (the stated hour), 600,000
// cached prompt tokens: the first refresh, the budget, two misses, the time limit. Every refresh leaves capped at one
// output token. As on 0.5.3, measured on both tiers by the third review.
for (const tier of ["short", "long"] as const) {
	const lifetime = tier === "short" ? 300 : 3600;
	const step = tier === "short" ? 275 : 3420;
	const N = 600_000;
	// The refreshes' send times in seconds after the first answer, and their output limits.
	const run = async (respond: (n: number) => Response, scenario: (s: Session, answered: () => number) => Promise<void>, keepWarmMinutes: number) => {
		const sent: { at: number; cap: number }[] = [];
		let first = 0;
		const result = await inRuntime(
			(n, _signal, body) => {
				sent.push({ at: Math.round((Date.now() - first) / 1000), cap: body.max_tokens });
				return respond(n);
			},
			async (s) => {
				await s.answer();
				first = Date.now();
				await scenario(s, () => first);
			},
			{ tier, keepWarmMinutes, prompt: N },
		);
		assert.deepEqual(result.thrown, []);
		return { sent, result };
	};
	const hit = () => closed([messageStart(N, 0, tier), ...end]);
	const miss = () => closed([messageStart(0, N, tier), ...end]);

	test(`direct Anthropic, ${tier} tier: the first refresh ${step} s after the answer, capped at one token`, { skip }, async () => {
		const { sent } = await run(hit, async (s) => {
			assert.equal(await s.decide(), "stop", "owned: Pi's warming is told to stop");
			await s.ticks(step + 2);
		}, 120);
		assert.deepEqual(sent, [{ at: step, cap: 1 }]);
	});

	test(`direct Anthropic, ${tier} tier: the budget is spent after eleven capped reads`, { skip }, async () => {
		let decided: unknown;
		const { sent } = await run(hit, async (s) => {
			await s.ticks(13 * step + 2);
			decided = await s.decide();
		}, 1440);
		assert.deepEqual(sent, Array.from({ length: 11 }, (_, i) => ({ at: (i + 1) * step, cap: 1 })));
		assert.equal(decided, "stop", "ended on its budget: Pi's warming stays stopped");
	});

	test(`direct Anthropic, ${tier} tier: after two misses in a row the third period is Pi's`, { skip }, async () => {
		const decisions: unknown[] = [];
		const { sent, result } = await run(miss, async (s) => {
			await s.ticks(step + 2);
			await s.answer();
			await s.ticks(step + 2);
			await s.answer();
			decisions.push(await s.decide());
			await s.ticks(step + 2);
		}, 1440);
		assert.deepEqual(sent, [{ at: step, cap: 1 }, { at: 2 * step + 2, cap: 1 }], "two misses, no third refresh");
		assert.deepEqual(result.fallback, [MODEL_KEY]);
		assert.deepEqual(decisions, ["warm"], "the third period is Pi's: its proposal stands");
	});

	const goal = tier === "short" ? 15 : 120;
	test(`direct Anthropic, ${tier} tier: a ${goal}-minute goal sends ${tier === "short" ? "three refreshes" : "two refreshes"}, then the time limit`, { skip }, async () => {
		const { sent } = await run(hit, async (s) => {
			await s.ticks(goal * 60 + lifetime + 60);
		}, goal);
		const times = tier === "short" ? [275, 550, 825] : [3420, 6840];
		assert.deepEqual(sent, times.map((at) => ({ at, cap: 1 })));
	});
}

// ------------------------------------------------------------------------------------------------- /cache-keeper-stop

const { writeStop } = await import("../stop-record.ts");
const STOP_SEEN = Symbol.for("pi-cache-keeper.stop-seen");

// What the stop relies on in Pi: its `input` event is raised for the user's messages from every source, idle and into a
// run, reaches the extension's handler and goes on unchanged; a decision of Pi's warming is asked of the extension; a
// reload keeps what the process remembers. With keep-warm off, so the only warming is Pi's own.
test("a stop through Pi's real runtime: Pi's warming is told to stop; an input from any source, idle or into a run, reaches the handler, goes on unchanged and lifts it; a real /reload keeps it", { skip }, async () => {
	delete (globalThis as Record<symbol, unknown>)[STOP_SEEN];
	rmSync(join(dir, "cache-keeper-stop.json"), { force: true });
	const result = await inRuntime(
		() => closed([messageStart(120_000, 0), ...end]),
		async (s) => {
			await s.answer();
			assert.equal(await s.decide(), "warm", "keep-warm off: Pi's proposal stands");
			for (const [source, streamingBehavior] of [
				["interactive", undefined],
				["rpc", undefined],
				["extension", undefined],
				["interactive", "steer"],
				["rpc", "followUp"],
			] as const) {
				const what = `${source}${streamingBehavior ? `, ${streamingBehavior}` : ""}`;
				writeStop(Date.now());
				await s.ticks(1);
				await s.answer(); // an answer no message of the user's brought: stopped from its start
				assert.equal(await s.decide(), "stop", `${what}: stopped`);
				assert.deepEqual(await s.runner.emitInput("Go on.", undefined, source, streamingBehavior), { action: "continue" }, `${what}: unchanged`);
				await s.ticks(1);
				await s.answer();
				assert.equal(await s.decide(), "warm", `${what}: its answer's period is warmed as usual`);
			}
			writeStop(Date.now());
			await s.ticks(1);
			await s.answer();
			assert.equal(await s.decide(), "stop");
			await s.runtime.session.reload();
			const runner = s.runtime.session.extensionRunner;
			assert.equal(await runner.emitCacheWarmingDecision({ type: "cache_warming_decision", action: "warm", timestamp: Date.now() }), "stop", "after /reload: still stopped");
		},
		{ keepWarmMinutes: 0 },
	);
	assert.deepEqual(result.thrown, []);
	assert.equal(result.refreshes, 0, "the extension sent nothing");
});

test("Pi starts its own warming in one place, for a request that carries the session's own id: the extension's refreshes and summaries never start it", (t) => {
	const sdk = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js", import.meta.url);
	if (!existsSync(sdk)) return t.skip("the installed Pi has no dist/core/sdk.js");
	const text = readFileSync(sdk, "utf8");
	assert.equal(text.split("cacheWarmer.start(").length - 1, 1, "one call");
	const at = text.indexOf("cacheWarmer.start(");
	assert.match(text.slice(Math.max(0, at - 200), at), /if \(options\?\.sessionId === sessionManager\.getSessionId\(\)\) \{\s*$/, "under the session's own id");
	assert.match(text.slice(text.lastIndexOf("streamFn:", at), at), /streamFn: async \(model, context, options\) => \{/, "inside the session's stream function");
});

// The review's probes of a stop through a real /reload, with Pi's own warmer and a real session prompt (keep-warm off:
// Pi's warming is the only one). The answer reads 600,000 cached tokens, so Pi's warmer refreshes at 270 s.
for (const when of ["while Pi reloads", "after an input another extension handled"] as const) {
	test(`a stop holds through /reload ${when}: Pi's own warmer sends nothing, and the footer still says it`, { skip }, async () => {
		delete (globalThis as Record<symbol, unknown>)[STOP_SEEN];
		rmSync(join(dir, "cache-keeper-stop.json"), { force: true });
		process.env.ANTHROPIC_API_KEY = "fixture-key";
		let seen: Any;
		try {
			const result = await inRuntime(
				() => {
					throw new Error("keep-warm is off: the extension sends nothing");
				},
				async (s) => {
					const session = s.runtime.session;
					const transport = session._cacheWarmer.models;
					const loader = session.resourceLoader;
					const originalStream = transport.streamSimple;
					const originalReload = loader.reload.bind(loader);
					const calls: number[] = [];
					transport.streamSimple = (m: Any, c: Any, opts: Any) =>
						anthropic.streamSimple(m, c, {
							...opts,
							apiKey: "fixture-key",
							maxRetries: 0,
							fetch: async () => {
								calls.push(Date.now());
								return closed([messageStart(600_000, 0), ...end]);
							},
						});
					try {
						await session.prompt("Produce a fixture answer.");
						assert.equal(calls.length, 1, "the answer");
						const at = calls[0];
						await s.ticks(when === "while Pi reloads" ? 268 : 1);
						writeStop(Date.now());
						await s.ticks(1);
						const afterStop = s.footer();
						if (when === "while Pi reloads") {
							// Pi's warmer comes due while the reload loads its resources: it asks the old instance.
							loader.reload = async (...args: unknown[]) => {
								await s.ticks(2);
								return originalReload(...args);
							};
						} else {
							let handled: unknown;
							await session.prompt("handle locally", { preflightResult: (status: unknown) => (handled = status) });
							assert.equal(handled, "handled", "the input was handled by the other extension, nothing sent");
						}
						await session.reload();
						const afterReload = s.footer();
						await s.ticks(300);
						seen = {
							afterStop,
							afterReload,
							sent: calls.map((c) => c - at),
							answers: session.sessionManager.getBranch().filter((e: Any) => e.type === "message" && e.message.role === "assistant").length,
							warmEntries: session.sessionManager.getBranch().filter((e: Any) => e.type === "usage" && e.kind === "cache_warm").length,
						};
					} finally {
						loader.reload = originalReload;
						transport.streamSimple = originalStream;
					}
				},
				{ keepWarmMinutes: 0, prompt: 600_000, ui: true, extensions: [new URL("./fixtures/consume-input.ts", import.meta.url).pathname] },
			);
			assert.deepEqual(result.thrown, []);
		} finally {
			delete process.env.ANTHROPIC_API_KEY;
		}
		assert.equal(seen.answers, 1, "no new answer");
		assert.deepEqual(seen.sent, [0], "Pi's warmer sent nothing after the answer");
		assert.equal(seen.warmEntries, 0);
		assert.match(seen.afterStop ?? "", /warming stopped until your next message/);
		assert.match(seen.afterReload ?? "", /warming stopped until your next message/, "still stopped after the reload");
	});
}

// The review's probe: in an interactive session saved to a file, a refresh goes out at 276 s and settles before or after
// a real /reload. Its line is saved in the session file once either way: a refresh that settles after the reload made its
// context stale is written through the instance that runs the session now.
for (const reloadFirst of [false, true]) {
	test(`a refresh that settles ${reloadFirst ? "after" : "before"} a real /reload keeps its one line in the session file`, { skip }, async () => {
		delete (globalThis as Record<symbol, unknown>)[STOP_SEEN];
		rmSync(join(dir, "cache-keeper-stop.json"), { force: true });
		let release: (() => void) | undefined;
		let sent: AbortSignal | undefined;
		let seen: Any;
		const result = await inRuntime(
			(_n, signal) => {
				sent = signal;
				return sse(
					new ReadableStream({
						start(controller) {
							controller.enqueue(packet(messageStart(120_000, 0)));
							release = () => {
								if (signal.aborted) controller.error(new Error("cancelled"));
								else {
									for (const e of end) controller.enqueue(packet(e));
									controller.close();
								}
							};
						},
					}),
				);
			},
			async (s) => {
				await s.answer();
				const manager = s.runtime.session.sessionManager;
				await s.ticks(276);
				assert.equal(typeof release, "function", "the refresh is out");
				if (reloadFirst) await s.runtime.session.reload();
				release?.();
				await s.ticks(2);
				if (!reloadFirst) await s.runtime.session.reload();
				const file = readFileSync(manager.getSessionFile(), "utf8").split("\n").filter(Boolean).map((line: string) => JSON.parse(line));
				seen = {
					onBranch: manager.getBranch().filter((e: Any) => e.type === "custom" && e.customType === "cache-keeper-refresh").length,
					inFile: file.filter((e: Any) => e.customType === "cache-keeper-refresh"),
					aborted: sent?.aborted,
				};
			},
			{ ui: true, persisted: true },
		);
		assert.deepEqual(result.thrown, []);
		assert.equal(result.refreshes, 1);
		assert.equal(seen.aborted, reloadFirst, "the reload cancels a refresh still on its way");
		assert.equal(seen.inFile.length, 1, "one line in the session file");
		assert.equal(seen.onBranch, 1);
		assert.match(seen.inFile[0].data.text, reloadFirst ? /^Cache warmed \(pi-cache-keeper, refresh 1\): .*\. It was then cancelled by a new request or a change of session\.$/ : /^Cache warmed \(pi-cache-keeper, refresh 1\): /);
	});
}
