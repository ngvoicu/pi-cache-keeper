// Pi's real session runtime around the extension: /new and /reload while a refresh is still streaming. Pi invalidates
// the old extension context on replacement; anything the extension does with it afterwards throws, and an error thrown
// out of a callback ends Pi. The refresh must settle without a throw, and what it showed (a miss, a hit, nothing) must
// still be counted. No network: the adapter's transport is in memory, and the global fetch rejects.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const skip = runtimeModule && servicesModule && sessionModule && catalog && anthropic && transcript ? false : "the installed Pi has no session runtime to drive";

const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
const STORE = Symbol.for("pi-cache-keeper.warm-misses");
const store = () => (globalThis as Record<symbol, { counts: Map<string, number>; fallback: Map<string, number> } | undefined>)[STORE];
const flush = () => new Promise((resolve) => setImmediate(resolve));
const encoder = new TextEncoder();
const packet = (event: { type: string }) => encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);

async function replaceDuringRefresh(replace: "new" | "reload", shows: "miss" | "hit" | "nothing") {
	writeFileSync(
		join(dir, "settings.json"),
		JSON.stringify({ cacheKeeper: { modelData: false, keepWarmMinutes: 120, cacheRetention: "short", compactBeforeExpiry: false, compactAtPercent: 0 }, cacheWarming: "idle", packages: [] }),
	);
	delete (globalThis as Record<symbol, unknown>)[STORE];
	const model = catalog.MODELS.anthropic["claude-sonnet-4-6"];
	const loader = {
		additionalExtensionPaths: [new URL("../index.ts", import.meta.url).pathname],
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
	const runtime = await runtimeModule.createAgentSessionRuntime(factory, { cwd, agentDir: dir, sessionManager: sessionModule.SessionManager.inMemory(cwd) });
	const thrown: unknown[] = [];
	const onThrow = (error: unknown) => thrown.push(error);
	process.on("uncaughtException", onThrow);
	process.on("unhandledRejection", onThrow);
	const runnerErrors: unknown[] = [];
	const runner = runtime.session.extensionRunner;
	await runtime.session.bindExtensions({ onError: (error: unknown) => runnerErrors.push(error) });
	const ctx = runner.createContext();
	const sessions = runtime.session.sessionManager;
	const usage = (read: number, write: number) => ({ input_tokens: 5, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 1, cache_creation: { ephemeral_5m_input_tokens: write, ephemeral_1h_input_tokens: 0 } });
	const messageStart = (read: number, write: number) => ({ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: model.id, content: [], stop_reason: null, usage: usage(read, write) } });
	const end = [{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }, { type: "message_stop" }];
	const sse = (body: ReadableStream) => new Response(body, { headers: { "content-type": "text/event-stream" } });
	let refreshes = 0;
	ctx.modelRegistry.streamSimple = (m: Any, context: Any, options: Any) =>
		anthropic.streamSimple(m, context, {
			...options,
			apiKey: "sk-fixture",
			maxRetries: 0,
			cacheRetention: "short",
			fetch: async () => {
				refreshes++;
				// The refresh's stream reports what it read (or nothing), then stays open until the session goes.
				return sse(
					new ReadableStream({
						start(controller) {
							if (shows === "miss") controller.enqueue(packet(messageStart(0, 120_000)));
							if (shows === "hit") controller.enqueue(packet(messageStart(120_000, 0)));
							options.signal.addEventListener("abort", () => controller.error(new Error("cancelled")), { once: true });
						},
					}),
				);
			},
		});
	mock.timers.reset();
	mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 100_000_000 });
	try {
		// One real answer that read the cache: the period is the extension's.
		const ask = { role: "user", timestamp: Date.now(), content: [{ type: "text", text: "Read the change." }] };
		await runner.emit({ type: "agent_start" });
		sessions.appendMessage(ask);
		const messages = await runner.emitContext(transcript.normalizeContext({ systemPrompt: "Review code.", messages: [ask], tools }).messages);
		const answer = await anthropic
			.streamSimple(model, { messages }, {
				apiKey: "sk-fixture",
				maxTokens: 8192,
				cacheRetention: "short",
				onPayload: (payload: unknown) => runner.emitBeforeProviderRequest(payload),
				fetch: async () =>
					sse(
						new ReadableStream({
							start(c) {
								for (const e of [messageStart(120_000, 0), ...end]) c.enqueue(packet(e));
								c.close();
							},
						}),
					),
			})
			.result();
		assert.equal(answer.stopReason, "stop");
		await runner.emitMessageEnd({ type: "message_end", message: answer });
		sessions.appendMessage(answer);
		await runner.emit({ type: "agent_settled", aborted: false });
		assert.equal(await runner.emitCacheWarmingDecision({ type: "cache_warming_decision", action: "warm", timestamp: Date.now() }), "stop", "owned");
		// To the refresh, 25 s before the 5-minute expiry; it is still streaming when the session is replaced.
		for (let i = 0; i < 276; i++) {
			mock.timers.tick(1000);
			await flush();
		}
		assert.equal(refreshes, 1, "the refresh went out");
		if (replace === "reload") await runtime.session.reload();
		else await runtime.newSession();
		for (let i = 0; i < 20; i++) {
			mock.timers.tick(1000);
			await flush();
		}
	} finally {
		mock.timers.reset();
		await runtime.dispose();
		process.off("uncaughtException", onThrow);
		process.off("unhandledRejection", onThrow);
	}
	return { thrown, runnerErrors, counts: Object.fromEntries(store()?.counts ?? []), fallback: [...(store()?.fallback.keys() ?? [])] };
}

for (const replace of ["new", "reload"] as const) {
	for (const shows of ["miss", "hit", "nothing"] as const) {
		test(`/${replace} while a refresh that reported ${shows === "nothing" ? "nothing" : `a ${shows}`} is still streaming: nothing throws, and ${shows === "miss" ? "the miss is counted" : "nothing is counted"}`, { skip }, async () => {
			const result = await replaceDuringRefresh(replace, shows);
			assert.deepEqual(result.thrown, [], "nothing thrown out of a callback");
			assert.deepEqual(result.counts, shows === "miss" ? { "anthropic/claude-sonnet-4-6": 1 } : {}, "the count");
			assert.deepEqual(result.fallback, []);
		});
	}
}
