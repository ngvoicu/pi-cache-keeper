# Compacting a cold cache with a model the user picks

The design of 0.10.0, built (section 10 says where the build and the review changed it). It is written against pi-cache-keeper 0.9.0 (the model data is providers.dev's safe values) and Pi 1.6.0. It says what the software is; the build chooses nothing about that. Where the build finds this document wrong, the document is corrected.

The ask: when a session is compacted and its prompt cache can't be read, the summary request pays the full input price of the session's own model for the whole conversation. On a large session with an expensive model that is dollars per compaction, or subscription quota. The user picks another model (a cheaper one, or one on a login with spare quota) to write that summary. The same picked model also writes it when the session's own model refuses the summary, and when the conversation no longer fits the session's model. The session goes on with its own model.

This is a small first version: one setting, one new module, one branch in the compaction handler.

## 0. The rule

**The cached path writes the summary when it can. When it can't, the picked model writes it, with Pi's own summarizer. When the picked model can't either, Pi's own compaction runs exactly as today.**

That one rule holds the three triggers, with one picked model for all of them:

1. **The cache is cold.**
2. **The session's own model refuses the summary,** for quota or a rate limit.
3. **The conversation to summarize doesn't fit the session's model** (after a switch to a smaller window, say) **and fits the picked one.**

They need no code of their own: each is a case in which the handler already falls back to Pi's own compaction today (section 2). The setting keeps the name of the first and most common of them, the cold compaction model.

Two things never change:

- **A warm cache and a session model that can do it.** The cached path writes the summary from the cache, on the session's model, as in 0.9.0.
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

The description under the row names the three cases in which the model writes the summary (the cache is cold, the session's model refuses it, the conversation doesn't fit the session's model), says that Pi's own compaction follows when it can't, and carries the privacy sentence of section 6.

**The list** holds, in this order:

1. Editing this session only: `default (<the default's value>)`, which drops the session's own value.
2. `off`.
3. The models Pi has credentials for: `ctx.modelRegistry.getAvailable()`, without the ones that can't write a summary this way (section 3, "can't be offered"). The list can be searched by typing, as Pi's own model list can.

**Each model's line** shows three things beside its name:

| Part | From | Reads |
|---|---|---|
| Its window | `model.contextWindow`, which is the keeper's model data where `modelData` is on and Pi's own value otherwise | `1M window`, `200k window`, `window unknown` |
| Its price, or that it is a subscription | a subscription login (`accessVia` of `accessReader`: `"sub"`) reads `subscription`; else the model's prices at the size needed (`priceAt`), where it has any (`hasPrices`); else `no price` | `$0.30 in, $2.50 out per M`, `subscription`, `no price` |
| Whether it can hold this session now | the fit rule of section 3, on the whole context as text (below) | `holds this session`, `too small now (needs about 150k)`, `can't be used: it declares no context window`, `can't be used: output limit too small` |

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

### With every other setting off

**This is the main case, and it needs nothing else switched on.** With compacting when full off (`compactAtPercent: 0`, `compactAtTokens: 0`), compacting before expiry off, keep-warm off and the model data off, Pi's own compactions still pass through the extension's `session_before_compact` handler: a threshold compaction, an overflow recovery and `/compact` that can't be read from the cache are written by the picked model. The handler and the cached path are not settings, and nothing in the rule reads one of the others.

It matters most there, because compacting before expiry is what normally keeps a compaction from meeting a cold cache: with it off, or under `minContextTokens`, a session that was left alone is compacted cold.

Two things follow from those settings being off, and the README says both:

- **With compacting when full off, Pi's threshold compaction rarely fits the cached path, warm or cold.** With Pi's default settings it starts when under `reserveTokens` (16,384) of the window are left, and a cached summary needs 16k of room beside the whole conversation. So the handler falls back with "only … tokens of the context window are left for the summary", and that is trigger 3: the picked model writes those summaries too, in the middle of a run with a warm cache.
- **With the model data off, fewer models have a known cache lifetime,** so more of them fall under "An unknown lifetime" below (section 9, question 2).

## 2. When it applies

### The compactions

| What started the compaction | Picked model |
|---|---|
| `/compact` (`manual`) | yes |
| Pi's threshold compaction (`threshold`) | yes |
| Pi's overflow recovery (`overflow`) | yes; the retry of the turn follows as today |
| Compacting when full (`full`) | yes |
| Compacting before expiry (`expiry`) | never |

### The three triggers, at one point in the code

Nothing new is measured and no error is interpreted. **The picked model is asked exactly where the handler falls back to Pi's own compaction today**: the single point `fallBack` in `session_before_compact`, for every kind of compaction but `expiry` (the table above). Each of the three triggers is a set of the reasons the handler already words:

| Trigger | The handler's reasons that are this trigger | What it means |
|---|---|---|
| **1. The cache is cold** | no request since the session started or compacted, or since the model or branch changed · the model changed since the last request · the last request did not use the prompt cache · the prompt cache has expired | nothing of the summary request would be read from a cache |
| **2. The session's model refuses the summary** | the summary request failed: `<the provider's error>` (thrown, or an error answer) | the cached path asked the session's model and got no summary back |
| **3. The conversation doesn't fit the session's model** | the last request overflowed the context window · only `<n>` tokens of the context window are left for the summary (it needs 16k) · and, after a switch to a smaller model, the reasons of trigger 1, since the new model has no request and no cache yet | the conversation and its summary don't fit the session model's window; the picked model's own window decides whether it can (the fit rule of section 3) |

**Trigger 1.** The expiry is read where it always is: `look()`, the one reading of the cache (`cache-clock.ts`), through `checkCachedPath`. No second clock.

**Trigger 2.** The only summary request the extension sends to the session's model is the cached path's, so that is where a refusal shows. The error is not read for what kind it is: a used-up quota, a rate limit, an overloaded provider and a dropped connection all hand the summary to the picked model, and no list of providers' error messages is kept. The card shows the provider's own words. On a cold cache the session's model is not asked at all. When the picked model can't either, Pi's own compaction asks the session's model and fails as it would have.

**Trigger 3.** A model switch forgets the captured request, so the cached path has none; where the model was not switched and the context outgrew it, the reason is the overflow or the missing room. This is the one trigger where the picked model does more than save money: Pi's own compaction, on a model the text doesn't fit, has no request it can send whole, and when it fails the session stays too large to continue.

**The rest of the fallbacks go the same way.** The handler also falls back, on a warm cache, where the session's model could still write the summary through Pi's own compaction at full price: the request's API is not supported · the conversation changed since the last request · the request no longer repeats the last one (prefix mismatch) · no kept message has text to mark where the summary ends · the cached summary hit the output limit, was a tool call, or was empty. These are in, because one rule is simpler than a list of exceptions and the cost is the same: nothing is read from the cache either way. Taking them out later is a mark on those reasons and nothing else. (Section 9, question 1.)

### An unknown lifetime

An unknown lifetime or expiry is **never a reason to use the picked model**, and with the setting off nothing changes from 0.9.0. A model with no cache lifetime at all (no countdown in the footer): there `look()` gives neither an expiry nor a reason, the cached path is tried as today, and what the request read shows on the card; the picked model writes the summary only if that path falls back for one of the reasons above. A keep-warm period whose expiry became unknown (the route changed, or no lifetime can be read any more): `checkCachedPath` gives `the prompt cache's expiry is unknown: …` as in 0.9.0, and Pi's own compaction runs on the session's model, as in 0.9.0, whatever the setting; that reason is not part of trigger 1. (Decided after the review, round 2: section 10.)

Why: nothing the extension knows says such a cache is gone, and while it may be alive the rule "a warm cache changes nothing" holds. The price of this choice is the case where it was in fact gone: the cached request then pays the session model's full price, as in 0.9.0. With the model data off this covers more models: every one whose lifetime neither Pi's catalog nor its own answers give. (The second question for the owner in section 9.)

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
2. **Counted by words.** Each request's text is split on whitespace: a word that is ASCII and at most 20 characters long (`COLD_SHORT_WORD`) counts its length / 3 tokens (at least 1); any other word (non-ASCII, or longer: base64, hashes, minified code, CJK) counts one token per UTF-8 byte, since a token of a byte-level tokenizer covers at least one byte. Pi's prompt is counted as `COLD_PROMPT_TOKENS = 700` (1,642 characters of English at most in Pi 0.87.0 and 1.6.0). Measured against o200k_base and cl100k_base (gpt-tokenizer 3.4.0): prose 1.27-1.35 times its real size, code 1.56, base64 1.39-1.47, rare CJK 1.29-1.58. The need is the larger request.
3. **Room for the summary.** `summaryBudget(model, need)`, the existing function: the model's output limit, reduced so the prompt, a 4k margin and the summary fit the window, less the thinking a model that can't turn it off adds at its lowest level (Pi's default thinking budgets: minimal 1,024, low 2,048). The model fits when that is at least `MIN_SUMMARY_TOKENS` (16k), or at least its whole output limit where the limit is smaller. That room is the output cap passed with every request (`maxTokens`), so Pi can't ask for more than the fit assumed.

Because tool results are cut down, a session larger than a model's window can still fit it; counting high can refuse a model near the limit that would have fit.

An unknown window is refused, not tried: a local server that silently truncates would return a summary of the last part only, with no error to fall back on.

Counting high can refuse a model that would have fit; counting low sends a request that overflows and fails. Both end in Pi's own compaction, and the second costs a failed request, so the rule leans to the first.

### Can't, after the request was sent

| Case | Reason on the record |
|---|---|
| A reply ends in an error: a provider error, a rejected login, an overflow after all, a dropped stream. One attempt, no retry | `its request failed: <the error>` |
| A reply ends aborted while the user did not abort (a gateway cancelled it), whatever text came first | `its request ended early (aborted): <the error>` |
| A reply hit the output limit | `the summary hit the output limit` |
| The model called a tool | `the model called a tool instead of writing the summary` |
| A reply, or the whole summary, holds no text once the file lists are taken out | `it returned no summary text` |

Each reply is checked as it ends, in the transport given to `compact()`, before Pi's summarizer sees it: any reply that doesn't end in a normal stop is a failure, and a failure stops the cold path before any further request (a split turn's prefix is not sent after a failed or empty history summary). The record's `requests` counts the requests really sent.

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
| Output limit | the fit rule's room (section 3), passed as `maxTokens` with every request; Pi lowers it further to fit the window where its own estimate says so |
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
| `requests` | the requests really sent: 1, or 2 for a split turn |
| `maxTokens` | the output cap sent |
| `response` | `{ seconds, usage, summaryChars }`, when it wrote the summary |
| `skipped` | the reason of section 3, when it did not write the summary |

### The card and the `/cache-keeper` log line

`describeTrace` words the record. The lines read:

```text
13:48:54 /compact: summary by google/gemini-2.5-flash, the prompt cache has expired: 148k in, 3k out, $0.052, 12.3s, summary 5120 chars
13:48:54   saved, 412k tokens summarized
```

```text
13:48:54 /compact: Pi's compaction, the prompt cache has expired; google/gemini-2.5-flash did not write the summary: it needs about 260k tokens and its window is 200k
13:48:59   Pi's compaction saved: 0% of 231k from cache, 2k out, $1.2, summary 4870 chars
```

- **The model and its cost** are on the first line, as the requests recorded them: a recorded cost reads as that cost; no cost through a subscription login reads `on a subscription`; else `no price`.
- **No comparison line.** The card shows the picked model's own cost only (decided after the review: a same-request price at the session's model can't be told right across tiers and routes).
- **The card's header** is `cold compaction` when the cold model wrote the summary, and the line is not painted as a warning: nothing went wrong. A fallback after a cold model that could not write it keeps today's warning colour.
- **Expanded** (`traceDetails`), one more line: `cold model: google/gemini-2.5-flash (API key), thinking off, about 148k tokens of a 1M window, 1 request`.

### `/cache-keeper`

- A new line after `when full:`. With a model: `cold compaction: google/gemini-2.5-flash (this session) · 1M window · $0.30 in, $2.50 out per M · whether it writes a summary is decided at each compaction, from the part Pi cuts off`: the setting, the model, its window and its price or `subscription`, and no prediction. Off: `cold compaction: off: when the cache can't be read, Pi's compaction writes the summary on this session's model`. A pick Pi can't use now: `<ref> · not available now: <why>`.
- The existing `next compaction:` line, where it says "Pi's compaction, because …" today, reads with a model set: `not from the cache, because <reason>; the cold compaction model writes the summary where it can, else Pi's compaction`. It names no model: that is decided at the compaction, from the part Pi cuts off then.
- The `settings:` line lists it with the session's other own values.

The footer does not change in this version.

## 6. The README, with its privacy note

The README is part of 0.10.0: the release is not done without it. It gets five things, and the CHANGELOG its entry.

**1. A bullet in the opening "What it does:" list**, after "Compacts just before the cache expires", with its link:

> - **Compacts a cold cache with a model you pick.** When the cache can't be read, the summary would cost your session model's full input price; a cheaper model, or one on a login with spare quota, writes it instead. The same model steps in when your session's model refuses the summary or the conversation no longer fits it, and the session goes on with its own model (off until you pick one). [More](#compacting-a-cold-cache-with-another-model).

That list is being brought up to date for 0.8.0 and 0.9.0 by other work. The bullet is added to the list as that work leaves it, in its wording and order, not to the list as it stands in 0.9.0.

**2. Its own section, "Compacting a cold cache with another model"**, after "Compacting from the cache". Four parts, in this order:

- **What it does:** the rule of section 0 with its three triggers, that it needs no other setting of the extension switched on (section 1, "With every other setting off": Pi's own threshold, overflow and `/compact` compactions use the picked model, and what follows with compacting when full off), and what the summary is (section 4): Pi's own summary, written by the picked model, with no thinking or its lowest level; the session's model and thinking level untouched. One comparison with the cached path: the cold model sees what Pi's compaction sees, tool results cut to 2,000 characters, not the whole conversation.
- **When it applies:** one line for each trigger, as worded below, then the table of compactions of section 2, the rest of the fallbacks, and the unknown lifetime.

> - **The cache is cold.** It has expired, was never written, or belongs to the model you switched away from. The picked model writes the summary, at its own price instead of your session model's full input price.
> - **Your session's model refuses the summary.** Its quota is used up, it is rate-limited, or the request for the summary fails for another reason. The picked model writes it instead, so the session is compacted all the same.
> - **The conversation no longer fits your session's model.** You switched to a model with a smaller window, or the context outgrew the window. If the picked model's window holds the text, it writes the summary.
>
> While the cache is warm and your session's model can write the summary from it, nothing changes. And whenever the picked model can't write it, Pi's own compaction runs as before.
- **When it falls back:** the cases of section 3, each ending in Pi's own compaction, the abort, and that nothing is lost.
- **The privacy note,** as worded here:

> **Where your conversation goes.** With a cold compaction model set, the part of the conversation being summarized is sent to that model's provider, as Pi's own summarizer writes it out: your messages in full, with the full output of shell commands you ran with `!` (they are your messages, not tool results); the assistant's answers and its tool calls with their arguments; the first 2,000 characters of each tool result; the previous summary; any `/compact` instructions; and, on Pi before 1.2, the assistant's thinking. That is the same text Pi's own compaction sends, but to another provider than the one your session talks to, under that provider's terms and with the credentials Pi holds for it. It is off by default, nothing is sent this way until you pick a model, and you can turn it off for one session only. The summary is then as good as the model you picked.

The menu row's description carries the note's first sentence.

**3. The row in the Settings table:**

| Setting | Menu | Default | Per session | What it does |
|---|---|---|---|---|
| `coldCompactionModel` | Compact a cold cache with | `""` | yes | this model (`"provider/modelId"`) writes the summary when the cache is cold, when the session's model refuses it, or when the conversation doesn't fit the session's model, also with every other setting here off; `""` turns it off |

The paragraph above the table that names the session's own values gains `coldCompactionModel`.

**4. What is shown:** the card's new lines in "The compaction card and the log" (section 5), and the `cold compaction:` line under `/cache-keeper` in "Commands".

**5. "Limitations":** the items of section 9.

**The CHANGELOG entry**, under `## [0.10.0]`, `### Added`: one item, "A cold compaction model", saying the rule and its three triggers, the setting and its two layers, when it falls back, where the conversation goes, and that going back to 0.9.0 needs the key removed from `settings.json` (section 1).

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
11. **Trigger 1, the cache is cold:** an expired cache, a session with no request yet, and a model changed since the last request, for each of `manual`, `threshold`, `overflow` and `full`: the handler returns a compaction whose summary is the fake model's text, whose `firstKeptEntryId` and `tokensBefore` are the preparation's, whose `usage` is the fake's, and whose file lists include the previous compaction's.
12. The request it sent: to the picked model; Pi's summarizer system prompt; the conversation inside `<conversation>`; no `maxTokens` above the model's limit; no reasoning for a model that can turn it off, its lowest level for one that can't; no cache retention.
13. A previous summary is sent as `<previous-summary>`; a split turn sends two requests and sums their usage; `/compact` instructions are in the prompt.
14. `expiry`: a cache that went cold at the gate cancels, and the cold model gets no request.
15. Each "can't" of section 3 that is decided before sending: nothing is returned, no request is sent, and the record's `cold.skipped` is the reason.
16. Each failure after sending: a thrown error, an error answer, the output limit, a tool call, an empty text. Nothing is returned, one request was sent, the reason is recorded.
17. Abort before the request: none is sent, the result is a cancel. Abort during it: a cancel. In both, no compaction is returned.
18. After a cold summary: `pi.setModel` and `pi.setThinkingLevel` were not called, `ctx.model` is the same object, and the keeper's captured request was not replaced by the cold one.
19. A model with no lifetime whose last answer used the cache: the cached path is tried, not the cold model.
20. Every other setting off (`compactAtPercent: 0`, `compactAtTokens: 0`, `compactBeforeExpiry: false`, `keepWarmMinutes: 0`, `modelData: false`): `manual`, `threshold` and `overflow` on a cold cache are written by the cold model.
21. **Trigger 2, the session's model refuses the summary,** on a warm cache: (a) the cached path's request throws a rate-limit error; (b) it comes back as an error answer saying the quota is used up. In both the cold model writes the summary and the record's `reason` holds the provider's words. (c) The same with a cold model that can't take it: nothing is returned, so Pi's own compaction runs.
22. **Trigger 3, the conversation doesn't fit the session's model:** (a) after a switch to a session model with a smaller window than the text to summarize; (b) the last request overflowed; (c) under 16k tokens of the window are left for a cached summary, on a warm cache. In each the cold model, whose window holds the text, writes the summary. (d) The same with a cold model whose window doesn't hold it either: nothing is returned, no request is sent, and the record says what it needs and what its window is.

**The words** (`tests/trace.test.ts`):

23. `describeTrace` and `traceDetails` (and no comparison line) for: a cold summary with a recorded cost, on a subscription, without prices; and a fallback with each kind of `skipped`.

**In Pi's session runtime** (the `tests/session-runtime.ts` harness, its in-memory provider, a second in-memory model):

24. `/compact` on a cold session with a cold model set, every other setting off: the session gets a compaction entry written through the second model, marked as an extension's, and the session's model and thinking level are unchanged afterwards.
25. The same with the second model failing: Pi's own compaction writes the entry.

## 8. The steps

Version **0.10.0**. Each step leaves `npm run check` green.

1. **`config.ts`:** the key, its default `""`, its validation, its place in `SESSION_KEYS`. Tests 6.
2. **`cold-compaction.ts`**, a new module without state: the contract below. Tests 1 to 5.
3. **`trace.ts`:** the outcome, the `cold` field, the lines. Tests 23.
4. **`index.ts`, the handler:** `fallBack` hands over to the cold model for every trigger but `expiry`; the call of Pi's `compact()`; the record. Tests 9 to 22.
5. **`index.ts`, what is shown:** the menu row and its list, `/cache-keeper`, the non-TUI listing, the entry renderer, the card's header and colour. Tests 7, 8.
6. **Pi's runtime:** tests 24, 25.
7. **README and CHANGELOG,** part of the release (section 6): the bullet in the opening "What it does:" list with its link, built on that list as updated for 0.8.0 and 0.9.0; the section "Compacting a cold cache with another model" (what it does, when it applies, when it falls back, the privacy note); the Settings table row; the card and `/cache-keeper` lines; the limitations; and the CHANGELOG entry under `## [0.10.0]`. `package.json` to `0.10.0`.

One check belongs to the build: Pi's `compact()` has the signature used here in Pi 1.5.2 and 1.6.0. The package claims Pi from 0.87.0; run the flow tests on the oldest Pi the package is tested with, and raise the peer range if `compact()` there takes no transport.

### The contract of `cold-compaction.ts`

Signatures only; every body is the build's.

```ts
/** `"provider/modelId"`, split at the first slash. Undefined: not a reference (`""` is off, and is not one). */
export function parseModelRef(value: string): { provider: string; id: string } | undefined;
export function formatModelRef(model: { provider: string; id: string }): string;

/** The longest ASCII word counted at a third of its length; longer or non-ASCII words count a token a UTF-8 byte. */
export const COLD_SHORT_WORD = 20;
export function coldTextTokens(text: string): number;

/** The requests Pi's compact() sends for a preparation, each in tokens as counted above: one, or two for a split turn. */
export function coldRequestTokens(
	preparation: Pick<CompactionPreparation, "messagesToSummarize" | "turnPrefixMessages" | "isSplitTurn" | "previousSummary">,
	customInstructions?: string,
): number[];

/** The larger request, in tokens. */
export function coldNeedTokens(requestTokens: number[]): number;

/** Why a model can't write a summary this way whatever the session's size, or undefined. */
export function coldUnusable(model: { api: string }): string | undefined;

export type ColdFit = { fits: true; need: number; window: number; maxTokens: number } | { fits: false; why: string; need: number; window?: number; never?: true };

/** The fit rule: a known window, and room for the summary beside the need. */
/** `reserve`: the output thinking adds at the model's lowest level. `maxTokens` of a fit is the cap sent. */
export function coldFit(model: { contextWindow: number; maxTokens: number }, need: number, reserve?: number): ColdFit;
/** The one fit the list and the compaction use (section 10, round 2): the lowest thinking level, and coldFit with its reserve. */
export function coldModelFit(model: Model<Api>, need: number): { fit: ColdFit; thinking: ThinkingLevel };

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
- A refusal is not told from any other failed summary request: the card shows the provider's words, not "quota".
- No hint to pick a cold compaction model when Pi's own compaction fails for size and none is set.

**Two questions only the owner can answer.** The three triggers are decided. The design takes the first answer of each question below; the other is a small change.

1. **Does the picked model also take the rest of the fallbacks?** Beyond the three triggers, the handler falls back on a warm cache where the session's model could still write the summary at full price through Pi's own compaction: a prefix mismatch, an unsupported API, a conversation that changed, a cached summary that came back cut, as a tool call or empty. The design says yes, as one rule: the picked model writes every summary the cached path doesn't. Saying no leaves those to Pi's compaction on the session's model, and is a mark on those reasons.
2. **Is a cache of unknown lifetime "cold"?** The design says no: the cached path is tried as today. Saying yes sends every compaction of such a model to the cold model, which is cheaper when the cache was in fact gone and gives up a cached, whole-conversation summary when it was not. With the model data off, more models are of this kind.

## 10. What the build changed, and the decisions after the review

The owner's answers to section 9: **1. yes**, the picked model takes every fallback, one rule; **2. no**, a cache of unknown lifetime is not cold. And an aborted compaction is cancelled, as section 3 says.

### Where the build departed from this document

- **Pi 0.87.0's summarizer** words the split turn's prefix request otherwise and leaves the `/compact` instructions out of it. The extension follows Pi's summarizer, so it does the same there; the need still counts the instructions for both requests (high). Its `compact()` has the signature used here and takes the transport, so the peer range stays at 0.87.0.
- **`CompactionPreparation`** is not exported by name from `@earendil-works/pi-coding-agent`: the module uses `SessionBeforeCompactEvent["preparation"]`.
- **An empty summary** can't be seen in what `compact()` returns (Pi appends the file lists), so each reply is checked in the transport, and the whole summary again once the file lists are taken out (`summaryBody`).
- **One structural test** (`one-clock.test.ts`) asserted two places in `index.ts` that send a paid request; the cold summary is a third, inside `coldSummary`.
- **Small additions:** `coldModelParts`, `coldChoiceParts` and `fitColdLine` in the module; `formatWindow` in `trace.ts`; models whose window is unknown or that can't be used are listed after the ones too small; the listing outside the TUI shows off as `""`.

### Decided after the review (round 1)

1. **A reply that doesn't end in a normal stop is a failure**, whether it ends `error`, `aborted` (a provider or gateway cancelled it while the compaction's own signal was live) or at the output limit, whatever text came before. A failure stops the cold path before any further request, and Pi's own compaction runs (a cancel for a real local abort). Section 3.
2. **Emptiness is checked after the file lists are taken out**: a reply holding only `<read-files>`/`<modified-files>` is no summary.
3. **The privacy note says what Pi's summarizer sends**: user messages in full, so the full output of shell commands run with `!`; tool calls with their arguments; and, on Pi before 1.2 (checked: 1.1.0 sends them, 1.2.0 doesn't), the assistant's thinking. Section 6, and the picker row's description.
4. **Oversized requests.** (a) The output cap the fit computed is passed as `maxTokens` with every request, less the thinking a model that can't turn it off adds. (b) The need is counted by words (round 2, replacing round 1's one token per byte, which counted English 4-5 times its size so that a big cold session would almost never fit): an ASCII word of up to 20 characters at a third of its length, at least one; any other word at a token a UTF-8 byte. The reviewer's base64 attachment (221,872 characters, 151,599 tokens in o200k_base) is refused by a 128k window; 20,000 rare CJK characters (46,512 tokens in cl100k_base) are counted at 60,000; a paragraph of English prose of 122 tokens (o200k_base) at 155. A request the provider still rejects ends in the fallback.
5. **An unknown lifetime or expiry is never a reason to use the picked model** (round 2, replacing round 1, which tried the cached path where a keep-warm period's expiry became unknown and so changed 0.9.0). With the setting off, everything there is as in 0.9.0; with it on, where the only reason the cached path is not taken is an unknown expiry, Pi's own compaction runs on the session's model, as in 0.9.0. A model with no lifetime at all still has its cached path tried, as in 0.9.0. Section 2.
6. **A split turn whose history summary is empty** sends no prefix (as 2). The record's `requests` counts the requests really sent: one after an Esc during the first.
7. **`/cache-keeper` makes no prediction** of which model would compact: it shows the setting, the model, its window and its price or `subscription`, and says the choice is made at each compaction, from where Pi cuts. Section 5.
8. **No comparison with the session's model** on the card: the picked model's own cost only. `sessionModelCost` is gone from the record.
9. **The cost label is what the request recorded**: a recorded cost is shown as that cost (also through a route announced as a subscription); no cost on a subscription login reads `on a subscription`.
10. **The picker in a narrow terminal** keeps the end of a model id that doesn't fit (`fitColdLine`), so two models of one provider stay distinct; tested at 40 and 60 columns. Replaced in round 2 (below, 3).

### Decided after the review (round 2)

1. **One fit for the list and the compaction.** `coldModelFit(model, need)` is the only fit: it picks the thinking level the request is sent at (the model's lowest, `clampThinkingLevel(model, "off")`) and calls `coldFit` with what that level adds kept out of the cap. The list (`coldChoiceOf`) and the compaction (`coldSummary`) both call it, so they can't disagree. A model whose output limit, less that thinking, can never reach the summary's minimum (16k, or its whole limit where smaller) fails with `never` whatever the session's size, and the list shows it among the models that can't be used: `can't be used: output limit too small` (`OUTPUT_TOO_SMALL`). Cloudflare's `@cf/openai/gpt-oss-120b` is such a model: its limit is 16,384, and its lowest thinking level is low (2,048). `/cache-keeper` says the same of such a pick. The session's own model, which the compaction refuses, reads `can't be used: it is the session's own model` in the list. Tested in Pi's session runtime: the list's line and the compaction's decision agree for every model of Pi 1.6.0's and Pi 0.87.0's built-in catalogs (fixtures of them in `tests/fixtures`), for a small session and one of about 150k tokens.
2. **The output cap is passed to Pi, not promised on the wire.** Pi's adapter sends `maxTokens` to the provider, except some adapters of older Pi versions, which leave it out (on Pi 0.87.0, `openai-codex-responses`). A request the provider then rejects falls back as any failed reply does. The README says so; nothing else changes.
3. **The picker's rows at 40 and 60 columns.** A model id that doesn't fit is shortened in the middle (`shortenModelRef`): the provider, the start of the id, an ellipsis, the end of the id. The cut starts with a third of the id's room kept at its start, and moves either way until no other reference in the list matches that start and that end. Where no single cut tells two references apart (Pi 1.6.0's `qwen-token-plan-individual-cn/qwen3.6-flash` and `qwen3.8-flash`, and Vercel's three `gemini-*-flash-lite-batch`, at 40 columns), the rows that would read the same show the whole id over two lines or more, then the rest of the line (`coldRowLines`). The rule covers the whole list, so a row never reads like another, visible or not. The list is drawn by the extension (`coldModelList`, with Pi's select-list theme and keys), since Pi's select list draws one line per row. Tested in Pi's session runtime: at 40 and 60 columns, every model of Pi 1.6.0's and Pi 0.87.0's catalogs has a row that reads differently from every other, among them the stock Bedrock `eu.` and `us.` Claude Haiku 4.5.
4. **The request count** counts only requests really dispatched: a request counts once its body is built (every adapter of Pi's passes it to `onPayload` just before sending), or once a reply comes that a provider wrote (a normal end, or tokens counted). A credential failure at request time is an error reply with no tokens and no body (as Pi 0.87.0's and 1.6.0's registries return it), and counts no request.
5. **The price comparison in the README** is for cached compactions only: a summary by the cold compaction model shows that model's own recorded cost, with no comparison.
6. **The expanded card's route** follows the cost line's rule: a recorded cost reads `(API key)`, also on a route announced as a subscription; no cost on a subscription reads `(subscription)`.

