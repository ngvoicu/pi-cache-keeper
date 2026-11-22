// The cold compaction model (design/cold-compaction-model.md): which model the user picked, whether it can write a
// summary of this session, and how it is shown. No state: the handler in index.ts asks, Pi's own compact() writes.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
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
 * a word that is ASCII and at most `COLD_SHORT_WORD` characters long counts its length / 3 tokens (at least 1); any other
 * word (non-ASCII, or longer: base64, hashes, minified code, CJK) counts one token per UTF-8 byte, since a token of a
 * byte-level tokenizer covers at least one byte. Measured against OpenAI's o200k_base and cl100k_base (gpt-tokenizer
 * 3.4.0): the README's prose 1.35 times its real size, this module's code 1.56, base64 1.39-1.47, rare CJK 1.29-1.58.
 */
export const COLD_SHORT_WORD = 20;
/**
 * Pi's summarizer prompt around the conversation, in tokens: at most 1,642 characters of English in Pi 0.87.0 and 1.6.0,
 * about 600 by the count above; rounded up.
 */
export const COLD_PROMPT_TOKENS = 700;
const encoder = new TextEncoder();
const ASCII = /^[\x00-\x7f]*$/;

/** The tokens `text` is counted at (see COLD_SHORT_WORD). */
export function coldTextTokens(text: string): number {
	let tokens = 0;
	for (const word of text.split(/\s+/)) {
		if (!word) continue;
		tokens += ASCII.test(word) && word.length <= COLD_SHORT_WORD ? Math.max(1, word.length / 3) : encoder.encode(word).length;
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

const conversationTokens = (messages: AgentMessage[]) => coldTextTokens(serializeConversation(convertToLlm(messages)));

/** The requests Pi's compact() sends for a preparation, each in tokens as counted here: one, or two for a split turn. */
export function coldRequestTokens(
	preparation: Pick<CompactionPreparation, "messagesToSummarize" | "turnPrefixMessages" | "isSplitTurn" | "previousSummary">,
	customInstructions?: string,
): number[] {
	const { messagesToSummarize, turnPrefixMessages, isSplitTurn, previousSummary } = preparation;
	const focus = customInstructions ? coldTextTokens(FOCUS_PREFIX + customInstructions) : 0;
	const splitTurn = isSplitTurn && turnPrefixMessages.length > 0;
	const requests: number[] = [];
	// The history, with the previous summary; a split turn without earlier history sends only the turn's prefix.
	if (!splitTurn || messagesToSummarize.length > 0) requests.push(conversationTokens(messagesToSummarize) + coldTextTokens(previousSummary ?? "") + COLD_PROMPT_TOKENS + focus);
	if (splitTurn) requests.push(conversationTokens(turnPrefixMessages) + COLD_PROMPT_TOKENS + focus);
	return requests;
}

/** The larger request, in tokens. */
export function coldNeedTokens(requestTokens: number[]): number {
	return Math.max(0, ...requestTokens);
}

/** A reply's summary without the file lists Pi or the model added: what is checked for being empty. */
export function summaryBody(text: string): string {
	return text.replace(/<(read-files|modified-files)>[\s\S]*?<\/\1>/g, "").trim();
}

/** Why a model can't write a summary this way whatever the session's size, or undefined. */
export function coldUnusable(model: { api: string }): string | undefined {
	if (model.api === VIRTUAL_API) return "it is a virtual model";
	if (model.api === BRIDGE_API) return "it runs through pi-claude-bridge";
	return undefined;
}

/** `maxTokens`: the output cap the request is sent with, the one the fit assumed. */
export type ColdFit = { fits: true; need: number; window: number; maxTokens: number } | { fits: false; why: string; need: number; window?: number };

/**
 * The fit rule: a known window, and room for the summary beside the need: the model's output limit, reduced so the
 * request, a margin and the summary fit the window (summaryBudget), less what thinking adds (`reserve`), at least 16k, or
 * the whole limit where it is smaller. That cap is passed with the request.
 */
export function coldFit(model: { contextWindow: number; maxTokens: number }, need: number, reserve = 0): ColdFit {
	if (!(model.contextWindow > 0)) return { fits: false, why: "it declares no context window", need };
	const window = model.contextWindow;
	const room = (summaryBudget(model, need) ?? 0) - reserve;
	const least = model.maxTokens > 0 ? Math.min(MIN_SUMMARY_TOKENS, model.maxTokens) : MIN_SUMMARY_TOKENS;
	if (room >= least) return { fits: true, need, window, maxTokens: room };
	return { fits: false, why: `it needs about ${formatTokens(need)} tokens and its window is ${formatWindow(window)}`, need, window };
}

/** One model of the menu's list. */
export interface ColdChoice {
	ref: string;
	window?: number;
	/** Dollars per million tokens at the size needed; absent without prices. */
	price?: { input: number; output: number };
	subscription: boolean;
	/** Absent where the model can't be used at all (`unusable` says why). */
	fit?: ColdFit;
	unusable?: string;
}

/** A price per million tokens: "$0.30", "$15.00", "$0.075". */
const perMillion = (dollars: number) => (dollars === 0 || dollars >= 0.1 ? `$${dollars.toFixed(2)}` : `$${Number(dollars.toPrecision(2))}`);

/** A model's window and its price, or that it is a subscription: what /cache-keeper shows of the picked model. */
export function coldModelParts(choice: Pick<ColdChoice, "window" | "price" | "subscription">): string[] {
	const window = choice.window ? `${formatWindow(choice.window)} window` : "window unknown";
	const price = choice.subscription ? "subscription" : choice.price ? `${perMillion(choice.price.input)} in, ${perMillion(choice.price.output)} out per M` : "no price";
	return [window, price];
}

/** The three parts of a model's line in the menu: its window, its price or that it is a subscription, and whether it holds this session now. */
export function coldChoiceParts(choice: ColdChoice): string[] {
	const parts = coldModelParts(choice);
	if (choice.unusable) parts.push(`can't be used: ${choice.unusable}`);
	else if (choice.fit?.fits) parts.push("holds this session");
	else if (choice.fit && choice.fit.window === undefined) parts.push(`can't be used: ${choice.fit.why}`);
	else if (choice.fit) parts.push(`too small now (needs about ${formatTokens(choice.fit.need)})`);
	return parts;
}

/** "google/gemini-2.5-flash · 1M window · $0.30 in, $2.50 out per M · holds this session". */
export function coldChoiceLabel(choice: ColdChoice): string {
	return [choice.ref, ...coldChoiceParts(choice)].join(" · ");
}

/**
 * The menu's order: the models that hold this session first, then the ones too small now, then those that can't be
 * used; in each, subscription logins, then by input price (lowest first), then the ones without a price; names break ties.
 */
export function orderColdChoices(choices: ColdChoice[]): ColdChoice[] {
	const group = (c: ColdChoice) => (c.unusable || (c.fit && !c.fit.fits && c.fit.window === undefined) ? 2 : c.fit?.fits ? 0 : 1);
	const cost = (c: ColdChoice) => (c.subscription ? -1 : (c.price?.input ?? Infinity));
	return [...choices].sort((a, b) => group(a) - group(b) || cost(a) - cost(b) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}

/**
 * A menu line fitted to `width` columns. Where the model's reference doesn't fit, its end is kept (the part that tells
 * two models of one provider apart), after an ellipsis; otherwise the line is cut at its end.
 */
export function fitColdLine(line: string, ref: string, width: number): string {
	if (line.length <= width) return line;
	if (ref.length <= width && line.startsWith(ref)) return line.slice(0, width);
	return width <= 1 ? "…".slice(0, width) : `…${ref.slice(ref.length - (width - 1))}`;
}
