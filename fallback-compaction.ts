// The fallback compaction model (design/fallback-compaction-model.md): which model the user picked, whether it can write a
// summary of this session, and how it is shown. No state: the handler in index.ts asks, Pi's own compact() writes.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, type Api, type Model } from "@earendil-works/pi-ai";
import { convertToLlm, serializeConversation, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { MIN_SUMMARY_TOKENS, summaryBudget } from "./config.ts";
import { formatTokens, formatWindow } from "./trace.ts";

/** `"provider/modelId"`, split at the first slash. Undefined: not a reference (`""` is off, and is not one). */
export function parseModelRef(value: string): { provider: string; id: string } | undefined {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return undefined;
	return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

export function formatModelRef(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

/**
 * How text is counted in tokens, high enough for dense text and near enough for prose: the text is split on whitespace;
 * a word that is ASCII and at most `FALLBACK_SHORT_WORD` characters long counts its length / 3 tokens (at least 1); any other
 * word (non-ASCII, or longer: base64, hashes, minified code, CJK) counts one token per UTF-8 byte, since a token of a
 * byte-level tokenizer covers at least one byte. Measured against OpenAI's o200k_base and cl100k_base (gpt-tokenizer
 * 3.4.0): the README's prose 1.35 times its real size, this module's code 1.56, base64 1.39-1.47, rare CJK 1.29-1.58.
 */
export const FALLBACK_SHORT_WORD = 20;
/**
 * Pi's summarizer prompt around the conversation, in tokens: at most 1,642 characters of English in Pi 1.6.0,
 * about 600 by the count above; rounded up.
 */
export const FALLBACK_PROMPT_TOKENS = 700;
const encoder = new TextEncoder();
const ASCII = /^[\x00-\x7f]*$/;

/** The tokens `text` is counted at (see FALLBACK_SHORT_WORD). */
export function fallbackTextTokens(text: string): number {
	let tokens = 0;
	for (const word of text.split(/\s+/)) {
		if (!word) continue;
		tokens += ASCII.test(word) && word.length <= FALLBACK_SHORT_WORD ? Math.max(1, word.length / 3) : encoder.encode(word).length;
	}
	return Math.ceil(tokens);
}

/**
 * The output a model that can't turn thinking off adds for its lowest level (Pi's default thinking budgets): an adapter
 * that budgets thinking adds it to the output cap passed, so it is kept out of the cap.
 */
const THINKING_RESERVE: Record<string, number> = { off: 0, minimal: 1_024, low: 2_048, medium: 8_192, high: 16_384 };
export const thinkingReserve = (level: string): number => THINKING_RESERVE[level] ?? 16_384;

/** Pi's API of a virtual model, and pi-claude-bridge's: neither can take a summary request this way. */
const VIRTUAL_API = "pi-virtual";
const BRIDGE_API = "claude-bridge";
/** How Pi's summarizer adds `/compact` instructions to its prompt. */
const FOCUS_PREFIX = "\n\nAdditional focus: ";

/** Pi's compaction preparation (not exported by name from the package). */
type CompactionPreparation = SessionBeforeCompactEvent["preparation"];

const conversationTokens = (messages: AgentMessage[]) => fallbackTextTokens(serializeConversation(convertToLlm(messages)));

/** The requests Pi's compact() sends for a preparation, each in tokens as counted here: one, or two for a split turn. */
export function fallbackRequestTokens(
	preparation: Pick<CompactionPreparation, "messagesToSummarize" | "turnPrefixMessages" | "isSplitTurn" | "previousSummary">,
	customInstructions?: string,
): number[] {
	const { messagesToSummarize, turnPrefixMessages, isSplitTurn, previousSummary } = preparation;
	const focus = customInstructions ? fallbackTextTokens(FOCUS_PREFIX + customInstructions) : 0;
	const splitTurn = isSplitTurn && turnPrefixMessages.length > 0;
	const requests: number[] = [];
	// The history, with the previous summary; a split turn without earlier history sends only the turn's prefix.
	if (!splitTurn || messagesToSummarize.length > 0) requests.push(conversationTokens(messagesToSummarize) + fallbackTextTokens(previousSummary ?? "") + FALLBACK_PROMPT_TOKENS + focus);
	if (splitTurn) requests.push(conversationTokens(turnPrefixMessages) + FALLBACK_PROMPT_TOKENS + focus);
	return requests;
}

/** The larger request, in tokens. */
export function fallbackNeedTokens(requestTokens: number[]): number {
	return Math.max(0, ...requestTokens);
}

/** A reply's summary without the file lists Pi or the model added: what is checked for being empty. */
export function summaryBody(text: string): string {
	return text.replace(/<(read-files|modified-files)>[\s\S]*?<\/\1>/g, "").trim();
}

/** Why a model can't write a summary this way whatever the session's size, or undefined. */
export function fallbackUnusable(model: { api: string }): string | undefined {
	if (model.api === VIRTUAL_API) return "it is a virtual model";
	if (model.api === BRIDGE_API) return "it runs through pi-claude-bridge";
	return undefined;
}

/**
 * `maxTokens`: the output cap the request is sent with, the one the fit assumed. `never`: the model can't hold any
 * session (its output limit, less what thinking adds, is under the summary's minimum).
 */
export type FallbackFit = { fits: true; need: number; window: number; maxTokens: number } | { fits: false; why: string; need: number; window?: number; never?: true };

/** Why a model whose output limit can never leave room for a summary is refused, in the menu and in the record. */
export const OUTPUT_TOO_SMALL = "output limit too small";

/**
 * The fit rule: a known window, and room for the summary beside the need: the model's output limit, reduced so the
 * request, a margin and the summary fit the window (summaryBudget), less what thinking adds (`reserve`), at least 16k, or
 * the whole limit where it is smaller. That cap is passed with the request.
 */
export function fallbackFit(model: { contextWindow: number; maxTokens: number }, need: number, reserve = 0): FallbackFit {
	if (!(model.contextWindow > 0)) return { fits: false, why: "it declares no context window", need };
	const window = model.contextWindow;
	const room = (summaryBudget(model, need) ?? 0) - reserve;
	const least = model.maxTokens > 0 ? Math.min(MIN_SUMMARY_TOKENS, model.maxTokens) : MIN_SUMMARY_TOKENS;
	// Whatever the session's size: the output limit less the thinking can't reach the minimum.
	if (model.maxTokens > 0 && model.maxTokens - reserve < least) return { fits: false, why: OUTPUT_TOO_SMALL, need, window, never: true };
	if (room >= least) return { fits: true, need, window, maxTokens: room };
	return { fits: false, why: `it needs about ${formatTokens(need)} tokens and its window is ${formatWindow(window)}`, need, window };
}

/**
 * The one fit of a model for a need, used by the menu and by the compaction alike so they can't disagree: the thinking
 * level the request is sent at (the lowest the model has) and the fit with what that level adds kept out of the cap.
 */
export function fallbackModelFit(model: Model<Api>, need: number): { fit: FallbackFit; thinking: ReturnType<typeof clampThinkingLevel> } {
	const thinking = clampThinkingLevel(model, "off");
	return { fit: fallbackFit(model, need, thinkingReserve(thinking)), thinking };
}

/** One model of the menu's list. */
export interface FallbackChoice {
	ref: string;
	/**
	 * The model's name as Pi has it: the list shows it where it says more than the id (distinctModelName), and the access
	 * it states decides whether the line's own access part is shown (fallbackAccess).
	 */
	name?: string;
	window?: number;
	/** Dollars per million tokens at the size needed; absent without prices. */
	price?: { input: number; output: number };
	subscription: boolean;
	/** Absent where the model can't be used at all (`unusable` says why). */
	fit?: FallbackFit;
	unusable?: string;
}

/** A price per million tokens: "$0.30", "$15.00", "$0.075". */
const perMillion = (dollars: number) => (dollars === 0 || dollars >= 0.1 ? `$${dollars.toFixed(2)}` : `$${Number(dollars.toPrecision(2))}`);

/** Lower-case words of letters and digits: "Claude Opus 5.5 · Anthropic sub, fallback api" → claude, opus, 5, 5, anthropic, sub, fallback, api. */
const wordsOf = (value: string) => value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * The access a model's name states, in the words pi-provimux adds to it ("Anthropic sub, fallback api", "Devin sub",
 * "OpenRouter api"): a subscription login ("sub"), an API key ("api"), both, or neither (a name that says nothing of it).
 */
export function nameAccess(name: string | undefined): { sub: boolean; api: boolean } {
	const words = wordsOf(name ?? "");
	return { sub: words.includes("sub") || words.includes("subscription"), api: words.includes("api") };
}

/**
 * The access part of a model's line: "subscription", its price, or "no price", as this extension's own data has it.
 * Left out where the model's name states an access that part would contradict: "subscription" beside a name that says
 * "api" ("Anthropic sub, fallback api": a failed subscription request is paid by the key), a price beside a name that
 * says "sub" ("Devin sub", or a subscription first). The name comes from the proxy that routes the model and says more
 * than one word could; the window and the fit stay.
 */
export function fallbackAccess(choice: Pick<FallbackChoice, "name" | "price" | "subscription">): string | undefined {
	const said = nameAccess(choice.name);
	if (choice.subscription ? said.api : said.sub) return undefined;
	return choice.subscription ? "subscription" : choice.price ? `${perMillion(choice.price.input)} in, ${perMillion(choice.price.output)} out per M` : "no price";
}

/** A model's window and its price, or that it is a subscription (fallbackAccess): what /cache-keeper shows of the picked model. */
export function fallbackModelParts(choice: Pick<FallbackChoice, "name" | "window" | "price" | "subscription">): string[] {
	const window = choice.window ? `${formatWindow(choice.window)} window` : "window unknown";
	const access = fallbackAccess(choice);
	return access === undefined ? [window] : [window, access];
}

/** The parts after the model in its line in the menu: its window, its access (fallbackAccess), and whether it holds this session now. */
export function fallbackChoiceParts(choice: FallbackChoice): string[] {
	const parts = fallbackModelParts(choice);
	if (choice.unusable) parts.push(`can't be used: ${choice.unusable}`);
	else if (choice.fit?.fits) parts.push("holds this session");
	else if (choice.fit && (choice.fit.window === undefined || choice.fit.never)) parts.push(`can't be used: ${choice.fit.why}`);
	else if (choice.fit) parts.push(`too small now (needs about ${formatTokens(choice.fit.need)})`);
	return parts;
}

/**
 * The menu's order: the models that hold this session first, then the ones too small now, then those that can't be
 * used; in each, subscription logins, then by input price (lowest first), then the ones without a price; names break ties.
 */
export function orderFallbackChoices(choices: FallbackChoice[]): FallbackChoice[] {
	const group = (c: FallbackChoice) => (c.unusable || (c.fit && !c.fit.fits && (c.fit.window === undefined || c.fit.never)) ? 2 : c.fit?.fits ? 0 : 1);
	const cost = (c: FallbackChoice) => (c.subscription ? -1 : (c.price?.input ?? Infinity));
	return [...choices].sort((a, b) => group(a) - group(b) || cost(a) - cost(b) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}

// ------------------------------------------------------------- the list, drawn as Pi's /model picker draws a model

/**
 * The model's name where it says more than its id, else undefined. Pi's `getDistinctModelName` (Pi 1.6.0,
 * dist/modes/interactive/model-search.js), which the package doesn't export: copied, the same in what it returns.
 */
export function distinctModelName(item: { id: string; name?: string }): string | undefined {
	const name = item.name?.trim();
	if (!name) return undefined;
	const idWords = wordsOf(item.id);
	const idTokens = new Set(idWords);
	const compactId = idWords.join("");
	// Single-character words must match a whole id token: "4" is not covered by "mistral-small-2603".
	const covered = (word: string) => idTokens.has(word) || (word.length > 1 && compactId.includes(word));
	return wordsOf(name).every(covered) ? undefined : name;
}

/**
 * The text a model is searched by: its provider, its reference, its id and its name. Pi's `getModelSelectorSearchText`
 * (Pi 1.6.0, dist/modes/interactive/model-search.js), which the package doesn't export: copied.
 */
export function modelSearchText(item: { id: string; provider: string; name?: string }): string {
	const { id, provider } = item;
	const name = item.name ? ` ${item.name}` : "";
	return `${provider} ${provider}/${id} ${provider} ${id}${name}`;
}

/** A saved reference as Pi's model picker names a model: "devin/claude-opus-5-5 [provimux]"; a value that is no reference as it is. */
export function fallbackModelLabel(ref: string): string {
	const parsed = parseModelRef(ref);
	return parsed ? `${parsed.id} [${parsed.provider}]` : ref;
}

/**
 * A piece of a list line and how it is drawn, as in Pi's picker: the model id (the accent colour on the selected row),
 * its distinct name and the `[provider]` badge (muted), the window, access and fit after them (muted, as Pi's
 * " · default"), a row's own label (off, the default: drawn as an id is), and the blanks between them.
 */
export interface LinePart {
	text: string;
	kind: "id" | "name" | "badge" | "rest" | "label" | "gap";
}

/** A row of the list: a model (its reference, its name as Pi has it, the parts after it), or a line of its own (off, the default). */
export type FallbackRow = { label: string } | { ref: string; name?: string; rest: readonly string[] };

/** The text of a line's parts. */
export const partsText = (parts: readonly LinePart[]): string => parts.map((part) => part.text).join("");

/** The pieces that stay whole: the id, "(Name)" where Pi would show it, "[provider]"; or the row's own label. */
function headOf(row: FallbackRow): LinePart[] {
	if ("label" in row) return [{ text: row.label, kind: "label" }];
	const parsed = parseModelRef(row.ref) ?? { id: row.ref, provider: "" };
	const name = distinctModelName({ id: parsed.id, name: row.name });
	return [{ text: parsed.id, kind: "id" }, ...(name ? [{ text: `(${name})`, kind: "name" as const }] : []), { text: `[${parsed.provider}]`, kind: "badge" }];
}

/** A row on one line, as wide as it is: "devin/claude-opus-5-5 (Claude Opus 5.5 (Devin) · Devin sub) [provimux] · 1M window · holds this session". */
export function fallbackRowText(row: FallbackRow): string {
	const head = headOf(row).map((part) => part.text).join(" ");
	return "label" in row || row.rest.length === 0 ? head : `${head} · ${row.rest.join(" · ")}`;
}

/** A menu line of a model, as wide as it is (fallbackRowText). */
export function fallbackChoiceLabel(choice: FallbackChoice): string {
	return fallbackRowText({ ref: choice.ref, name: choice.name, rest: fallbackChoiceParts(choice) });
}

/** How far the lines after a row's first are indented, under its id. */
export const CONTINUATION_INDENT = 2;
/** The fewest columns the window, access and fit are cut to; with less room left, they are left out. */
const LEAST_REST = 6;

/**
 * One row at `width` columns, as its lines of parts. The id, the name and the badge are never cut: each goes whole onto
 * the next line (indented by CONTINUATION_INDENT) where the line has no room left for it; only a piece wider than a whole
 * line is broken, a name between its words, an id or a badge (or a word) where the line ends. The window, access and
 * fit follow on the last line and are what is cut: the fit kept first, then the access and the window where they still
 * fit; the fit, where it alone doesn't, cut at its end ("…"), or left out where fewer than LEAST_REST columns are left. Every row shows its
 * whole id and provider, so no two rows read the same.
 */
export function fallbackRowLayout(row: FallbackRow, width: number): LinePart[][] {
	const columns = Math.max(1, width);
	const indent = columns > CONTINUATION_INDENT * 2 ? CONTINUATION_INDENT : 0;
	const lines: LinePart[][] = [[]];
	let used = 0;
	let fresh = true;
	const newLine = () => {
		lines.push(indent ? [{ text: " ".repeat(indent), kind: "gap" }] : []);
		used = indent;
		fresh = true;
	};
	const put = (text: string, kind: LinePart["kind"]) => {
		if (!fresh) {
			lines[lines.length - 1].push({ text: " ", kind: "gap" });
			used += 1;
		}
		lines[lines.length - 1].push({ text, kind });
		used += text.length;
		fresh = false;
	};
	// A piece on this line, else whole on the next; one wider than a line in pieces.
	const place = (text: string, kind: LinePart["kind"], words: boolean) => {
		if (used + (fresh ? 0 : 1) + text.length <= columns) return put(text, kind);
		if (indent + text.length <= columns) {
			newLine();
			return put(text, kind);
		}
		if (words && text.includes(" ")) {
			for (const word of text.split(" ")) place(word, kind, false);
			return;
		}
		if (!fresh) newLine();
		let left = text;
		while (left) {
			const take = left.slice(0, columns - used);
			put(take, kind);
			left = left.slice(take.length);
			if (left) newLine();
		}
	};
	for (const part of headOf(row)) place(part.text, part.kind, part.kind === "name" || part.kind === "label");
	if ("ref" in row && row.rest.length > 0) {
		// The parts that fit whole, taken from the last (the fit first, then the access, then the window) and shown in
		// their order. Where not even the fit fits, it is cut at its end, if enough of it is left.
		const room = columns - used;
		const last = row.rest[row.rest.length - 1];
		const keep = new Set<number>();
		let taken = 0;
		for (let i = row.rest.length - 1; i >= 0; i--) {
			if (taken + 3 + row.rest[i].length > room) continue;
			keep.add(i);
			taken += 3 + row.rest[i].length;
		}
		const kept = row.rest.filter((_, i) => keep.has(i));
		const shown = keep.has(row.rest.length - 1) ? ` · ${kept.join(" · ")}` : room - 3 >= LEAST_REST ? ` · ${last.slice(0, room - 4).trimEnd()}…` : "";
		if (shown) lines[lines.length - 1].push({ text: shown, kind: "rest" });
	}
	return lines;
}

/** The menu's rows at `width` columns, each as its lines of parts (fallbackRowLayout). */
export function fallbackRowLines(rows: readonly FallbackRow[], width: number): LinePart[][][] {
	return rows.map((row) => fallbackRowLayout(row, width));
}
