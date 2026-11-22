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
 * Pi's summarizer prompt around the conversation, in tokens: at most 1,642 characters of English in Pi 0.87.0 and 1.6.0,
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

/** A model's window and its price, or that it is a subscription: what /cache-keeper shows of the picked model. */
export function fallbackModelParts(choice: Pick<FallbackChoice, "window" | "price" | "subscription">): string[] {
	const window = choice.window ? `${formatWindow(choice.window)} window` : "window unknown";
	const price = choice.subscription ? "subscription" : choice.price ? `${perMillion(choice.price.input)} in, ${perMillion(choice.price.output)} out per M` : "no price";
	return [window, price];
}

/** The three parts of a model's line in the menu: its window, its price or that it is a subscription, and whether it holds this session now. */
export function fallbackChoiceParts(choice: FallbackChoice): string[] {
	const parts = fallbackModelParts(choice);
	if (choice.unusable) parts.push(`can't be used: ${choice.unusable}`);
	else if (choice.fit?.fits) parts.push("holds this session");
	else if (choice.fit && (choice.fit.window === undefined || choice.fit.never)) parts.push(`can't be used: ${choice.fit.why}`);
	else if (choice.fit) parts.push(`too small now (needs about ${formatTokens(choice.fit.need)})`);
	return parts;
}

/** "google/gemini-2.5-flash · 1M window · $0.30 in, $2.50 out per M · holds this session". */
export function fallbackChoiceLabel(choice: FallbackChoice): string {
	return [choice.ref, ...fallbackChoiceParts(choice)].join(" · ");
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

/**
 * A model's reference shortened in the middle to `width` columns: the provider, the start of the id, an ellipsis, the end
 * of the id. The cut is placed where no other reference of `refs` reads the same (a third of the id's room kept at its
 * start where that is enough, the cut moved either way from there where not); where no single cut can, it stays at that
 * third, and fallbackRowLines shows the whole reference.
 */
export function shortenModelRef(ref: string, width: number, refs: readonly string[] = []): string {
	if (ref.length <= width) return ref;
	const slash = ref.indexOf("/") + 1;
	const provider = ref.slice(0, slash);
	const id = ref.slice(slash);
	const room = width - provider.length - 1;
	// A provider too long to keep: the end of the reference.
	if (room < 2) return width <= 1 ? "…".slice(0, Math.max(0, width)) : `…${ref.slice(ref.length - (width - 1))}`;
	const preferred = Math.round(room / 3);
	const cut = (head: number) => [provider + id.slice(0, head), id.slice(id.length - (room - head))] as const;
	const alone = (start: string, end: string) => !refs.some((other) => other !== ref && other.length >= start.length + end.length && other.startsWith(start) && other.endsWith(end));
	for (let step = 0; step <= room; step++) {
		for (const head of step === 0 ? [preferred] : [preferred + step, preferred - step]) {
			if (head < 0 || head > room) continue;
			const [start, end] = cut(head);
			if (alone(start, end)) return `${start}…${end}`;
		}
	}
	const [start, end] = cut(preferred);
	return `${start}…${end}`;
}

/**
 * A menu line fitted to `width` columns. Where the model's reference doesn't fit, the line is that reference shortened in
 * the middle (shortenModelRef, against the other references of the list, `refs`); otherwise the line is cut at its end.
 */
export function fitFallbackLine(line: string, ref: string, width: number, refs: readonly string[] = []): string {
	if (line.length <= width) return line;
	if (ref.length <= width && line.startsWith(ref)) return line.slice(0, width);
	return shortenModelRef(ref, width, refs);
}

/**
 * The menu's rows at `width` columns, each as its lines: one line fitted by fitFallbackLine; or, for rows that would still
 * read the same as another row of the list, the whole reference over as many lines as it takes, then the rest of the
 * row cut to the width. `ref` is "" for a row that is no model (off, the default).
 */
export function fallbackRowLines(rows: readonly { label: string; ref: string }[], width: number): string[][] {
	const columns = Math.max(1, width);
	const refs = rows.map((row) => row.ref).filter(Boolean);
	const lines = rows.map((row) => fitFallbackLine(row.label, row.ref, columns, refs));
	const count = new Map<string, number>();
	for (const line of lines) count.set(line, (count.get(line) ?? 0) + 1);
	return rows.map((row, i) => {
		if ((count.get(lines[i]) ?? 0) < 2 || !row.ref) return [lines[i]];
		const full: string[] = [];
		for (let at = 0; at < row.ref.length; at += columns) full.push(row.ref.slice(at, at + columns));
		const rest = (row.label.startsWith(row.ref) ? row.label.slice(row.ref.length) : "").replace(/^ · /, "");
		return rest ? [...full, rest.slice(0, columns)] : full;
	});
}
