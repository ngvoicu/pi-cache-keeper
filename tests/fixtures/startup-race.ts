// Run by tests/session-settings.test.ts in a process of its own, so the extension loads with the hook below in place:
// another window's save lands right after this window read the defaults at its start (as the extension's startup read
// of settings.json returns). Then one turn, and for compactBeforeExpiry the countdown to 20 s before the cache expires.
// Prints what /cache-keeper said and how many compactions the extension started.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const kind = process.argv[2] === "full" ? "full" : "expiry";
const h = await import("../session-runtime.ts");
const { saveConfig } = await import("../../config.ts");
h.writeDefaults({ compactAtTokens: kind === "full" ? 100_000 : 0, compactBeforeExpiry: kind === "expiry", keepWarmMinutes: 0, minContextTokens: 100_000 });
const settingsFile = `${h.dir}/settings.json`;
const realRead = fs.readFileSync;
let saved = false;
(fs as h.Any).readFileSync = (...args: h.Any[]) => {
	const read = (realRead as h.Any)(...args);
	if (!saved && args[0] === settingsFile && new Error().stack?.includes("at cacheKeeper (")) {
		saved = true;
		saveConfig(kind === "expiry" ? { compactBeforeExpiry: false } : { compactAtTokens: 0 });
	}
	return read;
};
syncBuiltinESMExports();
const seen: Record<string, unknown> = {};
const result = await h.inWindow(
	async (w) => {
		seen.savedDuringStartup = saved;
		await w.answer();
		if (kind === "expiry") await w.ticks(282);
		seen.status = h.lineOf(await w.status(), kind === "expiry" ? "before expiry" : "when full");
		seen.calls = w.compactAt.length;
	},
	{ persisted: true },
);
seen.thrown = result.thrown.length;
console.log(JSON.stringify(seen));
process.exit(0);
