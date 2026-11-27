// The fallback compaction model's list against Pi's built-in model catalogs, in Pi's own session runtime (review of 0.10.0,
// round 2): the list and the compaction use one fit, so they agree on every model; and every model's row reads
// differently from every other at 40 and 60 columns, its id and provider whole (0.10.4). The catalog is a fixture of Pi 1.6.0's
// (tests/fixtures/catalog-fixture.mjs wrote it).
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FALLBACK, dir, inWindow, settingsFile, type Any } from "./session-runtime.ts";

const CATALOGS = ["1.6.0"] as const;
const catalog = (version: (typeof CATALOGS)[number]): Any[] => {
	const { pi, models } = JSON.parse(readFileSync(new URL(`./fixtures/pi-${version}-catalog.json`, import.meta.url), "utf8"));
	assert.equal(pi, version);
	const list: Any[] = [];
	for (const [provider, rows] of Object.entries(models) as [string, Any[]][]) {
		for (const [id, api, contextWindow, maxTokens, reasoning, levels, input, output] of rows) {
			list.push({ provider, id, name: id, api, baseUrl: "https://catalog.invalid", input: ["text"], contextWindow, maxTokens, reasoning: reasoning === 1, ...(Object.keys(levels).length ? { thinkingLevelMap: levels } : {}), cost: { input, output, cacheRead: 0, cacheWrite: 0 } });
		}
	}
	return list;
};
const refOf = (model: Any) => `${model.provider}/${model.id}`;

// Every other setting off; the fallback compaction model as given.
const settings = (pick: string) =>
	writeFileSync(
		settingsFile,
		JSON.stringify({ cacheKeeper: { compactAtPercent: 0, compactAtTokens: 0, compactBeforeExpiry: false, keepWarmMinutes: 0, modelData: false, cacheRetention: "short", fallbackCompactionModel: pick }, cacheWarming: "idle", packages: [] }),
	);
// Pi's styles and its terminal marks taken out.
const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b_[^\x07]*\x07/g, "");
const STYLED = /^\x1b\[/;

// The list's own lines, as drawn at `width`: between the search line and the key hints.
const listLines = (raw: string[]) => {
	const from = raw.findIndex((line) => plain(line).startsWith(">")) + 1;
	const to = raw.findIndex((line) => plain(line).startsWith("Type to search"));
	assert.ok(from > 0 && to > from, raw.map(plain).join("\n"));
	return raw.slice(from, to);
};
// The selected row's lines: its first starts with the styled "→ " (as in Pi's picker), its next ones are indented 6
// columns, under its id; the marks (4 columns) and that indent are taken off.
const selectedRow = (raw: string[]) => {
	const lines = listLines(raw);
	const first = lines.findIndex((line) => STYLED.test(line) && plain(line).startsWith("→ "));
	assert.ok(first >= 0, lines.map(plain).join("\n"));
	const row = [plain(lines[first]).slice(4)];
	for (const line of lines.slice(first + 1).map(plain)) {
		if (!/^ {6}\S/.test(line)) break;
		row.push(line.slice(6));
	}
	return row;
};
// The reference a row names: "@cf/openai/gpt-oss-120b [cloudflare-workers-ai] · …" → "cloudflare-workers-ai/@cf/openai/gpt-oss-120b".
const refOfRow = (row: string) => {
	const match = /^(\S+) \[([^\]]+)\] · /.exec(row);
	return match ? `${match[2]}/${match[1]}` : undefined;
};

