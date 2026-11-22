# Compacting a cold cache with a model the user picks

The design of 0.10.0, not built yet. It is written against pi-cache-keeper 0.9.0 (the model data is providers.dev's safe values) and Pi 1.6.0. It says what the software is; the build chooses nothing about that. Where the build finds this document wrong, the document is corrected.

The ask: when a session is compacted and its prompt cache can't be read, the summary request pays the full input price of the session's own model for the whole conversation. On a large session with an expensive model that is dollars per compaction, or subscription quota. The user picks another model (a cheaper one, or one on a login with spare quota) to write that summary. The session goes on with its own model.

This is a small first version: one setting, one new module, one branch in the compaction handler.

## 0. The rule

**Where Pi's own compaction would run today, and a cold compaction model is set and can take the request, that model writes the summary, with Pi's own summarizer. Where it can't, or its request fails, Pi's own compaction runs exactly as today.**

Two things never change:

- **A cache that can be read.** The cached path writes the summary from the warm cache, on the session's model, as in 0.9.0.
- **Compacting before expiry.** It runs only while the cache is warm, and is cancelled when the cached path can't write the summary. The cold model never writes it.

The session's model and thinking level are never touched. Nothing is switched and switched back: the summary request goes to the picked model directly, beside the session.

## 1. The setting

### What it is

One setting, `coldCompactionModel`: a string, `"provider/modelId"` (split at the first slash, as Pi's own `provider/modelId` keys are), or `""` for off. **Off is the default**, and with it off nothing in this document happens.

```json
{
  "cacheKeeper": {
    "coldCompactionModel": "google/gemini-2.5-flash"
  }
}
```

Validation in `config.ts`, where every key is checked: a string that is empty, or has a non-empty provider before its first slash and a non-empty id after it; anything else is the usual "must be …" error. The value is not checked against Pi's model list when settings are read: models and credentials come and go, and a pick that can't be used now is one of the cases in section 3.

### Per session and the defaults

It is a compaction setting, so it follows the 0.8.0 rules as the five existing per-session keys do. It becomes the sixth entry of `SESSION_KEYS`:

- **The default** is `cacheKeeper.coldCompactionModel` in `~/.pi/agent/settings.json`, read as saved now at every compaction (`inEffect()`).
- **A session's own value** wins in that session. It is saved in the session's `cache-keeper-settings` entry, holds after a resume and in a fork made after it, and the latest entry on the branch decides.
- **A session can turn it off for itself** while the default names a model: its own value is `""`. No value of its own means it follows the default.
- **"Back to the defaults"** drops it with the session's other values.

The existing code treats a session value as `number | boolean`. The build widens that to `string` where a value is labelled or listed (`valueLabel`, the non-TUI listing, the entry renderer's `describeOwn`). The row is not one of the cycling `ROWS`: see the menu below.

Two compatibility facts, both already true of every key added so far:

- **A session entry read by an older version** leaves the unknown key out and goes on (`readSessionSettings`).
- **The defaults read by an older version** fail on an unknown key. The changelog says that going back to 0.9.0 needs the key removed from `settings.json`.

### The menu

`/cache-keeper-settings` gets one row after "Or once it holds":

| | |
|---|---|
| Label | `Compact a cold cache with` |
| Value, editing this session | `off · default`, `google/gemini-2.5-flash · default`, `off · this session`, `google/gemini-2.5-flash · this session` |
| Value, editing the defaults | `off` or `google/gemini-2.5-flash` |
| Enter | opens a list (the row's `submenu`), instead of stepping through values: there can be a hundred models |

The description under the row says what it does in two sentences, and carries the privacy sentence of section 6.

**The list** holds, in this order:

1. Editing this session only: `default (<the default's value>)`, which drops the session's own value.
2. `off`.
3. The models Pi has credentials for: `ctx.modelRegistry.getAvailable()`, without the ones that can't write a summary this way (section 3, "can't be offered"). The list can be searched by typing, as Pi's own model list can.

**Each model's line** shows three things beside its name:

| Part | From | Reads |
|---|---|---|
| Its window | `model.contextWindow`, which is the keeper's model data where `modelData` is on and Pi's own value otherwise | `1M window`, `200k window`, `window unknown` |
| Its price, or that it is a subscription | a subscription login (`accessVia` of `accessReader`: `"sub"`) reads `subscription`; else the model's prices at the size needed (`priceAt`), where it has any (`hasPrices`); else `no price` | `$0.30 in, $2.50 out per M`, `subscription`, `no price` |
| Whether it can hold this session now | the fit rule of section 3, on the whole context as text (below) | `holds this session`, `too small now (needs about 150k)`, `can't be used: it declares no context window` |

"This session now" is measured once, when the list opens: the context as it stands (`ctx.sessionManager.buildSessionProjection().messages`), written as text the way Pi's summarizer writes it, and counted as in section 3. It is an upper bound: a compaction sends only the part before the messages it keeps. When the defaults are edited, the column still speaks of the session the menu was opened in, and says so in the list's header.

**Order of the models:** the ones that hold this session first; among them subscription logins, then by input price, lowest first, then the ones without a price; names break ties. A picked model stays picked whatever its line says: the line is advice, and section 3 decides at each compaction.

**A pick Pi can't use now** (the model is gone, or its credentials are) is shown on the row as `<provider/id> · not available now`. The setting is kept: it works again when the model does.

Outside the TUI the listing gains `coldCompactionModel: <value> [default]` or `[this session; default <value>]`, as for the other keys. As with them, it is changed there by editing `settings.json`.

### "No matter what the settings are"

When the rule of section 0 applies, the cold model writes the summary whatever these are:

| It applies whatever | Because |
|---|---|
| the session's model and thinking level | that is the point: the summary request goes to the picked model, with no thinking or its lowest level |
| `compactAtPercent`, `compactAtTokens` | they decide when compacting when full starts, not who writes the summary |
| `keepWarmMinutes`, `compactBeforeExpiry`, `minContextTokens` | they act on a warm cache; a compaction they do not start is not theirs |
| `cacheRetention`, `modelData` | the summary request writes no cache; with `modelData` off, the window is Pi's own value |
| what started the compaction: `/compact` (with or without instructions), Pi's threshold, Pi's overflow recovery, compacting when full | every one of them ends in the same handler |

It can't override these:

| It never overrides | What holds instead |
|---|---|
| a cache the cached path can use | the cached path, on the session's model |
| compacting before expiry | cancelled when the cached path can't write the summary, as today |
| Pi's `compaction.enabled: false` | no automatic compaction starts; `/compact` still does, and the cold model writes that one |
| Pi's `compaction.reserveTokens`, `keepRecentTokens` and their per-model overrides | they are the session model's, and still decide when Pi compacts and which messages are kept |
| what the picked model can take | section 3 |
| another extension that answers `session_before_compact` | Pi's own rules between extensions |
| `/tree` branch summaries | not compactions; not in this version |

## 2. When it applies

### The compactions

| Trigger | Cold model |
|---|---|
| `/compact` (`manual`) | yes |
| Pi's threshold compaction (`threshold`) | yes |
| Pi's overflow recovery (`overflow`) | yes; the retry of the turn follows as today |
| Compacting when full (`full`) | yes |
| Compacting before expiry (`expiry`) | never |

### How "cold" is decided

Nothing new is measured. **The cache is cold for a summary exactly where the handler falls back to Pi's own compaction today**: the single point `fallBack` in `session_before_compact`, for every trigger but `expiry`. Those are the cases where the summary request would read nothing from the cache and Pi's compaction would pay the session model's full price:

| Group | The reasons, as the handler already words them |
|---|---|
| No live cache | no request since the session started or compacted, or since the model or branch changed · the model changed since the last request · the last request did not use the prompt cache · the prompt cache has expired · the prompt cache's expiry is unknown (in a keep-warm period: the route changed, or no lifetime can be read) |
| A cache the summary can't be read from | the last request overflowed the context window · the request's API is not supported · the conversation changed since the last request · the request no longer repeats the last one (prefix mismatch) · under 16k tokens of the window are left for a cached summary · no kept message has text to mark where the summary ends |
| The cached request was sent and gave no summary | it failed · it hit the output limit · the model called a tool · it returned no text |

The second and third groups include caches that are still warm. They are in, because the cost is the same as on a cold cache: Pi's compaction reads nothing from it either, and after any compaction the next request writes the context again. The card says which reason it was. (This is the first question for the owner in section 9.)

The expiry itself is read where it always is: `look()`, the one reading of the cache (`cache-clock.ts`), through `checkCachedPath`. No second clock.

### An unknown lifetime

A model with no cache lifetime at all (no countdown in the footer) is **not counted as cold**. There `look()` gives neither an expiry nor a reason, the cached path is tried as today, and what the request read shows on the card. The cold model writes the summary only if that path falls back for one of the reasons above.

Why: nothing the extension knows says such a cache is gone, and while it may be alive the rule "a warm cache changes nothing" holds. The price of this choice is the case where it was in fact gone: the cached request then pays the session model's full price, as in 0.9.0. (The second question for the owner in section 9.)

A model whose answers report no cache use at all is different: the reason is "the last request did not use the prompt cache", which is cold.

## 3. When it can't

In every case below, **Pi's own compaction runs as today**: the handler returns nothing, and Pi summarizes with the session's model. The record says which case it was (section 5).

### Can't be offered, and can't be used if set by hand

| Case | Reason on the record |
|---|---|
| A virtual model (Pi's `pi-virtual` API): it has no window of its own | `it is a virtual model` |
| Claude through pi-claude-bridge (`claude-bridge` API): a request there is a Claude Code query, with tools | `it runs through pi-claude-bridge` |

### Can't, decided at each compaction, before anything is sent

| Case | How it is known | Reason on the record |
|---|---|---|
| The pick is the session's own model | same provider and id as `ctx.model` | `it is the session's own model` |
| The model is missing | `ctx.modelRegistry.find(provider, id)` gives none | `Pi no longer lists it` |
| Its credentials are missing | `ctx.modelRegistry.hasConfiguredAuth(model)` is false | `Pi has no credentials for <provider>` |
| Its window is unknown | `model.contextWindow` is 0 | `it declares no context window` |
| The conversation and the summary don't fit | the fit rule below | `it needs about <need> tokens and its window is <window>` |

**The fit rule.** It uses the model as Pi's registry gives it, which carries the keeper's model data (the safe input window and output limit of 0.9.0, where `modelData` is on).

1. **What would be sent.** Pi's summarizer sends one request, or two for a split turn (the history, and the turn's prefix). Each is the messages as text (`serializeConversation(convertToLlm(messages))`: tool results cut to 2,000 characters, thinking left out), plus the previous summary and the `/compact` instructions where there are any, plus Pi's prompt (the existing `PI_PROMPT_CHARS`). This is the arithmetic `piCompactionInput` already does, per request.
2. **Counted high.** Each request's characters divided by `COLD_CHARS_PER_TOKEN = 3`, rounded up. Pi counts 4 characters per token; code and logs run nearer 3, and no request has been sent to this model to measure its tokenizer. The need is the larger request.
3. **Room for the summary.** `summaryBudget(model, need)`, the existing function: the model's output limit, reduced so the prompt, a 4k margin and the summary fit the window. The model fits when that is at least `MIN_SUMMARY_TOKENS` (16k), or at least its whole output limit where the limit is smaller.

Because the text is cut down, a session far larger than a model's window often fits it: 600k tokens of context can be 150k tokens of text.

An unknown window is refused, not tried: a local server that silently truncates would return a summary of the last part only, with no error to fall back on.

Counting high can refuse a model that would have fit; counting low sends a request that overflows and fails. Both end in Pi's own compaction, and the second costs a failed request, so the rule leans to the first.

### Can't, after the request was sent

| Case | Reason on the record |
|---|---|
| The request fails: a provider error, a rejected login, an overflow after all, a dropped stream. One attempt, no retry | `its request failed: <the error>` |
| The summary hit the output limit, or the model called a tool | `its request failed: <Pi's summarizer's own error>` |
| The summary is empty | `it returned no summary text` |

### Aborted

When the user aborts the compaction (the handler's `signal`), before or during the cold request, **the compaction ends as an aborted one does today**: the handler returns `{ cancel: true }`, as the cached path does for its own aborted request, with the reason `the compaction was aborted`. Nothing is sent after the abort; in particular Pi's own compaction is not started behind the user's back.

### Why nothing is ever lost

The handler can return only three things: a complete compaction with the `firstKeptEntryId` and `tokensBefore` of Pi's own preparation; nothing, which is Pi's own compaction; or a cancel, only for the user's abort. Pi appends the entry itself, and a compaction removes no entry from the session file. An overflow recovery gets either the cold model's summary or Pi's own, and retries the turn after either.

## 4. The summary itself

**It is Pi's summary, written by another model.** The extension calls Pi's own exported `compact()` (from `@earendil-works/pi-coding-agent`) with the handler's `preparation` and the picked model. Nothing of Pi's summarizer is copied, so it follows Pi when Pi changes it.

| | |
|---|---|
| Prompt | Pi's: its summarizer system prompt, the conversation as text, its checkpoint format; the update prompt with the previous summary where there is one; the split-turn prompt and the merge for a split turn; `/compact` instructions as "Additional focus" |
| Kept messages | Pi's: `preparation.firstKeptEntryId`, returned unchanged, with `preparation.tokensBefore` |
| Previous summaries | Pi's: passed as `<previous-summary>` and updated |
| File lists | as the cached path: Pi appends the lists of this span, and `checkpointSummary` replaces them with those merged with the previous compaction's `details`, because Pi carries lists forward only from compactions it wrote itself. The entry's `details` are `{ readFiles, modifiedFiles }` |
| Output limit | the picked model's: no `maxTokens` is passed, so Pi's request uses the model's limit, reduced to fit its window |
| Thinking | `clampThinkingLevel(model, "off")` from `@earendil-works/pi-ai`: off where the model can turn it off, else its lowest level |
| Cache | none written: Pi's summarizer sends `cacheRetention: "none"` and a routing id of its own |
| Credentials | Pi's, at request time: `compact()` is given a transport that calls `ctx.modelRegistry.streamSimple(model, context, options)`, and no key of the extension's own. A login is refreshed as for any request |
| Retries | none: `compact()` gets no retry policy. A failed attempt is Pi's own compaction's turn |
| Abort | the handler's `signal` |
| Usage | the request's usage (both requests' sum for a split turn) goes into the compaction entry, so Pi's session totals count it at the picked model's prices |

It differs from Pi's own compaction in the model, the thinking level and the missing retry, and in nothing else.

**After it.** The session's model and thinking level are as they were: the extension calls neither `pi.setModel` nor `pi.setThinkingLevel` for this. The request never passes the agent's own request path, so the keeper's captured request, its route reports for the session's model and its keep-warm period see nothing of it; `session_compact` then forgets the captured request as after any compaction.

## 5. What the user sees

### The log record

`CompactTrace` (`trace.ts`) gains one outcome and one field. One record per compaction, as today.

- `outcome` adds `"cold"`: the cold model wrote the summary. `"fallback"` stays "Pi's own compaction ran"; `"cancelled"` stays.
- `reason` stays what it is: why the cached path did not write the summary.
- `cold`, present whenever a cold model was set and the handler fell back:

| Field | |
|---|---|
| `model` | `"provider/id"`, as set |
| `via` | `"sub"`, `"api"` or `"sub or api"`, where known |
| `thinking` | the level sent |
| `needTokens`, `window` | the fit rule's two numbers, where it got that far |
| `requests` | 1, or 2 for a split turn |
| `response` | `{ seconds, usage, summaryChars }`, when it wrote the summary |
| `sessionModelCost` | what the same tokens cost at the session model's prices (`calculateCost`), when both models have prices |
| `skipped` | the reason of section 3, when it did not write the summary |

### The card and the `/cache-keeper` log line

`describeTrace` words the record. The lines read:

```text
13:48:54 /compact: summary by google/gemini-2.5-flash, the prompt cache has expired: 148k in, 3k out, $0.052, 12.3s, summary 5120 chars
         vs anthropic/claude-opus-4-5: 94% less, $0.052 instead of ~$0.82 for the same request
13:48:54   saved, 412k tokens summarized
```

```text
13:48:54 /compact: Pi's compaction, the prompt cache has expired; google/gemini-2.5-flash did not write the summary: it needs about 260k tokens and its window is 200k
13:48:59   Pi's compaction saved: 0% of 231k from cache, 2k out, $1.2, summary 4870 chars
```

- **The model and its cost** are on the first line. A subscription login reads `on a subscription` in place of the dollars; a model without prices reads `no price`.
- **The comparison line** appears only when both models have prices. It is the same request priced at the session's model, so it is marked `~`: the tokenizers differ.
- **The card's header** is `cold compaction` when the cold model wrote the summary, and the line is not painted as a warning: nothing went wrong. A fallback after a cold model that could not write it keeps today's warning colour.
- **Expanded** (`traceDetails`), one more line: `cold model: google/gemini-2.5-flash (API key), thinking off, about 148k tokens of a 1M window, 1 request`.

### `/cache-keeper`

- A new line after `when full:`. With a model: `cold compaction: google/gemini-2.5-flash (this session) · 1M window · $0.30 in, $2.50 out per M · holds this session`, the same three parts as the menu's line, with `(this session)` where the value is the session's own. Off: `cold compaction: off: when the cache can't be read, Pi's compaction writes the summary on this session's model`.
- The existing `next compaction:` line, where it says "Pi's compaction, because …" today: `google/gemini-2.5-flash, because <reason>` when the model can take it now, and `Pi's compaction, because <reason>; google/gemini-2.5-flash can't: <why>` when it can't.
- The `settings:` line lists it with the session's other own values.

The footer does not change in this version.

## 6. The README, with its privacy note

The README is part of 0.10.0: the release is not done without it. It gets five things, and the CHANGELOG its entry.

**1. A bullet in the opening "What it does:" list**, after "Compacts just before the cache expires", with its link:

> - **Compacts a cold cache with a model you pick.** When the cache can't be read, the summary would cost your session model's full input price; a cheaper model, or one on a login with spare quota, writes it instead, and the session goes on with its own model (off until you pick one). [More](#compacting-a-cold-cache-with-another-model).

That list is being brought up to date for 0.8.0 and 0.9.0 by other work. The bullet is added to the list as that work leaves it, in its wording and order, not to the list as it stands in 0.9.0.

**2. Its own section, "Compacting a cold cache with another model"**, after "Compacting from the cache". Four parts, in this order:

- **What it does:** the rule of section 0, and what the summary is (section 4): Pi's own summary, written by the picked model, with no thinking or its lowest level; the session's model and thinking level untouched. One comparison with the cached path: the cold model sees what Pi's compaction sees, tool results cut to 2,000 characters, not the whole conversation.
- **When it applies:** the table of triggers and the three groups of reasons of section 2, and the unknown lifetime.
- **When it falls back:** the cases of section 3, each ending in Pi's own compaction, the abort, and that nothing is lost.
- **The privacy note,** as worded here:

> **Where your conversation goes.** With a cold compaction model set, the part of the conversation being summarized is sent to that model's provider: your messages, the assistant's answers, the tool calls and the first 2,000 characters of each tool result, the previous summary, and any `/compact` instructions. That is the same text Pi's own compaction sends, but to another provider than the one your session talks to, under that provider's terms and with the credentials Pi holds for it. It is off by default, nothing is sent this way until you pick a model, and you can turn it off for one session only. The summary is then as good as the model you picked.

The menu row's description carries the note's first sentence.

**3. The row in the Settings table:**

| Setting | Menu | Default | Per session | What it does |
|---|---|---|---|---|
| `coldCompactionModel` | Compact a cold cache with | `""` | yes | when the cache can't be read, this model (`"provider/modelId"`) writes the summary instead of the session's own; `""` turns it off |

The paragraph above the table that names the session's own values gains `coldCompactionModel`.

**4. What is shown:** the card's new lines in "The compaction card and the log" (section 5), and the `cold compaction:` line under `/cache-keeper` in "Commands".

**5. "Limitations":** the items of section 9.

**The CHANGELOG entry**, under `## [0.10.0]`, `### Added`: one item, "A cold compaction model", saying the rule, the setting and its two layers, when it falls back, where the conversation goes, and that going back to 0.9.0 needs the key removed from `settings.json` (section 1).

## 7. Tests

Fake models and a fake registry everywhere; no test sends a real request (the harness already makes `fetch` throw). The fake registry answers `getAvailable`, `find`, `hasConfiguredAuth`, `isUsingOAuth`, `getProvider` and `streamSimple`; its `streamSimple` records each call (model, context, options) and returns a canned answer or failure.

**The pure module** (`tests/cold-compaction.test.ts`):

1. A model reference parses and formats; an id with slashes keeps them; a bad string is refused.
2. What would be sent: one request, and two for a split turn; the previous summary and the instructions are counted; tool results are counted cut.
3. The fit rule, as a table: fits · too small · window unknown · an output limit under 16k · the larger of two requests decides.
4. A menu line for each kind: priced, subscription, no price, window unknown, too small.
5. The order of the list.

**Settings** (`tests/config.test.ts`, `tests/session-settings.test.ts`):

6. The key is valid as `""` and as `provider/id`, and refused otherwise; it is a session key; an entry holding it is read, and its absence changes nothing.
7. A session's own value wins over the default; a session's `""` wins over a default model; the default is read as saved now; "Back to the defaults" drops it.
8. The menu row, its list and the lines of `/cache-keeper` and of the non-TUI listing.

**The handler** (`tests/cold-compaction-flow.test.ts`, built as `compact-before-expiry-flow.test.ts` builds its context):

9. Off: on a cold cache the handler returns nothing and the registry is never called.
10. Set, warm cache: the cached path writes the summary; the cold model gets no request.
11. Set, cold cache, for each of `manual`, `threshold`, `overflow` and `full`: the handler returns a compaction whose summary is the fake model's text, whose `firstKeptEntryId` and `tokensBefore` are the preparation's, whose `usage` is the fake's, and whose file lists include the previous compaction's.
12. The request it sent: to the picked model; Pi's summarizer system prompt; the conversation inside `<conversation>`; no `maxTokens` above the model's limit; no reasoning for a model that can turn it off, its lowest level for one that can't; no cache retention.
13. A previous summary is sent as `<previous-summary>`; a split turn sends two requests and sums their usage; `/compact` instructions are in the prompt.
14. `expiry`: a cache that went cold at the gate cancels, and the cold model gets no request.
15. Each "can't" of section 3 that is decided before sending: nothing is returned, no request is sent, and the record's `cold.skipped` is the reason.
16. Each failure after sending: a thrown error, an error answer, the output limit, a tool call, an empty text. Nothing is returned, one request was sent, the reason is recorded.
17. Abort before the request: none is sent, the result is a cancel. Abort during it: a cancel. In both, no compaction is returned.
18. After a cold summary: `pi.setModel` and `pi.setThinkingLevel` were not called, `ctx.model` is the same object, and the keeper's captured request was not replaced by the cold one.
19. A model with no lifetime whose last answer used the cache: the cached path is tried, not the cold model.

**The words** (`tests/trace.test.ts`):

20. `describeTrace`, `traceDetails` and the comparison line for: a cold summary with prices, on a subscription, without prices; and a fallback with each kind of `skipped`.

**In Pi's session runtime** (the `tests/session-runtime.ts` harness, its in-memory provider, a second in-memory model):

21. `/compact` on a cold session with a cold model set: the session gets a compaction entry written through the second model, marked as an extension's, and the session's model and thinking level are unchanged afterwards.
22. The same with the second model failing: Pi's own compaction writes the entry.

## 8. The steps

Version **0.10.0**. Each step leaves `npm run check` green.

1. **`config.ts`:** the key, its default `""`, its validation, its place in `SESSION_KEYS`. Tests 6.
2. **`cold-compaction.ts`**, a new module without state: the contract below. Tests 1 to 5.
3. **`trace.ts`:** the outcome, the `cold` field, the lines. Tests 20.
4. **`index.ts`, the handler:** `fallBack` hands over to the cold model for every trigger but `expiry`; the call of Pi's `compact()`; the record. Tests 9 to 19.
5. **`index.ts`, what is shown:** the menu row and its list, `/cache-keeper`, the non-TUI listing, the entry renderer, the card's header and colour. Tests 7, 8.
6. **Pi's runtime:** tests 21, 22.
7. **README and CHANGELOG,** part of the release (section 6): the bullet in the opening "What it does:" list with its link, built on that list as updated for 0.8.0 and 0.9.0; the section "Compacting a cold cache with another model" (what it does, when it applies, when it falls back, the privacy note); the Settings table row; the card and `/cache-keeper` lines; the limitations; and the CHANGELOG entry under `## [0.10.0]`. `package.json` to `0.10.0`.

One check belongs to the build: Pi's `compact()` has the signature used here in Pi 1.5.2 and 1.6.0. The package claims Pi from 0.87.0; run the flow tests on the oldest Pi the package is tested with, and raise the peer range if `compact()` there takes no transport.

### The contract of `cold-compaction.ts`

Signatures only; every body is the build's.

```ts
/** `"provider/modelId"`, split at the first slash. Undefined: not a reference (`""` is off, and is not one). */
export function parseModelRef(value: string): { provider: string; id: string } | undefined;
export function formatModelRef(model: { provider: string; id: string }): string;

/** Characters per token the need is counted with: fewer than Pi's 4, so the need is counted high. */
export const COLD_CHARS_PER_TOKEN = 3;

/** The requests Pi's compact() sends for a preparation, each in characters: one, or two for a split turn. */
export function coldRequestChars(
	preparation: Pick<CompactionPreparation, "messagesToSummarize" | "turnPrefixMessages" | "isSplitTurn" | "previousSummary">,
	customInstructions?: string,
): number[];

/** The larger request, in tokens. */
export function coldNeedTokens(requestChars: number[]): number;

/** Why a model can't write a summary this way whatever the session's size, or undefined. */
export function coldUnusable(model: { api: string }): string | undefined;

export type ColdFit = { fits: true; need: number; window: number } | { fits: false; why: string; need: number; window?: number };

/** The fit rule: a known window, and room for the summary beside the need. */
export function coldFit(model: { contextWindow: number; maxTokens: number }, need: number): ColdFit;

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
export function coldChoiceLabel(choice: ColdChoice): string;
export function orderColdChoices(choices: ColdChoice[]): ColdChoice[];
```

`config.ts` gains `coldCompactionModel: string` in `CacheKeeperConfig`, and `"coldCompactionModel"` in `SESSION_KEYS`. `trace.ts` gains `"cold"` in `CompactTrace["outcome"]` and `CompactTrace["cold"]` as in section 5.

## 9. Not in this version, and open questions

**Not in 0.10.0**, each a line in the README's "Limitations":

- `/tree` branch summaries still use the session's model.
- Virtual models and Claude through pi-claude-bridge can't be picked.
- A model that declares no context window can't be used; declare one in `models.json`.
- One attempt: a cold request that fails is not retried, Pi's own compaction follows.
- The cold model sees what Pi's compaction sees, tool results cut to 2,000 characters, not the whole conversation the cached path reads from the cache.
- The footer says nothing about the setting.

**Two questions only the owner can answer.** The design takes the first answer of each; the other is a small change.

1. **Is a warm cache the summary can't be read from "cold"?** The design says yes: the cold model writes every summary Pi's own compaction would have written, also after an overflow, a prefix mismatch or on an unsupported API while the cache is warm, because the cost is the same full price. The narrower reading, "only an expired or never-written cache", leaves those to Pi's compaction on the session's model.
2. **Is a cache of unknown lifetime "cold"?** The design says no: the cached path is tried as today. Saying yes sends every compaction of such a model to the cold model, which is cheaper when the cache was in fact gone and gives up a cached, whole-conversation summary when it was not.
