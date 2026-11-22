# pi-cache-keeper

A Pi extension that makes the prompt cache pay off. It compacts a session by reading the prompt cache the session already built, so on big sessions the summary costs a fraction of Pi's compaction and is written from the full tool output instead of 2,000-character excerpts. It compacts when the context gets full and just before the cache expires, it can keep the cache warm through a break, and it fills in what Pi doesn't know about a model (how much input it takes, how long its cache lasts, what it costs) from [providers.dev](https://providers.dev). The footer shows how long the cache stays warm, the cache lifetimes and the price in use, what the last request asked the cache for, and what went wrong.

![Pi after a compaction with pi-cache-keeper. The card reads "cached compaction (ctrl+o for details). 15:05:52 compact when full: cached, 99% of 904k from cache, 5k out, 41.6s, summary 9840 chars. vs Pi's compaction: 75% less, $0.59 instead of ~$2.4 (it sends ~451k tokens, none from cache). 15:06:34 saved, 903k tokens summarized." Below the editor, Pi's footer reads "~/project (main)", then the token totals and "claude-opus-5-5 • high", and on its last line "cache warm · 59m left · long 1h (in use) · short 5m · sent 1h · sub, counted at $4/$20 per M".](media/overview.png)

What it does:

- **Compacts from the warm cache.** The summary request repeats your conversation as it is and reads about 99% of it from the cache, and the summary sees all the tool output. [Compacting from the cache](#compacting-from-the-cache), [what it costs](#what-it-costs).
- **Compacts when the context is full,** at 90% of the model's window by default or at a token cap you set, while a summary still fits. [More](#compacting-when-the-context-is-full).
- **Compacts just before the cache expires** when you step away, so your next message doesn't pay to write the whole session again. [More](#compacting-before-the-cache-expires).
- **Compacts a cold cache with a model you pick.** When the cache can't be read, the summary would cost your session model's full input price; a cheaper model, or one on a login with spare quota, writes it instead. The same model steps in when your session's model refuses the summary or the conversation no longer fits it, and the session goes on with its own model (off until you pick one). [More](#compacting-a-cold-cache-with-another-model).
- **Keeps the cache warm through a break,** for up to as long as you choose, and stops once refreshing has cost as much as one cache miss (off until you set it). [More](#keeping-the-cache-warm).
- **Lets each session set its own compaction and keep-warm values** over the defaults, with `/cache-keeper-settings`. [More](#settings).
- **Fills in model data from providers.dev:** one safe value per quantity (input window, output limit, cache lifetimes and prices), measured values first; values marked as Pi's own aren't written back. [More](#model-data-from-providersdev).
- **Shows it in the footer:** the cache countdown, the cache lifetimes and the one in use, what the last request asked for, the price, and what went wrong, right after the countdown, fitted to the terminal's width. [The footer](#the-footer).

See the [CHANGELOG](CHANGELOG.md) for what changed in each version.

pi-cache-keeper is based on pi-cached-compaction by Nico Bailon (MIT). Compaction from the warm cache, the compaction card, the countdown, compacting before expiry and the longer cache are his work; see [Origins and credit](#origins-and-credit).

## Install

```bash
pi install git:github.com/ngvoicu/pi-cache-keeper
```

Then run `/reload` (Pi loads extensions only at startup or on `/reload`). It needs Pi 0.87.0 or newer. Compacting from the cache, compacting when full, compacting before expiry and [model data from providers.dev](#model-data-from-providersdev) are on by default; keeping the cache warm is off until you set `keepWarmMinutes`.

### Moving from pi-cached-compaction

- Remove pi-cached-compaction first: `pi list` shows the address you installed it from, and `pi remove <that address>` removes it. With both loaded, both would compact and both would show a countdown.
- Your settings carry over: while `~/.pi/agent/settings.json` has no `cacheKeeper` key, pi-cache-keeper reads the old `cachedCompaction` key as it is. The settings menu saves the defaults to `cacheKeeper` (starting from what it read) and leaves `cachedCompaction` alone; from then on `cacheKeeper` is the one that counts.
- The commands are `/cache-keeper` and `/cache-keeper-settings` instead of `/cached-compaction` and `/cached-compaction-settings`.
- The log is `~/.pi/agent/cache-keeper.jsonl`; the old `cached-compaction.jsonl` is left where it is and not read. Cards from earlier compactions still show in old sessions.

## The footer

The extension adds one line to Pi's footer (in powerline-footer, the `extension_statuses` segment): the cache countdown, then what went wrong, then the values in use for the current model. powerline-footer drops that segment as a whole when it doesn't fit, also with no other status beside it (in its 0.22.0, at 40, 60 and 80 columns it was hidden, at 148 shown in full); `/cache-keeper` shows everything.

```
cache warm · 59m left · long 1h (in use) · short 5m · sent 1h · api $3/$15 per M
```

![The last line of Pi's footer in fourteen states at 140 columns, and four of them at 60 and 40 columns. Warm: "cache warm · 59m left · long 1h (in use) · short 5m · sent 1h · api $3/$15 per M". The last 30 seconds, the countdown in the warning color: "cache warm · 0:25 left · …". Expired, dimmed: "cache cold · next message full price · …". While a request runs: "cache in use · …". A subscription login: "… sent 1h · sub, counted at $3/$15 per M". The request asked for the short tier while the retention says long: "cache warm · 4m left · short 5m (in use) · long 1h · sent short (retention long) · api $3/$15 per M". Keep-warm on and keeping the cache warm, muted: "cache warm · 41m left · keep-warm 2h until 16:40, $0.36 spent of $2.07 · long 1h (in use) · …". Keep-warm ended, muted: "cache warm · 0:24 left · keep-warm ended (budget reached): $1.98 spent, a miss costs $2.07 · long 1h · short 5m · sent 1h · api $3/$15". Two refreshes in a row without a hit, after the cache went cold, in the warning color: "cold: full price · ⚠ keep-warm: Pi's after 2 refreshes without a hit (/cache-keeper-warm) · long 1h · …". GPT on OpenAI with the longer cache: "cache warm · 11h 40m left · keep-warm: Pi's (several cache lifetimes) · long 12h (in use) · short 30m · ⚠ sent 30m + 12h · api $2/$10 per M". Through a proxy, an API key answered: "cache warm · 59m left · ⚠ answered by an API key · long 1h (in use) · …". Through a proxy that may use either: "cache warm · 55m left · long 1h (in use) · short 5m ⚠ · sent 1h · sub or api $3/$15 per M · ⚠ login or API key unknown: shorter values". providers.dev unreachable: "cache warm · 58m left · ⚠ providers.dev: no data, fetch failed · long 1h (in use) · …". No lifetime known: "cache lifetime unknown · sent default cache (retention long) · api $1.25/$10 per M above 200k · providers.dev: no data for this model". At 60 columns: "warm 59m · long 1h · short 5m · sent 1h · api $3/$15", "warm 0:25 · ⚠ keep-warm failed · long 1h · api $3/$15", "cold · ⚠ keep-warm: Pi's · long 1h · short 5m · api $3/$15", "warm 11h 40m · keep-warm: Pi's · long 12h · ⚠ sent 30m+12h". At 40 columns: "warm 59m · long 1h · api $3/$15", "warm 0:25 · ⚠ keep-warm failed · long 1h", "cold · ⚠ keep-warm: Pi's · long 1h", "warm 11h 40m · long 12h · ⚠ sent 30m+12h".](media/footer-states.png)

**The countdown** shows how long the cache has left. Sending a message restarts it. It reads `cache warm · 59m left` down to `cache warm · 0:25 left` (minutes, then minutes and seconds for the last two, hours and minutes past two hours; in the warning color for the last 30 seconds), then `cache cold · next message full price`. A message sent while the cache is warm reads the conversation from the cache at a fraction of the price and restarts the countdown; after it goes cold, the next message pays full price to write the conversation again. While a request runs it reads `cache in use`, so the line keeps its place in the footer, and while [keeping the cache warm](#keeping-the-cache-warm) refreshes it, `cache warm · refreshing`.

The lifetime is the model's declared one (which [providers.dev](#model-data-from-providersdev) fills in for many models), else the cache tier the provider reports writing (Anthropic and pi-claude-bridge report it), else OpenAI's 30-minute minimum for GPT-5.6 and later, else Kimi K3's 5-minute or 1-hour option. Models with none of those show no countdown, and the footer says `cache lifetime unknown`. `/cache-keeper` says which one it is.

**The values** follow. Each is one the extension has: Pi's model as it is now (its catalog, your `models.json`, the values [providers.dev](#model-data-from-providersdev) wrote there), the lifetime the countdown runs on, and the last request as this extension saw it. What isn't known reads `unknown`.

| Part | Meaning |
|---|---|
| `long 1h (in use)` | the model's own cache tier in use and its lifetime, once the model has made a request in this session. It is the tier the last request asked for, where this route's lifetime for that tier is the one the countdown runs on: a route can write its short tier as a one-hour cache, so the write the answer reports (5 minutes or 1 hour, which is the tier's name only on Anthropic's own API) does not name the tier. Where the lifetime in use is not the asked tier's (a stated hour the provider wrote as 5 minutes), it is the tier of the lifetime in use, and `⚠ sent` says the difference. Without a request the extension read (after `/reload`, `/resume`, `/fork`, a compaction or `/tree`): the tier whose lifetime on this route is the one in use, and where both tiers have that lifetime, the retention in force (`cacheRetention`). For an idle period the extension [keeps warm](#keeping-the-cache-warm), the period's request and lifetime. The lifetime is the model's own for that tier, else the one the countdown falls back on (above). Before the model's first request (after `/model`, say) both tiers show, short then long, with nothing in use; so does Claude through pi-claude-bridge, where Claude Code picks |
| `short 5m` | the other tier's lifetime, as the model declares it, or `unknown` |
| `cache lifetime unknown` | neither is known: no countdown, no compacting before expiry, no keeping warm |
| `5m ⚠` (warning color) | a guess: the smaller of values that differ, because it isn't known whether a login or an API key serves the model ([through a proxy](#through-a-proxy)) |
| `?` (warning color) | found for some of the possible credentials but not all, so not used |
| `sent 1h` (dim) | what the last request's cache markers asked for ([read as for keeping warm](#keeping-the-cache-warm)): the lifetime a marker states (`ttl`), else the tier it asks for (`short`, `long`), several joined with `+`, and `default cache` when the request carries no marker. A marker that states no lifetime, such as Anthropic's `cache_control` without `ttl`, reads `sent short`: what that tier lasts on this route is the lifetime shown for it. Only for a request whose markers the extension reads (Anthropic Messages, OpenAI Chat Completions and Responses); Bedrock's, Gemini's and other forms show nothing about what was sent |
| `sent short (retention long)` (muted) | the request asked for another tier than the retention in force (`cacheRetention`, or a `PI_CACHE_RETENTION` you set): the provider, or Pi's adapter for it, doesn't take the longer cache there |
| `⚠ sent 30m + 12h` (warning color) | the lifetime the request asked for is not the one in use: the lifetime it states, or, for a request that states none, this route's lifetime for the tier it asks. Or it asked for more than one. Either way the countdown may not follow the cache the request wrote. The same lifetime under another tier's name is no warning: through a proxy on a subscription login, where the short tier lasts an hour and the answer reports the one-hour write, the line reads `short 1h (in use) · long 1h · sent short`. `⚠ sent a cache marker it can't read`: a marker the extension doesn't read |
| `api $3/$15 per M` | how the model is reached (`api`, `sub`, or `sub or api` through a proxy that may use either; [through a proxy](#through-a-proxy), what answered last) and the price in use: input and output per million tokens, at the current context size where the price has tiers (`above 200k`) |
| `sub, counted at $4/$20 per M` (muted) | a subscription login: billed by the subscription, not per token. The prices are the model's (Pi's catalog, providers.dev or your own) and are the ones the extension counts with: the keep-warm budget and the compaction card's comparison, as Pi counts a cost at them, marked `(sub)`. Narrower: `sub, counted $4/$20`, then `sub` |
| `sub, no per-token price` (muted) | a subscription login on a model without any price (every rate zero); Claude through pi-claude-bridge, which Pi prices at $0, shows `no per-token price` |
| `api, price unknown`, `api, price ?` | no price known; `?`: prices that differ between the possible credentials, or that only some have |
| `providers.dev: no data for this model` (dim) | providers.dev has no entry for the model: the values are Pi's own |
| `providers.dev: no data (PI_OFFLINE)` (muted) | nothing was ever fetched, and `PI_OFFLINE` stops it |

**What went wrong** comes right after the countdown, in the warning color and marked `⚠`:

| The footer | When |
|---|---|
| `⚠ keep-warm ended (a refresh missed the cache): $1.22 spent, a miss costs $2.07` | a refresh read less than 90% from the cache, so keeping warm ended for this idle period; likewise `(a refresh failed)`, `(a refresh reported no usage)` (what it cost is unknown) and `(the request can't be re-sent)`. Until your next message |
| `⚠ keep-warm: Pi's after 2 refreshes without a hit (/cache-keeper-warm)` | two refreshes in a row missed the cache or did not report what they cost, so the model is left to Pi's own warming. For as long as that lasts, with a countdown or without |
| `⚠ countdown on another model's long tier` | the countdown runs on another tier than the model's own (marked `(in use)`): with keep-warm off, or in a period left to Pi, the countdown takes the tier the latest answer of any model reported, and after a model switch that can be another model's. Also said where the answer the countdown counts from (the latest one not cancelled or failed) is another model's. It may then not follow this model's cache |
| `⚠ answered by an API key` (`a login`, `another account`) | through a proxy, the last answer came from another kind of credential than the values are for; the values and the countdown follow what answered |
| `⚠ providers.dev: no data, fetch failed` | nothing was ever fetched: providers.dev could not be reached (blocked, or down), so the values are Pi's own. `/cache-keeper` has the reason; the next session start or `/cache-keeper-refresh` tries again |
| `⚠ providers.dev refresh failed: data 26h old` | the last refresh failed, so the data fetched before is in use, as old as it says |
| `⚠ login or API key unknown: shorter values` | at the end of the line: why a value is marked `⚠`. `⚠ no entry for this login: shorter values` for Pi's ChatGPT login on `openai`, which providers.dev has no entry of its own for |

**Keep-warm's goal** comes there too, muted, while keep-warm is on:

| The footer | When |
|---|---|
| `keep-warm 2h until 16:40, $0.36 spent of $2.07` | the extension keeps this idle period's cache warm: the limit you set (`keepWarmMinutes`), the clock time it runs out (counted from Pi going idle; `tomorrow 00:10` past midnight), and what the period's refreshes have spent of the one cache miss they may cost (`3 of 10 refreshes` for a model without prices). A clock time, so it is not taken for the cache's time left. Narrower: `keep-warm until 16:40, $0.36/$2.07`, then `keep-warm until 16:40` |
| `keep-warm 2h` | keep-warm is on, and nothing is being kept warm right now: a request runs, the cache is cold, no answer yet, or another model since a switch. The setting, not a goal being met |

**Where the extension stepped back** comes there too, muted, while keep-warm is on, in place of the goal:

| The footer | When |
|---|---|
| `keep-warm ended (budget reached): $1.98 spent, a miss costs $2.07` | refreshing has cost as much as one cache miss (without prices, `10 of 10 refreshes`); `(2 h limit)` at the time limit. Until your next message |
| `keep-warm: Pi's (several cache lifetimes)` | this idle period is left to Pi's own warming, the reason in a few words: `no cache lifetime`, `thinking on`, `openai-codex-responses not re-sent`, `a refresh costs a miss`, `no time to refresh` …; `/cache-keeper` gives it in full |
| `keep-warm: from your next message` | keep-warm was switched on during this idle period |

**A stop** comes in the same place, muted:

| The footer | When |
|---|---|
| `warming stopped until your next message` | `/cache-keeper-stop` was given, in this window or another, since your last message here: nothing is sent to keep this window's cache warm, with keep-warm on or off, until the answer to your next message. In the place of keep-warm's own note; keep-warm's warnings stay beside it. Not while a request runs. Narrower: `warming stopped` |

With keep-warm off none of these show but the stop, and with [model data](#model-data-from-providersdev) off the values are Pi's own and nothing is said about providers.dev. `/cache-keeper` has the full detail of everything on the line.

**In a narrow terminal** the line is fitted to the width, and fitted again when the terminal is resized, so Pi doesn't cut it in the middle of a word:

1. The wording goes first, the least important part's first: `api $3/$15 per M` becomes `api $3/$15`, `long 1h (in use)` becomes `long 1h` (the first lifetime is the one in use, once there is one), `cache warm · 59m left` becomes `warm 59m`, and errors shorten (`⚠ keep-warm failed`, `⚠ keep-warm: Pi's`, `⚠ data 26h old`).
2. Then whole parts, the least important first: the providers.dev notes, what was sent when it agrees with the countdown, the explanation of a `⚠` guess, the other lifetime, the keep-warm goal, the price, the lifetime in use, and the keep-warm notes.
3. Errors go last, down to a bare `⚠` that stands for all of them (`/cache-keeper` says what it is). The countdown always stays.

A part that fits again once a larger one has gone comes back, and room left over goes back to the wording of the most important parts first. So what changes what you do comes first (something went wrong, the time left), then what you pay (the lifetime in use, the price), then what explains it. At 60 columns the line reads `warm 59m · long 1h · short 5m · sent 1h · api $3/$15`; at 40, `warm 59m · long 1h · api $3/$15`, or with a failed refresh `warm 0:25 · ⚠ keep-warm failed · long 1h`. Pi puts every extension's status on this one line, ordered by key, and cuts it at the right edge; errors right after the countdown are the last to be cut when another extension's status takes some of the room.

## Commands

| Command | What it does |
|---|---|
| `/cache-keeper` | shows the cache right now, whether the next compaction would read it, the settings in effect (marking the ones this session set for itself), the model data in use, and this session's log |
| `/cache-keeper-settings` | opens the settings menu on this session's settings, with the defaults for all sessions one step away; outside the TUI it lists both (see [Settings](#settings)) |
| `/cache-keeper-warm` | starts keeping the cache warm again for the models two refreshes in a row without a hit left to Pi's own warming, and clears every model's count of them; it takes effect at the latest from your next message (an idle period already running whose own warming had not ended is kept warm again at once), sends nothing and doesn't turn keep-warm on; it does not lift a `/cache-keeper-stop` (see [Keeping the cache warm](#keeping-the-cache-warm)) |
| `/cache-keeper-stop` | stops keeping idle caches warm in every Pi window that uses the same settings, until the next message you send each window: the extension sends no further refresh and Pi's own idle warming is told to stop when it next asks; compacting before expiry still runs; it changes no setting and can't be taken back (see [Stopping it in every window](#stopping-it-in-every-window)) |
| `/cache-keeper-refresh` | fetches the model data from providers.dev now, puts it into Pi's `models.json`, and says how many models changed and what the current model got (see [Model data](#model-data-from-providersdev)) |
| `/compact` | Pi's own command; it goes through the cached path too |

**`/cache-keeper`**:

![The output of /cache-keeper: "pi-cache-keeper · anthropic/claude-opus-5-5. cache: 59m left (lifetime 60 min, declared by the model). next compaction: cached path; last request 4 s ago with 185 messages, 1 since. The request prefix is checked when it runs. when full: at 90%: 900k of 1000k on anthropic/claude-opus-5-5, leaving 96k for the summary. keep warm (this session): up to 4 h after Pi goes idle; stops once refreshing has cost as much as one cache miss; so far $0 spent, a miss costs $2.36. before expiry: on, from 140k tokens of context · retention long. model data: claude-subscription/claude-opus-5-5: window 1,000,000, short cache 1 h, long cache 1 h (https://providers.dev, checked 180 min ago; /cache-keeper-refresh fetches it again). settings: this session's own: keepWarmMinutes 4 h (default 2 h); every other follows the defaults · /cache-keeper-settings. log: ~/.pi/agent/cache-keeper.jsonl. This session: 15:05:52 compact when full: cached, 99% of 904k from cache, 5k out, 41.6s, summary 9840 chars. vs Pi's compaction: 75% less, $0.59 instead of ~$2.4 (it sends ~451k tokens, none from cache). 15:06:34 saved, 903k tokens summarized. 16:36:52 kept the cache warm, idle 57 min: 99% of 411k from cache, 1 out, $0.21; $0.21 of $2.36 (one cache miss) spent."](media/status-command.png)

Each value shown that this session set for itself is marked `(this session)` (`when full: at 80% (this session): …`, `keep warm (this session): …`, `before expiry: on, from 200k tokens of context (this session)`); a value that comes from the defaults is not. The `settings` line lists those values beside the defaults they replace; without any, it reads `settings: the defaults (this session has none of its own)`.

The `cold compaction` line names the [cold compaction model](#compacting-a-cold-cache-with-another-model) in effect, marked `(this session)` where the session set it, with its window and its price or `subscription` (`cold compaction: google/gemini-2.5-flash (this session) · 1M window · $0.30 in, $2.50 out per M · whether it writes a summary is decided at each compaction, from the part Pi cuts off`), `not available now` for a pick Pi can't use now, or `off: when the cache can't be read, Pi's compaction writes the summary on this session's model`. It doesn't say which model will write the next summary: that is decided at the compaction, from the part Pi cuts off then. Where the next compaction couldn't be read from the cache, the `next compaction` line says so and why (`not from the cache, because the prompt cache has expired; the cold compaction model writes the summary where it can, else Pi's compaction`).

The `model data` line names the providers.dev entry that describes the model and what it gave. When a guess is in use it says which values are the smaller of the login's and the API key's, and which were not used; when another kind of credential answered, it gives that one's values too.

**`/cache-keeper-settings`**:

![The settings menu: "pi-cache-keeper · editing this session · its own values are saved in the session; every other follows the defaults". Rows: Editing: this session; Compact when the context is 90% · default; Or once it holds off · default; Compact before the cache expires on · default; Keep the cache warm when idle 4 h · this session; Before expiry, only from 140k · default; Back to the defaults: drop 1 own value; Cache retention · all sessions long; Model data · all sessions on. Under them, the description of the selected row: "The warming and compaction values you pick below hold for this session only, saved in it: after a resume, and in a fork made after them. Every value marked default follows the defaults, also when they change later. Enter edits the defaults for all sessions instead." Then "Enter/Space to change · Esc to cancel".](media/settings-menu.png)

Each row maps to a setting below. The menu opens on this session: the first row, "Editing", switches it to the defaults for all sessions and back. The menu describes the selected row, and for "Compact when the context is" it works out where that falls on the current model.

The figures on this page are the extension's own output, from a run of the current code with sample sessions and sample providers.dev values.

## Settings

Settings come in two layers:

- **The defaults**, for every session: the `cacheKeeper` key in `~/.pi/agent/settings.json`. A session that sets nothing of its own uses them, exactly as before 0.8.0. You can also edit that key by hand. When there is no `cacheKeeper` key, the `cachedCompaction` key of pi-cached-compaction is read instead, unchanged. Project settings files don't apply to it, and an unknown key is an error.
- **A session's own values**, for that session only: `compactAtPercent`, `compactAtTokens`, `coldCompactionModel`, `compactBeforeExpiry`, `minContextTokens` and `keepWarmMinutes`. Each value a session sets wins there; every other setting follows the defaults, also a default changed later. They are saved in the session itself, as a `cache-keeper-settings` entry (never sent to the model, and never written to `settings.json`), so they hold when you resume the session, and in a fork or clone made after them. The latest such entry on the branch you are on decides: `/tree` to a point before the change, or `/fork` from a message before it, gives the values in force there. In a new session they are saved with its first answer, when Pi writes the session's file.

`cacheRetention` and `modelData` are the same for every session, and a session can't set them: the retention works through `PI_CACHE_RETENTION`, which holds for the whole Pi process, and the model data is written into Pi's `models.json`, which every session reads. The menu marks them `all sessions`.

Run `/cache-keeper-settings` to change them in a menu. It opens on **this session**: each warming and compaction row shows its value and whether it is the session's own (`4 h · this session`) or the default (`2 h · default`); Enter steps through the values, the `default` one dropping the session's own value for that row; on "Compact a cold cache with" it opens the list of models instead, whose first line, `default (…)`, drops it. "Back to the defaults" drops all of them at once. The session's own values apply right away and are saved in the session when the menu closes. Enter on the first row, "Editing", switches to the **defaults for all sessions**: there, changes are saved to `cacheKeeper` in `~/.pi/agent/settings.json` and apply right away, in this session wherever it has no value of its own. Outside the TUI the command lists both layers: each value with `[default]` or `[this session; default …]`.

| Setting | Menu | Default | Per session | What it does |
|---|---|---|---|---|
| `compactAtPercent` | Compact when the context is | `90` | yes | after a turn, compact once the context fills this share of the model's window; `0` turns it off |
| `compactAtTokens` | Or once it holds | `0` | yes | also compact once the context holds this many tokens, on any model, whichever comes first; `0` turns it off |
| `coldCompactionModel` | Compact a cold cache with | `""` | yes | this model (`"provider/modelId"`) writes the summary when the cache is cold, when the session's model refuses it, or when the conversation doesn't fit the session's model, also with every other setting here off; `""` turns it off ([more](#compacting-a-cold-cache-with-another-model)) |
| `compactBeforeExpiry` | Compact before the cache expires | `true` | yes | compact 20 s before the cache expires, when idle |
| `minContextTokens` | Before expiry, only from | `140000` | yes | the smallest context compacted before the cache expires; keeping the cache warm doesn't use it |
| `keepWarmMinutes` | Keep the cache warm when idle | `0` | yes | keep the cache warm up to this many minutes after Pi goes idle (up to 1440; the menu offers 30 min, 1, 2, 3, 4, 6, 8, 12 and 24 h); it stops once refreshing has cost as much as one cache miss, and while it is on the extension is the only warmer of an idle cache it can refresh; `0` turns it off |
| `cacheRetention` | Cache retention | `"long"` | no | ask for the longer cache in interactive sessions (2× writes on Anthropic and Kimi); `"short"` keeps Pi's default |
| `modelData` | Model data from providers.dev | `true` | no | read each model's input window, cache lifetimes and prices from providers.dev and put them into Pi's `models.json`; `false` takes them out again |

```json
{
  "cacheKeeper": {
    "compactBeforeExpiry": false
  }
}
```

A session's own `keepWarmMinutes` works as the default does: each idle period of that session is kept warm for up to its value, under the same rules (who warms a period, the budget, stopping), and `/cache-keeper-stop` still stops every window. Changed during an idle period, it takes effect as a change of the default would: switched off, warming ends for the period; switched on, from your next message; shortened, no refresh goes out past the new limit, also one already being prepared.

The defaults are read as they are saved now: `settings.json` is read at every decision that uses a default, so when it changes (from the menu in another window, or by hand), every session that has no value of its own for a setting follows the new default at its next decision, and its menu and `/cache-keeper` show it. If the file can't be read or parsed, the last defaults that parsed stay in use.

## Common tasks

| Want | Do |
|---|---|
| See the cache now and this session's compactions | `/cache-keeper` |
| See why a compaction didn't use the cache | expand its card with ctrl+o |
| Change the settings from Pi | `/cache-keeper-settings` |
| Keep this session warm for 4 h, and no other | `/cache-keeper-settings`, then "Keep the cache warm when idle" to `4 h · this session` |
| Compact one big session earlier than the others | `/cache-keeper-settings`, then "Compact when the context is" (or "Or once it holds") to a value marked `this session` |
| Change a setting for every session | `/cache-keeper-settings`, Enter on "Editing" (defaults for all sessions), then the row |
| Put this session back on the defaults | `/cache-keeper-settings`, then "Back to the defaults" |
| See which settings this session set itself | `/cache-keeper`: the values marked `(this session)` and the `settings` line |
| Have a cheaper model write the summary when the cache is cold | `/cache-keeper-settings`, then "Compact a cold cache with" (see [Compacting a cold cache with another model](#compacting-a-cold-cache-with-another-model)) |
| Compact earlier or later on big models | change "Compact when the context is" (`compactAtPercent`) |
| Keep the context under a fixed size on every model | set "Or once it holds" (`compactAtTokens`) |
| Stop compacting before the cache expires | `"compactBeforeExpiry": false` in [Settings](#settings) |
| Compact before expiry only on bigger sessions | raise `minContextTokens` |
| Keep the cache warm through a long break | "Keep the cache warm when idle" (`keepWarmMinutes`), see [Keeping the cache warm](#keeping-the-cache-warm) |
| Stop the idle spending in every window before a long break | `/cache-keeper-stop` |
| Keep Pi's 5-minute cache and its 1.25× writes on Anthropic | `"cacheRetention": "short"` |
| See the cache lifetimes, what was sent and the price for the current model | the footer (see [The footer](#the-footer)), or the `model data` line of `/cache-keeper` |
| See what a `⚠` in the footer is about | `/cache-keeper` |
| Fetch the model data again now | `/cache-keeper-refresh` |
| Get the countdown on a model providers.dev has no lifetime for | declare one with Pi's `modelOverrides.promptCache` |
| Look through past decisions | the `jq` line under [The compaction card and the log](#the-compaction-card-and-the-log) |

## Compacting from the cache

Pi's compaction swaps the system prompt, drops the tools, and flattens the messages into text. None of that matches what the provider has cached, so every token of the summary request is billed at full price.

It also cuts every tool result down to its first 2,000 characters, and the bigger the session, the more that throws away. Long sessions do their work in long outputs: whole files, test runs, build logs. The summarizer sees only the start of each one, so it misses the bottom of the file and the failures listed at the end of the test run. In eleven sessions that passed 700k tokens, measured for the original extension, Pi's compaction would have shown it 35–57% of the tool output, leaving out 300k to 1M characters per session.

![One 40 KB test run, as the summarizer sees it. Pi's compaction shows it the first 2,000 characters, and the failures are down at the end. pi-cache-keeper shows all of it, read from the cache.](media/test-run.png)

This extension keeps the system prompt, the tools, and the messages as they are, and appends one instruction instead, as the next turn of the same conversation:

![What each compaction sends. Pi's compaction: a summarizer prompt, then the older messages as text with tool output cut; nothing from cache. pi-cache-keeper: the tools, the system prompt and messages 1 to N, the same bytes as your last turn, plus a new "summarize this" instruction; about 99% from cache.](media/what-it-sends.png)

The provider reads nearly all of it from the cache at about a tenth of the input price, and the model writing the summary sees the whole conversation, tool output included. The result looks like Pi's: its checkpoint format, its window of recent messages kept as they are, and the read and modified file lists carried forward.

| | Pi's compaction | pi-cache-keeper |
|---|---|---|
| What it sends | the older messages as text, under its own system prompt | your conversation as it is, plus one instruction |
| Prompt cache | not used | about 99% read from it at normal compaction sizes |
| Tool output the summary sees | the first 2,000 characters of each result | all of it, read from the cache |
| Cost | full price, for the older messages only | 0.1× for the whole session: less once there's a lot to summarize, more on small sessions ([numbers](#what-it-costs)) |
| After a long break | your next message rewrites the whole expired cache | it compacts just before the cache expires, so there's much less to rewrite |
| Cache lifetime | Pi's default (5 minutes on Anthropic) | 1 hour in interactive sessions, which Anthropic bills at 2× per write instead of 1.25× ([why](#compacting-before-the-cache-expires)) |
| What you see | the summary | the summary, a card comparing the cost with Pi's compaction, and a cache countdown in the footer |

Before sending, the extension checks that the request repeats your last one byte for byte up to the new part. When it can't prove that, Pi's own compaction runs as usual, or the [cold compaction model](#compacting-a-cold-cache-with-another-model) where you picked one. (Claude through pi-claude-bridge is checked by the bridge instead; see [Providers](#providers).) [How it works](#how-it-works) has the details.

## Compacting a cold cache with another model

**What it does.** The cached path writes the summary when it can. When it can't, a model you pick writes it, with Pi's own summarizer. When the picked model can't either, Pi's own compaction runs exactly as before. That one rule covers three cases, with one picked model for all of them: the cache is cold, your session's model refuses the summary, and the conversation no longer fits your session's model.

The summary is Pi's own summary, written by the picked model: Pi's prompt and checkpoint format, its window of recent messages kept word for word, the previous summary updated, the file lists carried forward. The picked model gets no thinking, or its lowest level where it can't turn thinking off. The request goes to that model directly, beside the session: your session's model and thinking level are not touched, and the session goes on with its own model. One difference from the cached path: the picked model sees what Pi's compaction sees, tool results cut to their first 2,000 characters, not the whole conversation the cached path reads from the cache.

It needs no other setting of the extension switched on. With compacting when full, compacting before expiry, keep-warm and the model data all off, Pi's own compactions still pass through the extension: a threshold compaction, an overflow recovery and a `/compact` that can't be read from the cache are written by the picked model. That is where it matters most, because compacting before expiry is what normally keeps a compaction from meeting a cold cache: with it off, or under `minContextTokens`, a session you left alone is compacted cold. Two things follow when those settings are off:

- **With compacting when full off, Pi's threshold compaction rarely fits the cached path, warm or cold.** With Pi's default settings it starts when under `reserveTokens` (16,384) of the window are left, and a cached summary needs 16k of room beside the whole conversation. So it falls back with "only … tokens of the context window are left for the summary", and the picked model writes those summaries too, in the middle of a run with a warm cache.
- **With the model data off, fewer models have a known cache lifetime,** so more of them are a cache of unknown lifetime (below), where the cached path is tried.

Pick the model in `/cache-keeper-settings`, on the row "Compact a cold cache with" (the `coldCompactionModel` setting, `"provider/modelId"`). Enter opens a list of the models Pi has credentials for, which you can search by typing. Each line shows the model's window, its price at this session's size (or `subscription` for a subscription login, `no price` without prices), and whether it can hold this session now (`holds this session`, `too small now (needs about 150k)`, `can't be used: it declares no context window`). The ones that hold this session come first, then by price. That last part is measured when the list opens, on the context as it stands: an upper bound, since a compaction sends only the part before the messages it keeps. The line is advice: a model you picked stays picked, and the fit is checked again at each compaction. Like the other compaction settings it has a default and a value per session, so a session can turn it off for itself (`off · this session`).

### When it applies

- **The cache is cold.** It has expired, was never written, or belongs to the model you switched away from. The picked model writes the summary, at its own price instead of your session model's full input price.
- **Your session's model refuses the summary.** Its quota is used up, it is rate-limited, or the request for the summary fails for another reason. The picked model writes it instead, so the session is compacted all the same.
- **The conversation no longer fits your session's model.** You switched to a model with a smaller window, or the context outgrew the window. If the picked model's window holds the text, it writes the summary.

While the cache is warm and your session's model can write the summary from it, nothing changes. And whenever the picked model can't write it, Pi's own compaction runs as before.

| What started the compaction | Picked model |
|---|---|
| `/compact` | yes |
| Pi's automatic compaction at its threshold | yes |
| Pi's overflow recovery | yes; the turn is retried after it, as before |
| Compacting when full | yes |
| Compacting before expiry | never: it runs only while the cache is warm, and is cancelled when the cached path can't write the summary |

**The rest of the fallbacks go the same way.** On a warm cache the cached path can also fall back where your session's model could still write the summary through Pi's compaction at full price: the request's API isn't supported, the conversation changed since the last request, the request no longer repeats the last one, no kept message has text to quote, or the cached summary hit the output limit, was a tool call or came back empty. The picked model writes those summaries too: nothing is read from the cache either way.

**A cache of unknown lifetime or expiry** is never counted as cold: a model with no countdown in the footer, and a cache kept warm whose expiry became unknown (its lifetime can't be read any more, or its route changed). Nothing says it is gone, so the cached path is tried, and the picked model writes the summary only if that path falls back. When such a cache was in fact gone, the summary request pays your session model's full price. A model whose answers report no cache use at all is different: that cache is cold.

### When it falls back

In each of these cases Pi's own compaction runs as before, on your session's model, and the card and the log say which case it was:

- The picked model is a virtual model, or Claude through pi-claude-bridge (a request there is a Claude Code query, with tools). Neither is offered in the list.
- It is the session's own model, Pi no longer lists it, or Pi has no credentials for its provider. A pick Pi can't use now is kept, and shown as `not available now`: it works again when the model does.
- It declares no context window. It is not tried: a local server that silently cuts the request would return a summary of the last part only. Declare a window in `models.json`.
- The conversation and the summary don't fit it. The need is the text Pi's summarizer sends (the messages as text with tool results cut to 2,000 characters, the previous summary, your `/compact` instructions and Pi's prompt; the larger of the two requests for a turn that was split), counted high: one token per UTF-8 byte, since no request has been sent to that model to measure its tokenizer and dense text (base64, hex, CJK) takes far more tokens per character than prose. The model fits when that leaves room for a summary of at least 16k tokens, or of its whole output limit where that is smaller, after what thinking adds on a model that can't turn it off. That room is the output limit sent with the request, so the request can't ask for more than the fit allowed. Prose is counted about five times its real size, so a model can be refused that would have fit; tool results are cut down, so a session larger than a model's window can still fit.
- A reply doesn't end in a normal stop (a provider error, a rejected login, an overflow after all, a dropped stream or one the provider cancelled, the output limit), also after some text came; the model calls a tool; or the reply holds no summary once the file lists are taken out. Each reply is checked as it ends, and nothing more is sent after a failure: a split turn's second request isn't. There is one attempt, no retry.

**An abort** (Escape during the compaction), before or during the picked model's request, cancels the compaction as an aborted one is cancelled today: nothing more is sent, and Pi's own compaction is not started behind your back.

**Nothing is lost.** The extension hands Pi either a complete compaction with Pi's own cut point and token count, or nothing, and then Pi's compaction runs; it cancels only for your abort. Pi writes the entry itself, and a compaction removes nothing from the session file. An overflow recovery gets either summary, and retries the turn after either.

**Where your conversation goes.** With a cold compaction model set, the part of the conversation being summarized is sent to that model's provider, as Pi's own summarizer writes it out: your messages in full, with the full output of shell commands you ran with `!` (they are your messages, not tool results); the assistant's answers and its tool calls with their arguments; the first 2,000 characters of each tool result; the previous summary; any `/compact` instructions; and, on Pi before 1.2, the assistant's thinking. That is the same text Pi's own compaction sends, but to another provider than the one your session talks to, under that provider's terms and with the credentials Pi holds for it. It is off by default, nothing is sent this way until you pick a model, and you can turn it off for one session only. The summary is then as good as the model you picked.

## The compaction card and the log

**The card** appears under the summary after each compaction (see the figure at the top). It's shown to you only, never sent to the model, and stays in the session after a resume. Its second line compares this compaction with what Pi's would have cost for the same messages: green when this one cost at least 5% less, amber when it cost at least 5% more, and "about the same" in between. Models with no price, like Claude Code's subscription models through pi-claude-bridge, get the comparison in tokens not read from the cache instead of dollars.

**Pi's side is an estimate,** since Pi's compaction never runs. The extension serializes the messages exactly as Pi's compaction would, then counts tokens at the rate the provider counted for this summary request, so it follows each model's tokenizer. In the original author's tests it came within 2–12% of what Pi's compaction actually sent, always a little high, so the card slightly overstates the saving.

**When the cache can't be used,** the card says why and what Pi's compaction did instead. Expand it with ctrl+o to see what the decision rested on:

![The expanded card: "13:48:54 /compact: Pi's compaction, request field "reasoning" differs. cache: lifetime 30 min (OpenAI's minimum), 30 min left. last request: 4 s ago, 20 messages, 2k prompt tokens, 1 new since. request: thinking low, shared 12h prefix. last request had: {"effort":"high","summary":"auto"}. summary request had: {"effort":"low","summary":"auto"}. 13:48:59 Pi's compaction saved: 0% of 923 from cache, 384 out, $0.0003, summary 1243 chars. log: ~/.pi/agent/cache-keeper.jsonl"](media/card-fallback.png)

**When the picked model wrote the summary** ([Compacting a cold cache with another model](#compacting-a-cold-cache-with-another-model)), the card's header reads `cold compaction`, and the line is not in the warning colour: nothing went wrong.

```text
13:48:54 /compact: summary by google/gemini-2.5-flash, the prompt cache has expired: 148k in, 3k out, $0.052, 12.3s, summary 5120 chars
13:48:54   saved, 412k tokens summarized
```

The line names the model, why the cached path couldn't write the summary, and what the requests cost as they recorded it: the dollars where a cost was recorded, `on a subscription` where none was and the model is reached through a subscription login, `no price` otherwise. There is no comparison with your session's model. Expanded, the card adds `cold model: google/gemini-2.5-flash (API key), thinking off, about 148k tokens of a 1M window, 1 request`, counting the requests really sent. When the picked model couldn't write it, the line says why, in the warning colour as any fallback:

```text
13:48:54 /compact: Pi's compaction, the prompt cache has expired; google/gemini-2.5-flash did not write the summary: it needs about 260k tokens and its window is 200k
13:48:59   Pi's compaction saved: 0% of 231k from cache, 2k out, $1.2, summary 4870 chars
```

**The log.** Every decision is also appended to `~/.pi/agent/cache-keeper.jsonl`, which moves to `.1` past 5 MB: compactions, compacting when full or before expiry (or why not), cache refreshes, and model data fetches. Each compaction line records what triggered it, the path it took and why, the request settings, the provider's cache usage, the estimate for Pi's compaction, and the timing. When the request didn't match, it includes up to 200 characters of each version around the first difference. The log stays on your machine.

```sh
jq -c 'select(.event == "compact") | {at, trigger, outcome, reason, cacheRead: .response.usage.cacheRead, piEstimate}' ~/.pi/agent/cache-keeper.jsonl
```

## Compacting when the context is full

A summary needs room in the context window next to the conversation it summarizes. Pi's own automatic compaction starts when only `compaction.reserveTokens` (16k by default) is left, which on a 1M-token model leaves too little room for the summary of a 980k-token conversation, so the cached request runs out of room and Pi's compaction runs instead, at full price.

So after a turn, once the context fills `compactAtPercent` of the model's window (90% by default: 900k of 1M, leaving about 96k for the summary), the extension compacts right away, while the cache that turn just wrote is warm. It only does this when Pi is idle with nothing queued and Pi's auto-compaction is on. If the cached path isn't available, Pi's compaction runs, which is still cheaper now than at the very end. A run of tool calls that fills the window within one turn still ends in Pi's own compaction.

**A token cap.** A percentage means a different size on every model: 70% is 700k tokens on a 1M-token model and 190k on a 272k one. `compactAtTokens` sets one size for all of them, and the session compacts at the cap or the percentage, whichever comes first. The reason to set it is cost rather than room: every request reads the whole context from the cache, so a 690k-token context costs about $0.14 per request at $0.20 per million cached tokens, before the model writes anything. A lower cap makes each request cheaper, and older detail is summarized sooner.

The summary request may use the model's output limit, reduced so the conversation and the summary fit the window, as Pi's own compaction does. When less than 16k tokens would be left, the extension doesn't try the cached path and Pi's compaction runs.

## Compacting before the cache expires

If you step away, the cache expires and your next message pays to write the whole session again. So 20 seconds before expiry, the extension compacts from the still-warm cache, and your next message rewrites a summary-sized context instead. It only does this when:

- Pi is idle with nothing queued,
- Pi's auto-compaction is on,
- the context holds at least 140k tokens (`minContextTokens`; it applies only here, not to keeping the cache warm),
- and the cached path is available.

While Pi is busy or a message is queued, it tries again each second until the cache expires; otherwise it does nothing and the cache cools. When the expiry moves (Pi's own cache warming refreshed it), the new expiry gets its own try. Models without a [countdown](#the-footer) never compact before expiry. A [`/cache-keeper-stop`](#stopping-it-in-every-window) does not hold it back, and the summary starts no warming again.

The summary is only worth sending while the cache is warm, so it has a last check, as a refresh does: when its request is about to leave, after Pi has looked up the credentials and built it, the expiry is read again, and if the cache has expired by then (a slow credential lookup, say, or a proxy that just showed a shorter lifetime) nothing leaves and the compaction is cancelled, with that reason in the log (`the prompt cache expired before the summary request left`). Through pi-claude-bridge, which has no such hook, that check is made just before the request is handed to the bridge, so time the bridge takes after that isn't covered. Compacting when the context is full and `/compact` don't have this check: there a summary is wanted either way.

The threshold is in tokens rather than percent because rewriting an expired cache costs in proportion to its size, and on 1M-token models a percentage would almost never trigger.

**The longer cache.** A 5-minute cache expires during most breaks, so in interactive sessions the extension asks for the longer one (`PI_CACHE_RETENTION=long`) unless you've set that variable yourself. That's 1 hour instead of 5 minutes on Anthropic and Kimi K3, and a 12-hour shared system prompt on GPT-5.6 and later (see [Providers](#providers)). It isn't free: writing a 1-hour cache costs 2× the input price, instead of 1.25× on Anthropic and 1× on Kimi, though reads cost the same. Headless runs (`pi -p`, JSON mode, subagent processes) keep the short cache, since nobody pauses there. The choice is made once per session, because moving a cache up a tier means writing all of it again.

## Keeping the cache warm

Keep-warm is off by default (`keepWarmMinutes: 0`), and this version rebuilt it: how it decides who warms a period, what it may spend, and when it stops are all new. While it is off, Pi warms the cache on its own exactly as before, and the extension sends no refresh of its own. Turn it on in `/cache-keeper-settings` if you often leave a session idle for longer than its cache lasts.

Pi can keep an idle cache warm itself (`cacheWarming: "idle"`), but only until 30 minutes after the last request started, and only when it expects the refresh to pay for itself. Its refresh comes at 90% of the lifetime, so a 1-hour cache (54 minutes) is never refreshed while idle. Set `keepWarmMinutes` to keep the cache warm longer after Pi goes idle, for example `120` for two hours.

The rule is: **keep the cache warm for up to `keepWarmMinutes`, and stop once refreshing has cost as much as one cache miss.** A refresh is worth sending only while all the refreshes of a break together cost less than the one cache miss they avoid.

**One warmer per idle period.** An idle period runs from one answer to the next: an answer that read or wrote the cache (a cancelled one included), or a successful one that used none. With keep-warm on, the extension keeps a period's cache warm itself only where it has proof it can re-send the request safely: the last answer used the cache, with a lifetime of at least a minute; its request was seen with its payload; the request's API is one whose Pi adapter is checked to build a one-token answer's output limit in the key the request carries it in (`anthropic-messages`: `max_tokens`; `openai-completions`: `max_tokens` or `max_completion_tokens`; `openai-responses`: `max_output_tokens`, at least 16), and the request carries that limit; and it can be re-sent as it was (not Claude through pi-claude-bridge, whose request the extension never sees, and not Claude's budget-based thinking, which keys the cache on the output limit; adaptive thinking is fine). Amazon Bedrock, Mistral, Gemini, Codex and every other API are left to Pi, since a refresh there could generate a full answer. So is a request that carries more than one cache lifetime, states a lifetime of its own that differs from the model data, or relies on a route's lifetime that no answer confirmed ([which sessions](#which-sessions-it-keeps-warm), [by the request](#keeping-the-cache-warm)). So is a period whose answer Pi got only by re-sending its request in another form after the provider rejected the first (Anthropic's strict tools over its limits; `keep-warm: Pi's (request re-sent)`): the request the extension saw is not the one whose cache the answer wrote, so the extension skips its keep-warm refresh for that period and leaves Pi's own warming free to decide. Pi builds the session's later requests in that form from the start, and those are kept warm as usual. Keep-warm is read from the saved settings each time it matters, so switching it off in one Pi window holds in every window from the next decision on; a period that started while it was off is never kept warm by the extension. Switched off inside a period (in the settings menu, or saved from another window), the period's cache is read from then on as with keep-warm off: the countdown runs again from that reading (at once in the window where you switched it, within 15 seconds in another), and compacting before expiry follows it as with keep-warm off. Then it is the only warmer: each time Pi's own warming is about to refresh while Pi is idle (`cache_warming_decision`), the extension tells it to stop, and Pi's warming stays stopped until the next request. Pi still warms during a run. A session the extension can't refresh itself (no lifetime, one under a minute, a last answer that used no cache, an answer that streamed so long that its cache's last safe refresh moment passed before Pi went idle, a request it can't re-send, an API it doesn't re-send) is left to Pi's own warming for the whole period, exactly as with keep-warm off, and the extension sends nothing. The footer says so in a few words (`keep-warm: Pi's (thinking on)`), and `/cache-keeper` says which applies and why. A period the extension keeps warm is handed to Pi inside it in two cases: the extension let go of its request (a model switch, also one away and back without a message, a move on the tree, a compaction: `keep-warm: Pi's (you switched model or branch, or compacted)`), or what is read since no longer agrees with the period's lifetime ([below](#keeping-the-cache-warm)). From then on Pi's warming decides: the extension tells it to stop only once nothing it has seen says the cache can still be alive, counting Pi's own refreshes (by when each was recorded) as well as the period's own facts, with the shortest lifetime read since; where no lifetime can be read, never. So Pi's refresh goes out while its own last refresh, or the period's, keeps the cache alive, and is stopped where it would only write a cache that is gone. A period whose warming ended on its time limit (the cache lasting past it included) or because the extension could not send its refresh (`unable`: the request can't be re-sent, the provider wouldn't cap the answer) keeps Pi's warming stopped until one of those two cases hands it over. A period whose warming ended on its budget, a miss, a refresh that reported no usage or one that failed keeps Pi's warming stopped until the next request, as before. A limit remains: Pi's warming that the extension already told to stop in a period stays stopped until the next request (Pi doesn't ask again), so a period handed over after that is warmed by neither.

- **The budget.** The extension adds up what its refreshes in the period cost. A refresh is expected to cost the last answer's prompt at the cache-read price plus one output token; a cache miss costs that prompt at the cache-write price (the input price when the model has none) less the prompt at the cache-read price. These are the figures Pi's own warming weighs (`evaluateCacheWarming` in pi-ai 1.5.1 and later), worked out the same way by the extension, so it runs on older Pi too. A refresh goes out only if what has been spent, plus that refresh, stays within one miss; that refresh is counted at its expected cost, or at what the last refresh really cost when that was more. When it goes out it is counted at that amount, and when it reports what it cost, that replaces it; one that fails or is cancelled without a report stays counted. Once the total reaches one miss, warming ends.
- **The worst case.** A refresh the provider does not serve from the cache costs a full write, more than planned, and that can't be known before it is sent. It is counted, and warming ends (the budget, or a refresh that read less than 90% from the cache).
- **Without prices** (a subscription login: Pi prices those models at $0; every rate zero, in every price tier), the budget can't be counted in money, so it is at most 10 refreshes per period. Where the cached read costs a tenth of the input price, a miss costs between 9 refreshes (no cache-write price) and 19 (a 2× write price).
- **The time limit.** `keepWarmMinutes` stays as a plain upper limit, counted from when Pi went idle after the period's answer. It takes effect, and is said, as soon as the cache lasts to its end: when a refresh carries the cache past it, or at once when the answer's own lifetime already does.
- **A run that sends nothing** (cancelled before its first request) changes nothing: the spending and the time limit stay those of the period, whose cache is still the one kept warm. Only a new answer starts a new period: one that read or wrote the cache, or a successful one that used none (that period is Pi's, since there is no cache to keep warm). The spending is kept in memory, so a reload or restart of Pi starts a new period too (and the extension can't refresh a request it hasn't seen since, so that period is Pi's).
- **Any size.** A refresh and a miss both grow with the context, so the rule holds for a small session as for a large one. `minContextTokens` applies only to compacting before expiry: when warming ends, a context from that size up is compacted before the cache expires, a smaller one is left to expire. A session whose last answer cached nothing (a prompt under the provider's minimum cacheable size) has no countdown and is not refreshed.

**When warming ends** it stays ended until your next answer, the cache expires, and [compacting before expiry](#compacting-before-the-cache-expires) takes over as before. It ends, once, with the amounts in the footer, `/cache-keeper` and the log; the footer says it until your next message, muted where the rule ended it and marked `⚠` where something went wrong:

| Why | The footer, after the countdown |
| --- | --- |
| the budget | `keep-warm ended (budget reached): $1.98 spent, a miss costs $2.07`, without prices `keep-warm ended (budget reached): 10 of 10 refreshes` |
| the time limit | `keep-warm ended (2 h limit): $0.36 spent, a miss costs $2.07` |
| a refresh read less than 90% from the cache | `⚠ keep-warm ended (a refresh missed the cache): …` |
| a refresh failed | `⚠ keep-warm ended (a refresh failed): …` |
| the request can no longer be re-sent safely: the conversation changed, or the provider would not cap the answer | `⚠ keep-warm ended (the request can't be re-sent): …` |
| you switched the model or the branch, or the conversation was compacted (the extension no longer has the request to re-send), or what is read since disagrees with the period's lifetime or its route: the period is Pi's from then on | `keep-warm: Pi's (you switched model or branch, or compacted)`, `keep-warm: Pi's (the route's lifetime changed)`, `keep-warm: Pi's (the route changed)`, `keep-warm: Pi's (Pi's refresh wrote otherwise)`, `keep-warm: Pi's (the refresh wrote otherwise)` |

A new message that cancels a refresh in flight ends nothing: its answer starts a new period.

What that means at a cached-read price of 10% of the input price, for a break that starts when the last answer arrives and refreshes that read the whole context from the cache. A refresh then costs 0.1× the context's input price. A miss costs 1.15× with a cache-write price of 1.25× (Anthropic), which pays for 11 refreshes. With no cache-write price (OpenAI, Gemini) a miss costs 0.9×, and the one output token tips a 9th refresh over, so 8.

A miss on a 1-hour cache is priced as Pi prices it, at the model's ordinary cache-write price. Where the provider charges more for a 1-hour write (Anthropic: 2× the input price instead of 1.25×), the budget is smaller than what a miss there really costs, so warming a 1-hour cache stops sooner than a real miss would justify.

| Cache lifetime | A refresh every | With a cache-write price (11 refreshes) | With no cache-write price (8 refreshes) | With `keepWarmMinutes: 120` |
| --- | --- | --- | --- | --- |
| 150 s | 2 min 5 s | warm for 25 min | warm for 19 min | the same: the budget ends it first |
| 5 min | 4 min 35 s | warm for 55 min | warm for 42 min | the same: the budget ends it first |
| 30 min | 28.5 min | warm for 5.7 h | warm for 4.3 h | the limit ends it: 4 refreshes (0.4×), warm for 2 h 24 min |
| 1 h | 57 min | warm for 11.5 h | warm for 8.6 h | the limit ends it: 2 refreshes (0.2×), warm for 2 h 54 min |

On a 150-second cache the budget runs out within half an hour; on a 1-hour cache the time limit almost always comes first. With a long limit (6, 12 or 24 h) the budget is usually what ends the warming, and the limit only matters for long cache lifetimes. Without prices, the 10 refreshes keep a 150-second cache warm for 23 minutes and a 5-minute one for 51.

**When it refreshes.** 3 minutes before a 1-hour cache expires (5% of the lifetime, at least 25 seconds before expiry), the extension re-sends the last answer's request, as this extension saw it, with a one-token answer, the way Pi's warming does. The provider reads the cache entry and its lifetime starts again. It only refreshes when Pi is idle with nothing queued and the cached path is available (the same check as compacting from the cache). When Pi is busy or a message is queued at that moment, it tries again every second until the last safe moment, half that lead before expiry. In a period the extension took, the expiry comes from that period's own facts and nothing else, whoever warms it now: the time of the answer that started it (Pi stamps an answer when it starts streaming), or, once one of the period's refreshes reported a hit, the moment that refresh left, whichever is later, plus the shortest lifetime read since (at first the period's lifetime). Both are at or before the moment the provider renewed the cache, so the countdown is never later than the cache. Pi's own refreshes during a run, a slow preparation, or a refresh of an earlier period settling late move nothing, so the extension may refresh a little earlier than strictly needed, at times a few seconds after a refresh of Pi's at the end of a run; that refresh of Pi's is not counted in the period's budget. The footer (the countdown and the lifetime it marks "in use"), `/cache-keeper`, the refresh timer, the last gate and its last safe moment, compacting before expiry and its summary's last check all read this one expiry, at the moment they act. Where an answer streamed so long that this expiry's last safe moment passed before Pi went idle (more than about 4.8 minutes on a 5-minute cache), the extension can't prove a refresh would arrive in time: the period is Pi's (`keep-warm: Pi's (no time to refresh)`), and Pi's own warming, which may have refreshed during the run, goes on as with keep-warm off.

**It goes by the request, not by the setting.** The cache tier of a period the extension keeps warm is read from the request as this extension saw it, from every cache marker in it wherever it sits: Anthropic's `cache_control` (at the top level, on the system prompt, on tools, on messages), OpenAI's `prompt_cache_retention`, `prompt_cache_options` and `prompt_cache_breakpoint`, and Kimi's 1-hour option. A `cache_control` without a `ttl` asks for the default (short) tier and states no lifetime; a request with no marker at all asks for the provider's default cache. Only a marker that asks for the extended cache (Anthropic's `ttl: "1h"`, `prompt_cache_retention: "24h"`, Kimi's 1-hour option) makes it the longer tier. The retention setting is not consulted. Short and long are what the request asks for; how long a tier lasts is the route's (its model data); what an answer reports writing, Anthropic's 5-minute or 1-hour write, is evidence of a lifetime, never the name of a tier. So the period's tier is always the request's, and its lifetime is the request's: the one a marker states (`ttl: "5m"`, `"1h"`, OpenAI's and Kimi's values), else the route's data for the tier the request asks for, else the default of its format: 5 minutes for a `cache_control` without `ttl`, and for an Anthropic Messages request without any marker (a gateway may cache it on its own).

Two questions are kept apart, each with one owner. **When does this cache expire** is answered by the period's clock (`cache-clock.ts`) alone: it holds everything seen about the period's cache, asks `lifetime-evidence.ts` whether that agrees with the period's lifetime, and gives every reader and every request that costs money the one expiry above; it doesn't know who warms the period. **Who warms this period, and what Pi's warming is told** is answered by `warm-period.ts` alone: it doesn't see a lifetime or an expiry, only what the clock's reading says (evidence against the period, the cache lasting to the end of the time limit, and, for a period handed over to Pi, whether anything seen says the cache can still be alive). What the clock reads, for the period's model: what the period's own answer wrote; the model's latest write on the branch up to that answer; what Pi's refreshes wrote after it; what each of the extension's own refreshes of the period wrote; and the route's lifetime for the request's tier, read now. A write is evidence of an hour only where all of it went to the 1-hour cache, of five minutes only where none of it did; a write into both caches confirms neither and counts as the shorter.
- **Confirmation.** A lifetime the request doesn't state and that is not its format's default (a marker without `ttl`, or no marker, on a route whose tier lasts an hour) is the extension's only where the period's own answer wrote, all of it into the cache of that lifetime. An earlier answer's write doesn't confirm it (the route may have changed since: a gateway that fell back to an API key), nor does an answer that only read the cache: the period is Pi's (`route's lifetime unconfirmed`). A route lifetime no write can confirm (30 minutes for a marker without `ttl`) is always Pi's.
- **Against.** For a lifetime the request doesn't state: any write into a cache of another lifetime or into both, from any of those reports, and the route now giving the tier another lifetime. For a lifetime the request states: at the period's start, the route's data must be that lifetime, and the answer's write (or the model's latest before it) must be of it; after the start, only what shows a shorter lifetime is against (a 5-minute write, a write into both caches, the route now giving the tier less), since a cache that outlives the countdown is only refreshed early.
- **Formats whose answers report no breakdown** (OpenAI, Kimi) have no default of their own: a request without a cache marker goes by the data alone, which the extension can't check against the provider, needs no confirmation, and none of its answers or refreshes is ever against. A `cache_control` without `ttl` carried in such a request (some Chat Completions models are sent Anthropic's markers) has its marker's 5-minute default: on a route that gives its tier another lifetime it would need a confirmation such answers can't give, so the period is Pi's.

So a route whose short tier lasts an hour (a proxy on a Claude subscription login) is kept warm at the hour with `"cacheRetention": "short"` where the period's answer reports the 1-hour write; a route whose long tier lasts 7,200 s is kept warm at its short tier's hour for a plain marker answered with the 1-hour write. The extension also leaves a period to Pi when the request's markers ask for different lifetimes, or carry one written in a way it doesn't read. A lifetime the extension only assumes for a model family (OpenAI's 30-minute minimum, Kimi's 5 minutes or 1 hour) counts only on that provider's own API; through any other base URL the model needs a declared lifetime.

**Two refreshes in a row without a hit, then Pi.** A refresh that reads less than 90% of its prompt from the cache is a miss, however it ended (answered, failed, or cancelled by your next message), as long as the provider reported the prompt it read or wrote. A refresh that settled successfully without a prompt in its reported usage did not report what it cost; it counts as a miss does. A refresh cancelled or failed before it reported anything is no evidence either way and doesn't count. Either kind ends warming for that idle period only: the next period after a new answer is kept warm again as usual. The extension counts each model's refreshes in a row without a hit, misses and unreported ones in any mix, and a refresh that reads 90% or more from the cache sets the count back to zero. After two in a row on the same model, the extension stops keeping that model warm and leaves it to Pi's own warming, until you start it again with `/cache-keeper-warm` or Pi is restarted (`/new`, `/resume`, `/fork` and `/reload` keep it). That holds at once, also for a period that is already running: from then on the extension doesn't tell Pi's warming to stop, so Pi refreshes that cache as it would with keep-warm off. It tells you once, after the second refresh's own line, saying what the two were (`Two refreshes in a row without a hit for anthropic/claude-sonnet-4-6 (both missed the cache), so pi-cache-keeper stopped keeping it warm; Pi's own warming takes over. /cache-keeper-warm starts it again.`, or `(neither reported what it cost)`, or `(one missed the cache, one did not report what it cost)`), the footer says `⚠ keep-warm: Pi's after 2 refreshes without a hit (/cache-keeper-warm)` right after the countdown, `/cache-keeper` and the settings say so, all for as long as it lasts (with a countdown or without), and the log notes it once.

**One refresh after another, each only after a hit.** Inside an idle period the extension's refreshes are in one of three states, and only these events move them. *Waiting*: the next refresh may go out when it is due; once it passes the last gate and leaves, the period is *out*. *Out*: nothing else is sent for the period, whatever else happens (a run that sent nothing, Pi's own refresh from the run before landing, the 10-minute release below), until that refresh settles. If it reported a hit (a prompt, 90% or more of it read from the cache), however it ended afterwards (answered, failed, or cancelled by a run that sent nothing), the period is waiting again, with the expiry counted from when that refresh was sent. If it settled any other way, warming has *ended* for the period: a miss, a refresh that settled successfully with no prompt in its reported usage (what it cost is unknown, and a budget can't be kept with unknown costs: `keep-warm ended (a refresh reported no usage)`; in `/cache-keeper` and the log, "the refresh reported no usage, so what it cost is unknown"), or one that failed or was cancelled before it reported anything. Such a refresh doesn't move the expiry, which still counts from the answer, so compacting before expiry can follow within seconds; that summary reads from the cache, which the refresh wrote again. The budget, the time limit, a request that can no longer be re-sent, and a refresh that fails before it leaves (nothing sent) end it too, waiting or out. Once ended, only a new answer starts a new period, kept warm again as usual. A refresh that has gone out is never cancelled for being slow, nor sent again: it settles when it settles, and only your next message, a change of session or the connection's own failure ends it early. Its cost is counted at what it was reserved at until it reports what it cost.

**Never a refresh on top of one still on its way.** A miss is known only when its refresh settles. So while a refresh of a model is on its way, from any session of this Pi process, no other refresh of that model leaves: it is held, and tried again until its period's last safe moment, as when Pi is busy. One still open 10 minutes after it was sent stops holding the model back in other periods and sessions; if it then reports a miss after another refresh of that model went out, that other refresh can be one more miss. Its own period is still out: it waits for that refresh, however long it takes.

**What it can cost at most.** One refresh costs at most what writing the whole context again costs (the prompt at the cache-write price, or the input price where the model has none) plus its API's output cap: 1 token, 16 on `openai-responses`. That is what a missed refresh costs, or an unreported one the provider billed as a miss. The cut-off is two refreshes in a row that count, misses or successes that did not report what they cost: a cache lifetime that is wrong for a provider or a gateway, or a provider that never reports what a refresh cost, costs at most two such refreshes, then nothing until you start warming again, plus one more for each refresh still open 10 minutes after it was sent. What doesn't trip it: a route that alternates misses and hits is never cut off, since each hit sets the count back to zero, and pays a full write for each miss (each miss still ends warming for its period, so at most one per idle period). A refresh that fails or is cancelled before it reported anything isn't counted either; it ends its period, so it costs at most one such request per idle period, whatever the provider bills for it.

**Owned or left alone.** Where the model's prices make one refresh cost at least as much as the cache miss it would avoid (a cached read priced like an uncached one), the extension doesn't take the period: it is left to Pi's own warming from its start (`at this model's prices a refresh costs as much as a miss`). A period the extension takes, it refreshes. A period left to Pi from its start, for any reason, is read exactly as with keep-warm off: the countdown, the footer and compacting before expiry follow the same tier and lifetime. One the extension took is counted by its clock for the whole period, whoever warms it: the shortest lifetime read, from the period's own last fact ([below](#keeping-the-cache-warm)).

**What the period started with holds.** A period the extension keeps warm fixes, when it starts, the model, the tier its request asked for and the request's lifetime, and counts the expiry with that lifetime, or with a shorter one read since (below). Switching the retention later changes nothing for a request already sent. If what is read later no longer agrees with that lifetime (above: a proxy reporting an upstream whose tier lasts otherwise or nothing known, new model data, a refresh of Pi's or of the extension's that wrote into a cache of another lifetime), or the model changed, warming ends for the period without another refresh, the period is Pi's from then on (above: Pi's warming is no longer told to stop, but if it was told so earlier in the period it stays stopped), and the log says what: `the request's cache now lasts 5 min by the route's data, the cached request was written with 60 min`. It is asked when the period starts, on every check of the countdown (at least every 15 seconds), when Pi's warming asks, at the last gate before a refresh leaves, and when one of the extension's refreshes settles, its own report first: a refresh that read 95% from the cache and wrote the rest into the 5-minute cache is a hit for the budget, and still ends the period's warming. The shortest lifetime read (a write into both caches as the shorter, the format's default where the route gives the tier none) never rises again, also when the route's data gives the longer one back, and the period's countdown counts it from the period's own last fact: its answer, or when its latest refresh that reported a hit left. Never from when a refresh of Pi's was recorded: Pi's own refresh entries never move this expiry, before the hand-over or after, also for a period whose request was let go. Nothing is sent on a cache past that expiry. Where Pi's warming keeps such a period (handed over, or the model left to Pi after two misses) and its route has not been seen to change, the footer and `/cache-keeper` count down to the moment nothing seen, Pi's own refreshes included, says the cache the period's answer and Pi's refreshes wrote on that route is alive any more (`/cache-keeper`: `4m left by Pi's own warming …; nothing is sent on it`): an upper bound from what was seen, not a check of the provider. After a reported change of route both read cold (below): nothing is known of the other route's cache. Compacting before expiry still goes by the expiry above, so it sends nothing then. One limit: after a model switch away and back, the footer shows no countdown until the next answer (as on 0.5.3), while `/cache-keeper` counts the time Pi's warming gives.

**Where the expiry is unknown, nothing is sent.** It is unknown for the rest of the period in two cases: no lifetime can be read any more for a request that states none (the route's data gives its tier nothing); or a request of the period's model was served by another route than the one that served the period's answer, also when the first route is reported again later: a cache on one route says nothing about another's. The route is what a proxy reports served a request (`model-upstreams:answered`), kept for each model on its own and compared whole: every field of the report counts, so a subscription login and an API key of one upstream are different routes, also where they share model data; a report about another model never counts for this one, and a model switch keeps the reports. A report names no request, so it counts as the period's own only where it came while the period's request was out: after the extension saw that request leave and before its answer ended. That report is the period's route; where reports in that window differ, the period is Pi's from its start (`keep-warm: Pi's (the route changed)`). A report of the model after the answer ended and before Pi went idle may be another request's (a helper's, on another account): where it differs from the answer's own, or where none came for the answer, the period is Pi's from its start too. Where none came in the window and none after it, the route's configured upstreams stand in, and a later first report that differs from them reads as a change. So a proxy should report what served a request before its answer ends. The window gives timing, not a request: where the answer's own request was not reported, a lone report in its window can come from Pi's own warming, refreshing beside the answer on another account, and is then taken as the answer's route; that costs at most one refresh into a cold cache in that period. A provider no proxy describes never changes route. For a period the extension took, the countdown then reads cold, `/cache-keeper` says why (`counted as expired: the route changed`), whatever Pi's warming sent, and no refresh and no summary goes out on that cache: compacting before expiry doesn't start, a summary already being prepared is cancelled at its last check, and compacting for another reason (the context full, `/compact`) tries the cached path on the session's model, as for any cache whose expiry is unknown (up to 0.9.0 it used Pi's own compaction). With keep-warm on, this differs from 0.5.3 on purpose: where a gateway reports another route during a period (with Pi's refresh landing on it, say), 0.5.3 could still send a summary before expiry, which read the cache where Pi's refresh had just written the new route; now nothing is sent, and your next message after the cache expired pays to write the context again. A period the extension declined at its start for its route (`keep-warm: Pi's (the route changed)`) is read as with keep-warm off, as on 0.5.3: from its answer and the route's data, so its countdown can show time left on a cache the new route doesn't have, and compacting before expiry can send a summary that reads nothing from the cache. The period's facts hold only while the branch in front of you still holds its answer: after `/tree` to another branch the countdown is that branch's own, counted from that branch's answer and tier exactly as with keep-warm off, and nothing of the period left behind (its tier, its confirmed refreshes) carries over, also after keep-warm is switched off. Going back with `/tree` to a branch whose period was kept warm by refreshes, after another period started, counts from that branch's answer only, so its countdown can read cold while the refreshed cache still lasts.

**One gate before a refresh leaves.** Every refresh passes one last check, the only way out, after which it is only counted and sent. In this order, read afresh: it was not cancelled (a run started: nothing goes out or is counted, and it is tried again); keep-warm is still on in the settings; the period is the one it was started for and warming has not ended; the model is the period's, and everything read since agrees with its lifetime (`lifetime-evidence.ts`, above), else the period is Pi's from then on; Pi is idle with nothing queued (else withheld and tried again); the last safe moment has not passed; and the output limit is within the one proven for the API: 1 token for `anthropic-messages` and `openai-completions`, 16 for `openai-responses`. Anything else withholds it, and warming ends for the period with the reason. So a refresh that could generate a long answer never leaves, whatever led to it. The refresh is built with the thinking level its request shows it was sent with (thinking off where the request had none), so the provider builds the smallest limit.

**A cache that has expired is never refreshed.** A refresh then would write the whole context at full price. When the timer runs late (the computer slept), the countdown stops at expiry, and a refresh due in the last half of its lead (the last 12.5 seconds of a 5-minute cache) is not sent; the last check is made just before the request leaves, so one that couldn't leave in time is withheld.

Each refresh reads the whole context from the cache: about a tenth of the input price on Anthropic. In one measured session, a refresh of a 692k-token Claude context cost $0.14, against about $6.90 to write it again at that model's cache-write price. On a subscription it is free but counts toward your usage. Each refresh keeps its line in the transcript ([What it says](#what-it-says)); refreshes are listed in `/cache-keeper` and the log too, with what they have spent of the budget, and the footer shows `cache warm · refreshing` while one runs.

After a restart, the countdown doesn't know about refreshes sent before it, so it may show the cache as cold early.

### Stopping it in every window

`/cache-keeper-stop`, typed in any Pi window, stops the idle spending on cache warming in every Pi window on the computer, without changing a setting, and undoes itself: each window warms again as usual after its next message.

**The rule.** A stop ends warming, in every window open when it is given, for the idle period the window is in (for a window in a run, the period that run ends in), and for every idle period that starts there after it, until you send that window a message: the first real answer after that message starts an idle period that is warmed as usual. It is one more way a period's warming ends, beside the budget, the time limit, a miss and the rest, and it differs from them in three things: it comes from outside the period; it holds whoever warmed the period (the extension, Pi, or Pi after a hand-over), also with `keepWarmMinutes: 0`, where it stops Pi's own idle warming; and a new answer alone doesn't end it, only one that follows a message of yours.

**Your message** is what Pi calls user input (its `input` event): text typed and sent in the window, idle or into a run (steering, a follow-up); a skill command or a prompt template; a prompt, steering message or follow-up over RPC; and a message another extension sends in your name (`pi.sendUserMessage`), since a program that delivers a person's messages to Pi uses that call. Not your message: an extension's command (`/cache-keeper`, `/cache-keeper-stop`, `/cache-keeper-warm`, …), Pi's own commands that send no prompt (`/model`, `/compact`, `/tree`, `/reload`, `/new`, `/resume`, `/fork`, …), a `!` shell command, anything Pi or this extension sends by itself (a refresh, a summary, a retry), and another extension's custom message, even where it starts a run. So in a stopped window a run another extension starts brings an answer whose period is stopped from its start, and Pi's warming that the run started is told to stop when it asks. Your message whose run is cancelled before its first request, or whose request fails before it reported any cache use, leaves the window stopped until a real answer comes; the next real answer, whatever brings it, is warmed as usual. A message you type into a run after the stop ends it there. `/reload`, `/new`, `/resume`, `/fork`, a model switch, `/tree`, keep-warm switched on or off and the retention changed don't end it (with rare exceptions, see [Limitations](#limitations)); a Pi started after the stop isn't covered.

**What is sent.** Nothing of the extension's leaves from then on: a refresh being prepared is refused at its last gate, which reads the stop afresh, and nothing is reserved for it. Pi's own idle warming is answered `stop` the next time it asks while the window is idle, and stays stopped until the next request. Pi still warms during a run. A refresh already on its way is not called back (it is billed anyway, and cancelling would only lose its report): it settles as any refresh does, counted in the period's spending, a hit moving the period's expiry and a miss counting toward two in a row. Compacting before the cache expires still runs where it is on, under its usual conditions, and sooner than it would have, since the cache now expires at its current expiry: each large idle window sends one summary, which is what makes coming back cheap (in the measured session a 667k-token summary cost $0.19 against $5.33 to write that context again). After it the window stays quiet until your message: a summary is no answer and starts no period, the extension has let go of the request, and Pi's warming is started only by a request of the session's own, never by a summary.

**How every window learns of it.** The command writes `cache-keeper-stop.json` in Pi's agent directory, beside `settings.json`: a random id and the time it was given, written whole (a temporary file, then a rename), never deleted; the next stop replaces it. Each window remembers, for each of its sessions, which record was in place when your latest message reached it (kept for the Pi process, so `/reload` and `/new` keep it). A period obeys the record if it is not the one its window had seen when the period started. No clock is compared, so a clock set wrong, a Pi that crashed, or an old record can't stop a later period: every window that gets a message from you after the record was written has seen it. Each window reads the record before anything it sends from idle (the last gate, Pi's warming decision), when it goes idle, on your message, and on every tick of its countdown. So it obeys at once for what it sends, and its footer says `warming stopped` within a second where a countdown shows; a window without a countdown shows it the next time it reads the record. A record that can't be read stops the extension's refreshes (as unreadable settings do) and adds nothing to what Pi is told; `/cache-keeper` says it, and the next `/cache-keeper-stop` writes a good one.

**Every window** means every Pi process that uses the same agent directory (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`) and has loaded this version: all your Pi windows on the machine, also one on another machine that shares the directory; not another user's Pi, not a Pi with another agent directory, and not a window still running an earlier version (no `/reload` since the update).

**It can't be taken back.** Pi's own warming, once told to stop, starts again only with the next request, and no extension can start it. A take-back would work in some windows and not in others without the window giving it knowing which, so there is none: the undo is your next message in each window. `/cache-keeper-warm` does not lift a stop, and says so; `/cache-keeper-stop` given again stops again the windows that had a message since.

The command says what it did, in this window and for the others:

```
Warming is stopped in every Pi window that uses ~/.pi/agent, until each window's next message.
This window: the extension was keeping this idle period warm, and that has ended ($0.36 spent, a miss costs $2.07).
Other windows: each reads the stop before it sends anything, and its footer says "warming stopped" within a second where it shows a countdown. …
A refresh already on its way is not called back. A stop can't be taken back: a window warms again as usual after the answer to the next message you send it.
Compacting before the cache expires still runs where it is on (compactBeforeExpiry); it starts no warming again.
```

Each other window says once, when it learns of it, `Warming is stopped in this window until your next message: /cache-keeper-stop was given at 14:02.`, with its period's refreshes where the extension kept it warm. `/cache-keeper` adds a `stopped:` line, and the log has the end of warming (`keep-warm ended (stopped by /cache-keeper-stop), given at 14:02`) and each time Pi's warming was told to stop for it.

### What it says

The extension says in the transcript every refresh it sends and every issue it meets while keeping warm, at once, whatever Pi's `showCacheMissNotices` says. Each line is a record of the log said aloud: nothing is logged that is not said, and nothing is said that is not logged.

**Every refresh keeps its own line.** A refresh that was sent is said when it settles, as an entry saved in the session (a custom entry, which Pi draws with the extension's renderer and draws again after `/reload` or `/resume`; it is not sent to the model). In an idle period that is at most as many lines as the budget allows refreshes, within the time limit: one cache miss divided by one refresh, so it depends on the model's prices. At a cached read of a tenth of the input price that is 11 with a cache-write price of 1.25× and 8 without one; a model whose cached read is cheaper against its write gets more (48 for one whose cached read is 2% of its write price, `claude-fable-5-2` in Pi 1.6.0's catalog); without prices, at most 10. Its line is dim where it went well and in the warning colour where it did not:

| The refresh | Its line |
| --- | --- |
| read the cache | `Cache warmed (pi-cache-keeper, refresh 2): 99% of 600k from the cache, $0.18; $0.36 spent, a miss costs $2.07`, with ` Keep-warm ended until your next message (budget reached).` (or `(2 h limit)`) where it ended warming |
| read the cache, and wrote the rest into a cache of another lifetime | the same, then ` Keep-warm ended, and this idle period is left to Pi's own warming: <why>.` (warning) |
| read less than 90% from the cache | `Keeping the cache warm read only 12% of 600k from the cache, so it wrote the context again: $2.25; $2.43 spent, a miss costs $2.07. Stopped until your next message.` (warning) |
| reported no usage | `Keeping the cache warm: refresh 2 reported no usage, so what it cost is unknown; … Stopped until your next message.` (warning) |
| failed | `pi-cache-keeper could not keep the cache warm: <the failure>; … Stopped until your next message.` (warning), with what it read where it missed first; after a hit, `Cache warmed …. The request then failed: <the failure>` |
| was cancelled on its way | after a hit, `Cache warmed …. It was then cancelled by a new request or a change of session.`; after a miss, a warning with what it read; with nothing reported, `The cache refresh on its way (refresh 2) was cancelled by a new request or a change of session; it stays counted: …` |

**Everything else is a notice**, shown at once: `info` for the rule at work, a warning where something went wrong or money was spent without the cache being kept. A refresh held back because Pi was busy or an earlier refresh of the model had not settled (`Cache refresh held back: …`, once per expiry); one not sent because it was too late (warning, `The cache was not refreshed: too late, … It expires in 12s.`); warming ending without a refresh (`Keep-warm ended until your next message (budget reached): …`, `(2 h limit)`, `Keep-warm ended for this idle period: keep-warm was turned off; …`, and a warning for `(the request can't be re-sent): …` and for a refresh that failed before it left); a period handed to Pi's own warming (`Keep-warm ended, and this idle period is left to Pi's own warming: <why>; …`, a warning on evidence against its lifetime or route, `info` when you switched model or branch or compacted; `This idle period is left to Pi's own warming from now: <why>` where its warming had ended before); a session left to Pi from its start (`Keep-warm: this session is left to Pi's own warming: <why>`, once per reason, again after a period the extension took); Pi's own warming told to stop (`Told Pi's own idle warming to stop: <why>`); a stop, and the model left to Pi after two refreshes in a row without a hit. Nothing is said when the extension takes a period or when a stop ends: the footer says both. A notice that directly follows another `info` notice takes its place in Pi's transcript; warnings stay.

The extension's refreshes are not in Pi's session cost (the total in its footer): Pi counts the usage entries it writes itself, and an extension can't add usage to the session. Pi's own refreshes are counted there. The log, and each refresh's line, have the cost of each of the extension's refreshes.

### Which sessions it keeps warm

Keep-warm is off by default. Once it is on, this is who keeps an idle cache warm, with the default settings (Pi asks for the longer cache in interactive sessions) and Pi's own model catalog. Whatever the table says, a request whose cache markers don't fit one lifetime, a model with two refreshes in a row without a hit (until `/cache-keeper-warm`), and a model whose prices leave a refresh nothing to save, are Pi's (see above):

| Provider and request | Who keeps it warm |
| --- | --- |
| Claude on the Anthropic API (`anthropic`) | the extension: 1 hour (5 minutes with `"cacheRetention": "short"`); Pi when the request uses Claude's budget-based thinking |
| Kimi K3 on Moonshot's API (`moonshotai`, `moonshotai-cn`) | the extension: 1 hour (5 minutes with `"cacheRetention": "short"`) |
| GPT-5.6 and later on `openai` (Responses API), on OpenAI's own API with an API key | the extension, at 30 minutes, with either retention: the request's one 30-minute conversation marker asks for the default cache, and is compared with the model's lifetime for that (short) tier, 30 minutes without model data and with providers.dev's (30 minutes short, 12 hours long). **Pi** where, with the longer cache, the request carries two cache lifetimes (12 hours on the shared system prompt, 30 minutes on the conversation): the shared prompt is only added where the request starts with the system prompt, which with Pi's tools is `gpt-5.6-cyber`, `gpt-6-cyber` and the `gpt-daybreak` models (the others send their tools first). Pi also where a declared lifetime for the short tier is not the 30 minutes the request states. The same models through another base URL are Pi's unless they have a declared lifetime |
| GPT on `openai` through Pi's ChatGPT sign-in | Pi: that request carries no output limit |
| Other providers on the Anthropic Messages, OpenAI Chat Completions or OpenAI Responses APIs (OpenRouter, Vercel AI Gateway, opencode, Fireworks, GitHub Copilot …) | Pi, unless the model has a cache lifetime: from [providers.dev](#model-data-from-providersdev), from your `modelOverrides.promptCache`, or, where the provider's answer reports its write (any model on the Anthropic Messages API, through a gateway too), the 5 minutes or the hour of that write. Then the extension, when that write lasts as long as the request's lifetime and the request passes the checks above. A proxy on a Claude subscription login whose data gives the short tier an hour is kept warm at the hour with `"cacheRetention": "short"` too, where the period's own answer reports the 1-hour write (an answer that only read the cache is Pi's); where they report the 5-minute one (the proxy fell back to an API key), it is kept warm at 5 minutes when the proxy said the API key served it, and is Pi's otherwise. Pi when the request turns thinking on as `thinking: { type: "enabled" }`: Claude's budget-based thinking, and on Chat Completions DeepSeek, GLM, Kimi K2 and MiMo with thinking on |
| Claude through pi-claude-bridge, `openai-codex`, Google, Amazon Bedrock, Mistral and every other API | Pi |

"Pi" means Pi's own warming (`cacheWarming` in Pi's settings), exactly as with keep-warm off; the extension sends nothing for that session. `/cache-keeper` names the case for the session in front of you.

[docs/keep-warm-coverage.md](docs/keep-warm-coverage.md) has the count for every model in Pi's catalog, per provider and API, with each retention, with and without model data, and the reasons a session is left to Pi. `tests/keep-warm-matrix.test.ts` builds it with Pi's own adapters and checks every combination (a refresh never leaves uncapped or late; a session is kept warm or left alone, never in between); `npm test` fails when the document is out of date, and `CACHE_KEEPER_MATRIX=update npm test` writes it again.

## Model data from providers.dev

Pi's model catalog doesn't say how long most providers keep a prompt cache, and for some models its input window is smaller than what the provider accepts. Without a lifetime there is no countdown, no compacting before expiry and no warming; with a window that is too small, Pi compacts long before it has to.

[providers.dev](https://providers.dev) publishes both, with prices, for each model at each provider and access method (API key or subscription login), from the providers' documentation and from evaluations. The extension reads that and puts it into the `modelOverrides` of `~/.pi/agent/models.json`, the place Pi has for it. Pi's own warming and compaction then use the same numbers as the countdown here. [The footer](#the-footer) shows what was found for the current model, and `/cache-keeper` names the entry and the values.

| Value | What is written |
|---|---|
| Input window (`contextWindow`) | providers.dev's window replaces Pi's. A window that is only "the largest input an evaluation saw accepted" can raise Pi's and never lowers it |
| Cache lifetimes (`promptCache.short`, `promptCache.long`) | only for a tier Pi has no lifetime for. "No safe lifetime" is never declared |
| Prices (`cost`, with a tier per context size) and output limit (`maxTokens`) | only where Pi has none |

**Which value.** providers.dev gives one safe value per quantity, with the source it comes from and what every source states beside it. The sources come in a fixed order, and the first that states a value gives it: a measurement (on an API key, requests sent straight to the provider; on a subscription login, the vendor's own client, else a proxy), providers.dev's own reading of the provider's documentation, [models.dev](https://models.dev), and last Pi's own catalog. The extension takes the safe value as it is, except one whose source is Pi's catalog: that is Pi's own value as providers.dev last copied it, and written into `models.json` it would pin that copy over the value Pi ships, and keep it after Pi corrects it. Pi's own value stays in use there instead. An answer from an older API without safe values is read from its earlier fields instead.

**What you should know before it changes how Pi behaves:**

- A model that gets a cache lifetime also gets what comes with one: Pi's own warming (`cacheWarming` in Pi's settings) and this extension's countdown and compacting before expiry. A model with a 5-minute lifetime and a context over `minContextTokens` is compacted after about 5 idle minutes, unless Pi's warming or `keepWarmMinutes` keeps it warm; then it is compacted when that warming ends. A smaller context is left to expire.
- A larger window means larger, more expensive requests before anything compacts. `compactAtTokens` caps that on every model.
- On a subscription login, a cache lifetime is the one the vendor's own client held (Codex CLI on the ChatGPT login, Devin's CLI on Devin) where one was measured. Requests from Pi through the same login can be kept for less; providers.dev lists what each client held on the entry's page.
- Values you set in `models.json` yourself are never touched. The extension keeps a note of what it wrote (in `~/.pi/agent/cache-keeper-models.json`) and only updates or removes those values. If `models.json` has comments, it is left alone.

**How a model is looked up.** A provider you signed in to with a subscription is looked up as that subscription (the Claude and Meta logins have entries of their own); with an API key, as the API. Pi's ChatGPT sign-in on the `openai` provider has no entry of its own, so the login's and the API's values are both possible: the smaller is used and marked `⚠` (`⚠ no entry for this login: shorter values`).

### Through a proxy

Through a proxy (one pi provider that serves models of many labs), a model can come from a subscription login or an API key, and the two can differ: a Claude login keeps a cache for an hour, a Claude API key for 5 minutes by default. This extension knows no proxy. At the start of a session it asks over pi's event bus (`pi.events`), and a proxy's own extension answers where each of its models comes from:

- **`model-upstreams:request`** is sent by this extension.
- **`model-upstreams`**: `{ provider, models: { [modelId]: { upstreams, fallbacks? } } }`. `upstreams` are what may serve the model (several: not known which), `fallbacks` what may answer when those fail. An upstream is `{ provider, model?, subscription? }`: the pi provider the model would come from if used directly (`anthropic`, `openai-codex`, `openrouter` …) or a providers.dev provider pi has none for (`devin`, `antigravity`); the model's id there when it differs; `true` for a subscription login, `false` for an API key, absent when not known. The last answer is saved, for the next start; one that adds something to look up is fetched at once.
- **`model-upstreams:answered`**: `{ provider, model, upstreams }`, what answered a request. With keep-warm on, send it for each request while that request is out, before its answer ends: a report after an answer's end is not taken as that answer's, and a differing one, or any where none came for the answer, reads as a change of route (above). The countdown learns of a report at its next read, within 15 seconds. When that is not what the values are for (the login failed or is cooling down, or a login and a key take turns), the footer warns (`⚠ answered by an API key`), and the countdown and the values in the footer follow what answered. Pi's own warming keeps the values in `models.json`. Send `upstreams: []` for an answer whose route you can't name: it says this answer's route is unknown. For keeping warm that is a change of route, as a differing report is (a period that sees one is not refreshed again on that cache, and one whose own answer was unnamed is left to Pi's warming, `keep-warm: Pi's (the route is unknown)`), so nothing is warmed on a guessed route; for the values in the footer it is as if nothing had been reported, and the values are again those of what may serve the model. Two unnamed answers are never taken for one route.

A model is then looked up like the same model used directly. When several upstreams may serve it and their values differ, the smaller one is used (marked `⚠`); a value only some have is not used (`?`). A proxy model nobody spoke for gets no data. A shorter lifetime than the real one costs an early refresh or compaction; a longer one would let the cache expire unnoticed.

[pi-cliproxyapi-provider](https://github.com/ngvoicu/pi-cliproxyapi-provider) answers for [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI).

### Fetching, privacy, turning it off

**When it fetches.** At the start of an interactive session, when the saved data is a day old, was read by an earlier version of the extension, or Pi can use a provider there is no data for. One small request asks whether the dataset changed; if it did, the providers you can use are downloaded (a few dozen kilobytes). They are also downloaded if a provider is missing or the saved data was read by an earlier version, even when the dataset is unchanged. A failed fetch keeps the saved data, and [the footer](#the-footer) says so. Until a first fetch works, Pi has no cache lifetime from here, so a model whose lifetime only providers.dev gives (through a proxy, most of them) gets no countdown and is not compacted before expiry; compacting when full still works. Nothing is fetched on its own in print or JSON mode or with `PI_OFFLINE` set. `/cache-keeper-refresh` fetches now.

**What is sent.** The names of the providers Pi has credentials for, as query parameters to a public read-only API. No key, no account, nothing about your sessions or prompts.

**Turning it off.** Set "Model data from providers.dev" to off in `/cache-keeper-settings` (`"modelData": false`). The values the extension wrote are taken out of `models.json`, which brings Pi's own back, and the footer shows Pi's own values with nothing from providers.dev.

## Providers

| Provider | Cached compaction | Countdown and compact before expiry | Longer cache (interactive) |
|---|---|---|---|
| Claude via pi-claude-bridge | yes, on a copy of the Claude Code conversation | yes, 1 hour | Claude Code decides |
| Anthropic API | yes | yes, 1 hour | 1 hour instead of 5 minutes |
| Claude on opencode-go | yes | yes, 1 hour | 1 hour instead of 5 minutes |
| GPT-5.6+ on `openai` | yes, not tested live yet | yes, 30 minutes | 12-hour shared system prompt |
| GPT-5.6+ on opencode-go | yes | after you set the flag in `models.json` (below) | after the flag |
| Kimi K3 on `moonshotai` and `moonshotai-cn` | yes, not tested live yet | yes, 5 minutes or 1 hour | 1 hour instead of 5 minutes |
| Other Responses and Chat Completions APIs | yes | with a lifetime from providers.dev, or one you declare (`modelOverrides.promptCache`) | the provider's own |
| `openai-codex` (ChatGPT sign-in) | yes, not tested live yet | with the lifetime providers.dev has for the model; there's no documented one | no |
| Google and others | no, Pi's compaction runs | no | no |

**Claude through pi-claude-bridge.** These models run in Claude Code, so there's no HTTP payload for the extension to compare. Instead it sends the summary request with the bridge's `x-claude-bridge-fork: 1` header. The bridge runs it on a temporary copy of the live Claude Code conversation, which reads its cache, and then deletes the copy. The live conversation is only read. A bridge without fork support runs the request as a one-shot: the summary still works without the cache hit, and the card shows that. Claude Code keeps any tool result over about 50 KB as a file with a 2 KB preview, so for those the summary sees the preview, the same as the live model did.

Claude Code bills by subscription, so the bridge prices these models at $0. Here, compacting before expiry saves subscription quota and the slow first reply after a cold cache, not money. It also replaces the older part of the conversation with a summary well before Pi would compact a 1M-token model. If you'd rather keep the full context through long breaks, raise `minContextTokens` or turn it off. Claude Code also picks its own cache lifetime (1 hour on a subscription), so `cacheRetention` doesn't apply.

**GPT-5.6 and later.** With the longer cache, the system prompt and tools get a 12-hour cache under one key per project, so later sessions in the same project read them instead of writing them again. The conversation keeps OpenAI's 30-minute cache. The countdown follows the model's lifetime for the longer cache where the model data has one: with providers.dev's data that is 12 hours, the prefix's lifetime, so the countdown can show a conversation cache as warm after its 30 minutes have passed. Without model data it follows OpenAI's 30-minute minimum, and a session this extension keeps warm counts the 30 minutes its request asks for.

| | Pi alone | With the extension |
|---|---|---|
| System prompt and tools | each session writes them at 1.25×, and they last 30 minutes | written once at 2.5× and kept 12 hours; later sessions in the project read them at 0.1× |
| Conversation | 30 minutes | 30 minutes (for the countdown, see above) |

The 12-hour write costs an extra 1.25× of that prefix once, and the second session in the project that day earns it back. With a full set of extensions the prefix is around 19k tokens. Pi prices every cache write at the 30-minute rate, so its cost display understates the 12-hour part.

**Kimi K3 on Moonshot's API.** Kimi picks a cache lifetime of 5 minutes or 1 hour per request, and keeps a cache at the lifetime it was first written with. Pi doesn't send that option, so with the longer cache the extension adds it, and the countdown follows the lifetime it asked for. Pi's model catalog prices Kimi's cache writes at $0, so its cost display and the card leave them out. Kimi through opencode-go, OpenRouter, or Kimi For Coding keeps the host's own caching.

**opencode-go.** Pi doesn't send OpenAI's cache options to opencode-go's GPT models, so they get no 12-hour prefix and no countdown until you turn the options on. Add the flag to `~/.pi/agent/models.json` for each opencode-go GPT model that has it on `openai`, then pick the model again with `/model`:

```json
{
  "providers": {
    "opencode-go": {
      "modelOverrides": {
        "gpt-6-luna": { "compat": { "supportsExplicitPromptCacheMode": true } },
        "gpt-5.6-luna": { "compat": { "supportsExplicitPromptCacheMode": true } }
      }
    }
  }
}
```

Pi's own cache warmer only runs for models with a declared lifetime. If you want it to keep caches warm during long runs, add `"promptCache": { "short": 1800, "long": 1800 }` next to `compat`.

## What it costs

Pi's compaction keeps the last 20k tokens as they are and sends only what's older, as text with each tool result cut to 2,000 characters, at full price. This extension sends the whole session and pays the cache-read price (0.1×) for nearly all of it. So on small sessions, and on sessions that mostly read big files, Pi's is often cheaper: it has little to send. Once the older part is most of the session, which is usually the case when auto-compaction fires, reading everything at 0.1× costs less. The card shows both numbers every time, so you can see which case you're in.

The part that isn't cached is the instruction (about 400–600 tokens, depending on the model) plus anything added since the last request. That stays about the same size, so the cached share grows with the session: in the original author's tests 83% on a 2k-token session, 95% at 10k and 99% at 44k. For auto-compaction on a 200k model it works out to 99.7%. Auto-compaction can also fire in the middle of a run. Then the latest tool results are new too, but at that size they're still a small share.

![The cached compaction card as pi-cached-compaction showed it, measured for the original extension: "07:42:48 /compact: cached, 99% of 667k from cache, 3k out, 29.5s, summary 5791 chars. vs Pi's compaction: 86% less, $0.19 instead of ~$1.4 (it sends ~328k tokens, none from cache). 07:42:48 saved, 666k tokens summarized." The footer below it shows the original's countdown, "⏱ 59m", and "claude-opus-5-5 · high".](media/card-667k.png)

A real card from a 667k-token Opus 5.5 session, measured for the original extension (the footer is the original's): a subagent implementing a GitHub issue over 393 responses, replayed through pi-claude-bridge. Claude Code bills by subscription, so the bridge's own card compares tokens; the dollars here are the same token counts at Anthropic's API prices for Opus 5.5. Two things the card doesn't show:

- **The summary saw all the tool output.** Pi's compaction would have cut 109 of the session's 521 tool results to 2,000 characters, which drops 61% of the tool output before the model reads it. That output was already in the cache, so reading all of it is part of the $0.19.
- **The footer counts down to the expensive part.** At this size, letting the cache expire means your next message rewrites all 667k tokens, $5.33 at the 1-hour rate. If Pi is idle, the extension compacts 20 seconds before that.

Measured for the original extension, at the prices in Pi's model catalog. The Opus row is the session above, priced at Anthropic's API rates, and its Pi column is the card's estimate. The rest are GPT through opencode-go, where Pi's compaction was run too:

| Session at compaction | Pi's compaction | pi-cache-keeper |
|---|---|---|
| 667k tokens, a real coding session (`claude-opus-5-5`) | ~328k sent, ~$1.40 | 667k sent, 99% cached, $0.19 |
| 50k tokens, many small reads of source files (`gpt-6-luna`) | 26k sent, $0.0032 | 50k sent, 99% cached, $0.0013 |
| 44k tokens, ten whole docs read (`gpt-6-luna`) | 5.9k sent, $0.00090 | 44k sent, 99% cached, $0.00097 |
| 10k tokens, mostly long answers (`gpt-5.6-luna`) | 6.0k sent, $0.00224 | 10k sent, 95% cached, $0.00123 |
| 9k tokens, mostly long answers (`gpt-6-luna`) | 4.9k sent, $0.00087 | 8.8k sent, 94% cached, $0.00050 |
| 2k tokens, a few tool calls (`gpt-6-luna`) | 0.3k sent, $0.00009 | 2.2k sent, 83% cached, $0.00035 |

Where the two cost about the same, the difference is in what the summary was written from: the full tool output instead of 2,000-character excerpts.

## How it works

`/compact`, Pi's automatic compaction, compacting when full and compacting before expiry all go through the same checks. The cached path is taken only when all four hold:

1. Same model as the last request, and the conversation only grew since then. New messages and extension notices are fine. Edits, `/tree`, a model switch, or a context overflow are not.
2. The last request used the cache, and the cache hasn't expired.
3. The instruction can quote where the kept messages start (below).
4. The rebuilt request is identical to the last one up to the new part. This runs on the exact request Pi would send, using Pi's own serializer, so a different thinking level (on most models), an edited message, or a field another extension changed all count. Nothing is sent when it fails.

If any check fails, the [cold compaction model](#compacting-a-cold-cache-with-another-model) writes the summary where one is set and can, and otherwise Pi's own compaction runs. When compacting before expiry, nothing runs and the cache cools.

**Where the summary stops.** Pi keeps about the last 20k tokens of messages (its `keepRecentTokens` setting) word for word after the summary. The extension uses Pi's own cut point, so the summary has to stop where those messages begin. But the model reads the kept messages too, since they're part of the cached conversation:

![Where the summary stops. Messages 1 to K-1 are summarized, Pi keeps messages K to N word for word, and the new instruction says: Summarize what comes before the message starting with the text of message K.](media/summary-boundary.png)

So the instruction quotes the first kept message as the model sees it (and says which repeat it is, if that text appears more than once), says how many messages are kept, and tells the model to write the summary as if the conversation ended before the quoted one. In repeated tests where Pi's cut fell in the middle of a turn, no summary reported kept work as done. If the first kept message has nothing to quote (only an image, or only thinking), it doesn't guess: Pi's own compaction runs.

**Tools during the summary.** On the `openai` provider, the summary request sets `tool_choice: "none"`, which OpenAI keeps out of the cached prefix. Elsewhere changing it costs cache (on Anthropic it drops the message cache), so the model sees your tools and is told not to call them. If it calls one anyway, Pi's own compaction runs. In the tests no model tried.

## Limitations

The extension is built and checked for Pi with this extension and a provider extension. Another extension that changes requests after this one, or sends requests of its own on the same model, can make a refresh or a summary miss the cache: load this extension last.

- Without a known cache lifetime, the extension can't tell a cold cache from a warm one. A compaction after a long break then pays to rewrite the whole session. providers.dev fills in a lifetime where it has one ([Model data](#model-data-from-providersdev)); for other models, declare one with Pi's `modelOverrides.promptCache`.
- Through pi-claude-bridge the extension can't check the request. If the bridge can't copy the whole Claude Code conversation, the summary is still correct but reads less from the cache, and the card shows the low cache share. Keeping the cache warm doesn't work there.
- Fields that extensions loaded before this one add to provider requests are copied into the summary request, such as codex-fast's `service_tier`. Changes from extensions loaded after it aren't seen, so the request can miss the cache. The summary is still correct, it just costs about what Pi's compaction would, and the card shows the low cache share.
- When a later compaction falls back to Pi's own, its read and modified file lists start over. Pi doesn't carry the lists forward from an extension's compaction.
- When the second refresh in a row without a hit settles while a session is being replaced (`/new`, `/reload`), the one-time warning can be lost: the old session can no longer show it. The footer, `/cache-keeper` and the settings still show that the model is left to Pi.
- Another extension's long status ahead of this one in the footer can push the warning out of a narrow terminal's footer line; `/cache-keeper` always shows it.
- A refresh cancelled before it reported anything (your message started a run that sent nothing, say) ends warming for that idle period, and Pi's own warming, already told to stop, doesn't warm it either: that cache can expire before your next message.
- A refresh whose connection stays open after it was cancelled keeps its period out: until it settles the period neither refreshes nor compacts before expiry, so the cache can expire before your next message and that message can pay to write the whole context again.
- A `/tree` summary (or another operation that keeps Pi busy) that runs across a period's last safe moment and is then cancelled leaves that period unwarmed: the extension has told Pi's own warming to stop, and it sends nothing itself after that moment, so your next message can miss the cache (one miss at most).
- Compacting before expiry makes its last check a few milliseconds before the summary request reaches the network: after it, the extension still compares the request's prefix and Pi's adapter serializes the request. A summary whose preparation ends within those milliseconds of expiry can still leave and be read uncached. That is rare, and it costs at most one uncached summary.
- After `/tree` to another branch, the countdown and `/cache-keeper` are that branch's own, but the footer's tier label (`long 1h (in use)`) can keep the tier of the branch you left until the next answer or `/reload`.
- If the second refresh in a row without a hit settles after Pi's own warming was already told to stop for that idle period, Pi doesn't ask again, and that one cache is not kept warm by anyone until your next message.
- A keep-warm change (switched off, a shorter time limit) saved at the very instant a refresh leaves applies from the next refresh: the last check is made right before the request is handed to the network, and one that has passed it goes out.
- Keep-warm switched off and on again inside one idle period leaves that period unwarmed until your next message: the extension had already told Pi's own warming to stop for it, and its own warming ended when it was switched off.
- Keep-warm can only follow what it is shown. Three cases stay open: a route that changes silently, with no sign before the next refresh, costs that refresh a full write (warming then ends for the period, and after two in a row for the model; on Anthropic Messages the refresh's own answer reports the other cache and the clock follows). After a refresh that missed, on a format whose answers report no write breakdown (OpenAI, Kimi), the miss wrote the context again for a lifetime nothing reports, and compacting before expiry still counts from the answer with the data's lifetime: on a gateway that fell back silently from an hour to 150 seconds that summary is read uncached (0.5.3 does the same). A proxy that alternates silently between routes with caches of their own, never reporting which served, is not seen at all.
- Right after a compaction, the card is the session's last entry, and so can a refresh's saved line be after one (as Pi's own `cache_warm` usage entries are). A second `/compact` then says "Nothing to compact (session too small)" instead of "Already compacted". Both mean there's nothing new to compact.
- When a compaction falls back to Pi's own and its cut falls right after an entry that carries no message (a refresh's saved line, and equally Pi's own `cache_warm` usage entry, a label or a model change), Pi treats the turn before as split and, where there is earlier history to summarise, sends one extra summary request for it: about 7% more input in a three-turn case (none in a two-turn case). The summary is still correct. This is Pi's cut selection.
- A window that has not loaded this version (updated on disk, no `/reload` since) does not read a `/cache-keeper-stop`, and goes on warming.
- A window without a countdown shows a stop in its footer only when it next reads the record (Pi's warming asks, Pi goes idle, `/cache-keeper`); what it sends is checked against the record every time.
- A stop record that can't be read (damaged by hand or by the disk) stops the extension's refreshes in every window until `/cache-keeper-stop` writes it again.
- A run another extension starts with a custom message does not end a stop, so a window that only such runs keep busy stays unwarmed until you send it a message.
- A stop can, rarely, be undone in part. If Pi's own warming comes due while a `/reload` is loading the extensions, it sends a refresh, and one at each due time while a slow extension keeps the loading going. And if a message of yours has not brought an answer yet (another extension handled it, or its run sent nothing), `/reload`, `/new`, `/resume` or `/fork` lifts the stop before the next answer.
- A refresh that settles while a `/reload` is under way, or after `/new`, `/resume` or `/fork` replaced its session, may leave no saved line in the session. The log (`cache-keeper.jsonl`) keeps its record.
- The cold compaction model writes compactions only: `/tree` branch summaries still use the session's model.
- Virtual models and Claude through pi-claude-bridge can't be picked as the cold compaction model.
- A model that declares no context window can't be used as the cold compaction model; declare one in `models.json`.
- The cold compaction model gets one attempt: a request that fails is not retried, and Pi's own compaction follows.
- The cold compaction model's fit counts one token per byte of text: prose is counted about five times its size, so a model can be refused that would have fit.
- The cold compaction model sees what Pi's compaction sees, tool results cut to 2,000 characters, not the whole conversation the cached path reads from the cache.
- The footer says nothing about the cold compaction model; `/cache-keeper` does.
- A summary your session's model refuses is not told from any other failed summary request: the card shows the provider's words, not "quota".
- When Pi's own compaction fails for size and no cold compaction model is set, nothing suggests picking one.

## Origins and credit

pi-cache-keeper is based on [pi-cached-compaction](https://github.com/nicobailon/pi-cached-compaction) by Nico Bailon, released under the MIT licence, starting from its 0.2.0 release. Compaction from the warm cache, the compaction card, the cache countdown, compacting before the cache expires and the longer cache are his work, and his commits are kept in this repository's history. His releases are kept in [CHANGELOG.md](CHANGELOG.md) as he wrote them, and [LICENSE](LICENSE) carries his copyright line beside this project's. This is a separate project; it is not maintained by Nico Bailon.

Nico Bailon's 78-second explainer of the original extension (it uses the old name):

https://github.com/user-attachments/assets/04cec926-4eaa-411b-ad1c-33aba6109323

Added here since the fork (see [CHANGELOG.md](CHANGELOG.md)):

- compacting when the context is full (`compactAtPercent`) or at a token cap (`compactAtTokens`), with a summary sized to the model's window
- a settings menu (`/cache-keeper-settings`)
- a cache countdown that says what it means for cost (`cache warm · 59m left`, `cache cold · next message full price`) and keeps its place during a request
- keeping the cache warm while Pi is idle (`keepWarmMinutes`, off unless you set it)
- each model's input window, cache lifetimes and prices from providers.dev, `/cache-keeper-refresh`, and the `modelData` setting
- in the footer: the cache lifetimes and the one in use, what the last request asked for, the price, `sub` / `api` / `sub or api`, and what went wrong, fitted to the terminal's width
- warnings when an answer came from another kind of credential or values are guesses
- the `model-upstreams` events a proxy's extension answers, such as pi-cliproxyapi-provider

## Documentation

[docs/stop-warming.md](docs/stop-warming.md) is the design of `/cache-keeper-stop` and of what keep-warm says: the rule, what counts as your message, how every window learns of a stop, and the words of every notice.

[docs/live-tests.md](docs/live-tests.md) has every test run behind the numbers here: the cache share on each model, how close the card's estimate of Pi's compaction came, where the summary stops when Pi's cut falls mid-turn, Claude and GPT through opencode-go, and cache tiers through Claude Code.