// The catalog's models listed with credentials; a request to one of them is answered at once with a summary.
const withCatalog = (w: Any, models: Any[]) => {
	const registry = w.runtime.session.extensionRunner.createContext().modelRegistry;
	const stream = registry.streamSimple;
	const byRef = new Map(models.map((model) => [refOf(model), model]));
	registry.getAvailable = () => models;
	registry.find = (provider: string, id: string) => byRef.get(`${provider}/${id}`);
	registry.hasConfiguredAuth = () => true;
	registry.streamSimple = (model: Any, context: Any, options: Any) => {
		if (!byRef.has(refOf(model))) return stream(model, context, options);
		const reply = (async () => {
			await options?.onPayload?.({}, model);
			return { role: "assistant", content: [{ type: "text", text: "## Goal\nThe summary." }], api: model.api, provider: model.provider, model: model.id, usage: { input: 900, output: 90, cacheRead: 0, cacheWrite: 0, totalTokens: 990, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
		})();
		return { result: () => reply };
	};
};

// Each row of the open list, read one by one from the top (Down moves the selection, which wraps at the end).
const readRows = (menu: Any, count: number, width: number) => {
	const rows: string[][] = [];
	for (let i = 0; i < count; i++) {
		rows.push(selectedRow(menu.raw(width)));
		menu.keys("\x1b[B");
	}
	return rows;
};

// The large session: prose of about 150k tokens as counted (90,000 words of five letters).
const LARGE = Array.from({ length: 90_000 }, (_, i) => ["alpha", "bravo", "delta", "gamma", "omega"][i % 5]).join(" ");

for (const version of CATALOGS) {
	test(`round 2, blocker 1: the list and the compaction agree on every model of Pi ${version}'s catalog, for a small and a large session`, async () => {
		const models = catalog(version);
		for (const size of ["small", "large"] as const) {
			settings("");
			const seen: Any = {};
			const result = await inWindow(async (w) => {
				withCatalog(w, models);
				const manager = w.manager();
				manager.appendMessage({ role: "user", timestamp: Date.now(), content: [{ type: "text", text: size === "small" ? "Read the change." : LARGE }] });
				const own = refOf(w.runtime.session.model);
				// The list, as the menu shows it in this session.
				const menu = await w.menu();
				menu.press(FALLBACK);
				const labels = new Map<string, string>();
				for (const [row] of readRows(menu, models.length + 2, 400)) {
					const ref = refOfRow(row);
					if (ref) labels.set(ref, row.split(" · ").at(-1) as string);
				}
				menu.keys("\x1b");
				await menu.close();
				assert.equal(labels.size, models.length, "every model is listed");
				// The compaction, for each model picked: Pi's hook as /compact on this session (no request yet: the cache is cold).
				const runner = w.runtime.session.extensionRunner;
				const messages = manager.buildSessionProjection().messages;
				const branch = manager.getBranch();
				const decided = new Map<string, string>();
				for (const model of models) {
					const ref = refOf(model);
					settings(ref);
					writeFileSync(join(dir, "cache-keeper.jsonl"), "");
					await runner.emit({
						type: "session_before_compact",
						reason: "manual",
						willRetry: false,
						customInstructions: undefined,
						branchEntries: branch,
						signal: new AbortController().signal,
						preparation: { firstKeptEntryId: branch.at(-1).id, messagesToSummarize: messages, turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 1_000, previousSummary: undefined, fileOps: { read: new Set(), written: new Set(), edited: new Set() }, settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 } },
					});
					const record = readFileSync(join(dir, "cache-keeper.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).findLast((r: Any) => r.event === "compact");
					decided.set(ref, record.outcome === "cold" ? "wrote" : record.cold.skipped);
				}
				// /cache-keeper says the same of a pick that can never be used.
				settings("cloudflare-workers-ai/@cf/openai/gpt-oss-120b");
				seen.status = await w.status();
				seen.labels = labels;
				seen.decided = decided;
				seen.own = own;
			});
			assert.deepEqual(result.thrown, [], size);
			const disagree: string[] = [];
			const counts: Record<string, number> = {};
			for (const [ref, label] of seen.labels as Map<string, string>) {
				const decision = seen.decided.get(ref) as string;
				const agree =
					label === "holds this session"
						? decision === "wrote"
						: label.startsWith("too small now")
							? decision.startsWith("it needs about")
							: label.startsWith("can't be used: ")
								? decision === label.slice("can't be used: ".length)
								: false;
				counts[agree ? label.replace(/ \(.*$/, "") : "disagree"] = (counts[agree ? label.replace(/ \(.*$/, "") : "disagree"] ?? 0) + 1;
				if (!agree) disagree.push(`${ref}: the list says "${label}", the compaction "${decision}"`);
			}
			assert.deepEqual(disagree, [], `${size} session: ${disagree.length} of ${seen.labels.size} disagree`);
			// Each outcome is met, so the agreement is not one-sided.
			assert.ok(counts["holds this session"] > 0, `${size}: ${JSON.stringify(counts)}`);
			assert.ok(counts["can't be used: output limit too small"] > 0, `${size}: ${JSON.stringify(counts)}`);
			if (size === "large") assert.ok(counts["too small now"] > 0, `${size}: ${JSON.stringify(counts)}`);
			assert.equal(seen.labels.get("cloudflare-workers-ai/@cf/openai/gpt-oss-120b"), "can't be used: output limit too small", size);
			assert.equal(seen.labels.get(seen.own), "can't be used: it is the session's own model", size);
			assert.match(seen.status, /fallback compaction model \(asked to write the summary when the cache can't be used\): @cf\/openai\/gpt-oss-120b \[cloudflare-workers-ai\] · 128k window · \$0\.35 in, \$0\.75 out per M · can't be used: output limit too small/, size);
		}
	});

	test(`round 2, blocker 3: at 40 and 60 columns every model of Pi ${version}'s catalog has a row that reads differently from every other, its id and provider whole`, async () => {
		const models = catalog(version);
		settings("");
		const seen: Any = {};
		const result = await inWindow(async (w) => {
			withCatalog(w, models);
			const menu = await w.menu();
			menu.press(FALLBACK);
			for (const width of [40, 60]) seen[width] = readRows(menu, models.length + 2, width);
			menu.keys("\x1b");
			await menu.close();
		});
		assert.deepEqual(result.thrown, []);
		for (const width of [40, 60]) {
			const rows: string[][] = seen[width];
			assert.equal(rows.length, models.length + 2);
			const text = rows.map((row) => row.join("\n"));
			const first = new Map<string, number>();
			const same: string[] = [];
			text.forEach((row, i) => {
				if (first.has(row)) same.push(`${JSON.stringify(row)} (rows ${first.get(row)} and ${i})`);
				else first.set(row, i);
			});
			assert.deepEqual(same, [], `${width} columns`);
			// Each line within the width less the marks (4) and the free margin (2); a next line within it with its indent.
			for (const row of rows) row.forEach((line, at) => assert.ok(line.length + (at === 0 ? 4 : 6) <= width - 2, `${width}: ${line}`));
			// The stock Bedrock rows of the review: the whole id and the whole [amazon-bedrock] badge, wrapped, never cut.
			const haiku = (region: string) => text.find((row) => row.replace(/\n/g, "").startsWith(`${region}.anthropic.claude-haiku-4-5-20251001-v1:0`) && /(^|\s)\[amazon-bedrock\]/.test(row));
			assert.ok(haiku("eu") && haiku("us"), text.filter((row) => row.includes("haiku")).join(" | "));
			assert.notEqual(haiku("eu"), haiku("us"));
			// Every model's id and badge are in its row whole.
			for (const model of models) assert.ok(text.some((row) => row.replace(/\n/g, "").startsWith(model.id) && row.includes(`[${model.provider}]`)), `${width}: ${refOf(model)}`);
		}
	});
}
