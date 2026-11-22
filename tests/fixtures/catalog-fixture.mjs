// Writes the fields of Pi's built-in model catalog that the cold compaction model's list and fit read, from an installed
// pi-ai, as a fixture: node tests/fixtures/catalog-fixture.mjs <directory with node_modules> <out.json>
// Each model: [id, api, contextWindow, maxTokens, reasoning (0 or 1), thinking levels (a level mapped to null, or xhigh and
// max where mapped: what clampThinkingLevel reads), input price, output price], by provider.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [root, out] = process.argv.slice(2);
const ai = join(root, "node_modules/@earendil-works/pi-ai");
const { version } = JSON.parse(readFileSync(join(ai, "package.json"), "utf8"));
const { MODELS } = await import(pathToFileURL(join(ai, "dist/models.generated.js")).href);
const models = {};
for (const provider of Object.keys(MODELS)) {
	models[provider] = Object.values(MODELS[provider])
		.filter((m) => m.type === undefined || m.type === "chat")
		.map((m) => {
			const levels = Object.fromEntries(Object.entries(m.thinkingLevelMap ?? {}).filter(([level, value]) => value === null || ((level === "xhigh" || level === "max") && value !== undefined)).map(([level, value]) => [level, value === null ? null : 1]));
			return [m.id, m.api, m.contextWindow, m.maxTokens, m.reasoning ? 1 : 0, levels, m.cost?.input ?? 0, m.cost?.output ?? 0];
		});
}
writeFileSync(out, `${JSON.stringify({ pi: version, models })}\n`);
