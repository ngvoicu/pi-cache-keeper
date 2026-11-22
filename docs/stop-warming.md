# Stopping warming in every window: `/cache-keeper-stop`

The design of 0.7.0, built. It was written against pi-cache-keeper 0.6.1 and Pi 1.6.0, and is meant for version 0.7.0. It says what the software is; the build chooses nothing about that. Where the build finds this document wrong, the document is corrected.

The ask: one command, typed in any Pi window, that stops the idle spending on cache warming in every Pi window on the computer, without changing a setting, and that undoes itself: each window warms again as usual after its next message.

A second ask is designed here with it, since both are about what a window says of its warming (section 5, "Notices"): the extension says in the transcript everything it meets while keeping a cache warm, each refresh it sends and every issue, and when a stop takes effect in a window.

One fix is in 0.7.0 too, beside the two asks: compacting before the cache expires is tried again where a try was only postponed (Pi busy, a message queued) while the cache lives, and once for each expiry the countdown reads, so an expiry Pi's own refresh moves gets its own try, also where that refresh lands while a compaction that then fails was running. It changes nothing in the stop: a stopped window still compacts before its cache expires, and the summary starts no warming (section 2).

## 1. The rule

**A stop ends warming, in every window that is open when it is given, for the idle period the window is in or the one its run ends in, and for every idle period that starts there after it, until the user sends that window a message: the first real answer after that message starts an idle period that is warmed as usual.**

An idle period is the README's: it runs from one answer to the next, where an answer is one that read or wrote the cache (a cancelled one included), or a successful one that used none. The stop adds no new kind of period and no new way for one to start. It is one more way a period's warming ends, beside the budget, the time limit, a miss, a failed or unreported refresh and a request that can't be re-sent, and it differs from them in three things only: it is given from outside the period; it holds for a period whoever warmed it (the extension, Pi, or Pi after a hand-over), also with `keepWarmMinutes: 0`; and a new answer alone does not end it, only one that follows a message of the user's.

A window is one session of one running Pi.

**The user's message** is what Pi itself calls user input, and nothing else: whatever reaches Pi's `input` event in that window.

| It is the user's message | It is not |
| --- | --- |
| text typed and sent in the window, while it is idle or while a run is going on (steering, a follow-up) | a command of an extension (`/cache-keeper`, `/cache-keeper-stop`, `/cache-keeper-warm`, …): Pi runs it and raises no `input` |
| a typed skill command or prompt template: it sends a prompt | a command of Pi's own that sends no prompt (`/model`, `/compact`, `/tree`, `/reload`, `/new`, `/resume`, `/fork`, `/session`, …) and a `!` shell command |
| a prompt, a steering message or a follow-up sent over Pi's RPC mode | anything Pi or this extension sends by itself: a refresh, a summary, a retry, a continuation of a run |
| a user message another extension sends in the user's name (`pi.sendUserMessage`): Pi shows it as typed, and a program that delivers a person's messages to Pi uses that call | a custom message of another extension, also where it starts a run (`pi.sendMessage` with `triggerTurn`): Pi calls it custom, not the user's |

Which periods a stop covers:

| The window, when the stop is given | What the stop covers there |
| --- | --- |
| idle | the idle period it is in, and every later one until the first that follows a message of the user's |
| in a run (a request out, tools running, a retry waiting) | the idle period that run ends in, unless the user sends the window a message before the run ends (a steering message or a follow-up typed after the stop is the user's next message). During the run nothing changes: Pi still warms during a run |
| in a run that then sends nothing (cancelled before its first request) | the period the window was in before the run, which goes on |
| opened afterwards (a Pi started after the stop) | nothing. It sends nothing before its first message anyway |

What ends it, per window:

| What happens in a stopped window | The stop there |
| --- | --- |
| the user's message, and its run brings a real answer | ended: the answer starts a new idle period, warmed as usual (by the extension where it takes the period, else by Pi) |
| the user's message, and its run is cancelled before its first request | holds for the period the window is in: no new period started (the README's "a run that sends nothing changes nothing"). The message was sent all the same: the next real answer, whatever brings it, starts a period that is warmed as usual |
| the user's message, and its request is cancelled or fails before it reported any cache use | the same: no new period. Pi's own warming started again with that request; when it asks while idle it is told to stop again |
| the user's message, and its answer is cancelled after it reported cache use | ended: that answer starts a new period |
| a run that no message of the user's started (another extension's custom message) brings a real answer | holds: the period that answer starts is stopped from its start. Pi's own warming, which started again with the run's requests, is told to stop when it asks while idle |
| a command that sends nothing (`/cache-keeper`, `/cache-keeper-settings`, `/cache-keeper-warm`, `/model`, `/tree`, …) | holds |
| `/compact`, or a compaction before the cache expires | holds, and nothing warms the window afterwards (section 2): a summary is not an answer and starts no period. The extension lets go of the period's request as it always does |
| `/reload` | holds: what the window remembers is kept across a reload (section 3). A reload does not cancel Pi's own warming, so this matters. Rare exceptions are kept as limits (section 13) |
| `/new`, `/resume`, `/fork` | holds until the user's first message there. Nothing is warmed in such a session before its first request anyway. A rare exception is kept as a limit (section 13) |
| keep-warm switched on or off, the retention changed | holds |
| a second `/cache-keeper-stop` | holds; windows that have had a message since the first one are stopped again |
| Pi is quit and started again | it is a window opened afterwards: not covered |

## 2. What an idle Pi sends, and what the stop does to each

Everything a Pi with this extension can send to a model provider without the user typing:

| Request | Who sends it, when | Under a stop |
| --- | --- | --- |
| The extension's refresh | the countdown's timer, shortly before the period's expiry, in a period the extension took (`keepWarmMinutes` above 0) | not sent. The period's warming has ended (`stopped`), so the timer starts none; one being prepared is refused at the last gate, which reads the stop afresh, and nothing is reserved or counted for it |
| Pi's own idle refresh | Pi's `CacheWarmer`, at 90% of the cache lifetime, for up to 30 minutes after the last request started (`cacheWarming: "idle"`). Before each one Pi asks `cache_warming_decision` | answered `{ action: "stop" }` the next time Pi asks while the window is idle. Pi's warming then stays stopped until the next request. This is the whole of the stop with `keepWarmMinutes: 0`, where only Pi warms |
| Pi's refresh during a run | Pi's `CacheWarmer` in its streaming phase, for up to an hour | not touched: it is not idle spending, and the run needs its cache. As today, the extension answers nothing while the window is not idle |
| A refresh already on its way | the extension's, once it passed the last gate; Pi's, once its decision was answered | not called back. It has left and the provider bills the prompt it reads; cancelling it would save nothing and lose its report. The extension's own settles as any refresh does: counted in the period's spending, a hit moves the period's expiry, a miss counts for "two in a row". At most one per window, and it is the last |
| Compacting before the cache expires | the extension, 20 s before expiry, for a context of at least `minContextTokens`, where `compactBeforeExpiry` is on: one summary request | not stopped, and it does not end the stop (below) |
| Compacting when the context is full | the extension, right after a turn | not touched: it follows a run, it is not sent from idle |
| The model data fetch | the extension, at a session's start when the data is a day old: one request to providers.dev, not to a model provider, and free | not touched |

Pi 1.6.0 sends no other model request from idle: the warmer's is its only timer that sends one, and its other timers draw the interface. Requests of other extensions are theirs; this stop knows nothing of them.

### Compacting before the cache expires: not stopped, and no new start

Decided by the maintainer, both halves.

**The stop does not hold it back.** With `compactBeforeExpiry` on, a stopped window still makes its summary 20 seconds before its cache expires, under the conditions it always had (Pi idle with nothing queued, Pi's auto-compaction on, a context of at least `minContextTokens`, the cached path available). A stop ends warming, and what follows the end of warming is what the README already says: "the cache expires, and compacting before expiry takes over as before". So "nothing is sent" is not what a stop means: each large idle window sends one summary, and sooner than it would have, because its cache now expires at its current expiry instead of after further refreshes (within the hour on a 1-hour cache, within five minutes on a 5-minute one). That summary is what makes the stop cheap to come back from: in the README's measured session a summary of 667k tokens cost $0.19, against $5.33 to write that context again with the next message.

**It does not end the stop.** After the summary the window stays quiet until the user's next message: no refresh by the extension and none by Pi for what the summary request wrote. This needs nothing new, and Pi offers all of it (read in Pi 1.6.0):

- *No new idle period.* A compaction is no run: Pi raises `session_compact`, no `agent_start` and no `agent_settled`, and the extension starts a period only when Pi goes idle after a run or at a session's start. The stopped period goes on, stopped.
- *Nothing for the extension to refresh.* At `session_compact` it lets go of the period's request, as after every compaction. A stopped period is not handed over to Pi for that (section 7: `onAgainst` stays).
- *Pi's own warming does not start again.* Pi starts its warmer in one place, the session's stream function, and only for a request that carries the session's own id (`dist/core/sdk.js`). The extension's summary request goes out through the model registry, not through that function; Pi's own summary request (after `/compact` where the cached path is not available) carries a routing id of its own. Neither starts the warmer. The run the warmer may still hold is for the last request before the summary, and a compaction replaces the transcript that run is tied to: at its next timer it ends by itself (`conversation context changed`) before it asks anything.
- *A run that follows by itself* (another extension's custom message) does start Pi's warmer, with its requests, and its answer starts a new idle period. That period is stopped from its start (section 1), so Pi is told to stop the first time it asks while idle, and the extension sends nothing.

## 3. How every window learns of it

No daemon, no socket, nothing but Pi and this extension: a small file every window reads before it sends, and one thing each window remembers.

### The record

`cache-keeper-stop.json` in Pi's agent directory (`getAgentDir()`: `~/.pi/agent`, or `PI_CODING_AGENT_DIR`), beside `settings.json`, `cache-keeper.jsonl` and `cache-keeper-models.json`:

```json
{"version":1,"id":"3f0c2a8e-5b1d-4c7a-9e42-1d6b8f0a7c55","at":1795183329000}
```

- `id`: a new random UUID for each stop (`randomUUID()`). It is the only thing a decision reads.
- `at`: the writer's clock when the stop was given, in milliseconds. For display only (`given at 14:02`); nothing is decided by it.
- Written as the model data store is: to `cache-keeper-stop.json.<pid>.tmp`, then renamed over the record, so a reader sees the old record or the new one and never half of one.
- Never deleted, never cleaned up. The next stop replaces it.

A reading gives one of three: the record; none (the file or its directory is not there); or unreadable, with the reason (it can't be opened, is not JSON, is not an object with `version` 1, a non-empty string `id` and a number `at`).

### What a window remembers

For each session of the Pi process: the `id` of the record that was in place when the user's latest message reached that session (none where there was no record). For a session that has had no message in this process: the `id` in place at the latest message to any session of the process, and before the first one, the `id` in place when the process first loaded the extension. It is kept on `globalThis` under `Symbol.for("pi-cache-keeper.stop-seen")`, as the per-model refresh counts are, so `/reload`, `/new`, `/resume` and `/fork` keep it and it ends with the process.

After the load it is sampled in one place: the extension's handler of Pi's `input` event, which Pi raises for exactly the messages of section 1 (typed, RPC, another extension's `pi.sendUserMessage`; idle, steering or follow-up), and for nothing else. The handler reads the record afresh, notes its `id`, and returns nothing, so the input goes on unchanged. A reading that is unreadable samples nothing: the window keeps what it had.

Two things Pi's `input` event brings with it, said plainly:

- An extension loaded before this one that answers an input by itself (`handled`) keeps it from this handler: it is not sampled. Nothing was sent to the model, so that is right.
- An input that reaches this handler and then sends nothing (an extension loaded after this one handles it; no model is selected; the run is cancelled before its first request) is sampled all the same. It changes nothing in the period the window is in (below); the next real answer, whatever brings it, starts a period that is warmed as usual.

Each idle period carries the value its session had when the period started (`seen`), set once. A period that goes on after a run that sent nothing keeps its own.

### The comparison

**A period obeys the record in place if that record is not the one its window had seen when the period started**: `record.id !== period.seen`. No record, no stop. Once a period obeys a record it is stopped for good (`stopped`, set once): only a new period is not.

This is why the cases of section 1 come out as they do. An idle window had seen an older record, or none, at the user's last message: its period obeys. A window in a run had its last message before the stop was written: the period that run ends in obeys, unless a message typed into the run since has sampled the stop's own `id`. A period that starts with no message since the stop (after another extension's run, after `/reload`) has the same `seen` as the one before it: it obeys from its start. After the user's message the session's value is the stop's own `id`: the period the next real answer starts does not obey it, nor do the ones after it. A Pi started after the stop samples it at load.

### Where the record is read

| Where | Reading | Why |
| --- | --- | --- |
| the last gate, before a refresh of the extension's leaves | afresh | nothing of the extension's leaves after a stop |
| `cache_warming_decision`, before Pi is answered | afresh | nothing of Pi's leaves from idle after a stop |
| every tick of the countdown (one a second), beside the settings | at most once per millisecond | the footer, and the period's own record of why its warming ended |
| when Pi goes idle (`session_start`, `agent_settled`) | afresh | a period is stopped from its start where no message of the user's came since the stop |
| the user's message (`input`) | afresh | the sample above |
| `/cache-keeper-stop` (after writing), `/cache-keeper`, `/cache-keeper-warm` | afresh | what they say |

The settings are already read and parsed on every tick; this adds one read of a file of some 80 bytes.

### How long a window takes to obey

- **For what it sends: no time.** Every request an idle window can send passes one of the first two rows, and each reads the record at that moment. From the moment the record is renamed into place, the only requests that still leave are the ones that had already passed their gate (section 2: at most one per window).
- **For what it shows:** within a second in a window whose footer shows a countdown. A window without one (a cold cache, no known lifetime) has no timer; it shows the stop the next time it reads the record for another reason (Pi's warming asks, Pi goes idle, `/cache-keeper`). It has nothing of the extension's to send, and Pi's warming is answered before it sends.

### Why an old record never stops a later period

- **Clocks.** None is compared. A window does not ask whether the stop is recent, only whether it is the record it saw at the user's last message. A clock set back or forward, two machines whose clocks differ, a record dated in the future: none of them can make a period obey or disobey.
- **A Pi that crashed.** The Pi that gave the stop has nothing to clean up, so its crash leaves nothing undone. The record stays until the next stop; every window that gets a message from its user, or is opened, after it was written sees that same record and does not obey it. A crash in the middle of a write leaves a `.tmp` file nobody reads.
- **Two users.** Each has their own agent directory; neither sees the other's record.
- **Two Pi configuration directories.** Each has its own record. A stop given in a Pi that uses one does not reach a Pi that uses the other.
- **An unreadable record** is the one case that is not exact, and it errs toward not spending. While a window reads the record as unreadable it treats it as it treats unreadable settings: the extension sends no refresh (the last gate refuses, `the stop record could not be read`, and the period's warming ends as `unable`), and the handler adds nothing to what Pi is told. A message sent while it is unreadable samples nothing, so if the same record becomes readable again, a period started meanwhile can obey a stop that was given before its message. The record is written whole by the extension only, so this needs a file damaged by hand or by the disk; `/cache-keeper` says it, and the next `/cache-keeper-stop` writes a good one.

### What "this computer" means

Every Pi process that uses the same agent directory and has loaded pi-cache-keeper 0.7.0 or later. It is the scope the settings already have ("a switch in any Pi window holds in every one"). So:

- all of one user's Pi windows on one machine, which is the case asked for;
- also that user's Pi on another machine, where the agent directory is shared between them;
- not another user's Pi, not a Pi started with another `PI_CODING_AGENT_DIR`, not a Pi in a container with its own agent directory;
- not a window that still runs an earlier version of the extension (updated on disk, no `/reload` since): it does not read the record.

The system's temporary directory was not used instead: it is per user on some systems and shared between users on others, and it is emptied by the system.

## 4. Taking it back

**It can't be taken back, and the command says so.** The undo is the one in the rule: the user's next message in the window.

What Pi allows, read in Pi 1.6.0: `CacheWarmer.refresh()` asks `cache_warming_decision` before each refresh; on `"stop"` it calls `stop()`, which clears the run and its timer. A run is created in one place only, `start()`, which the session's stream function calls for each request of the session (`dist/core/sdk.js`). There is no call that starts it again without a request, and none an extension can make. So Pi's own warming, once answered "stop", cannot start again inside that idle period. The README already says this of every other end ("Pi's warming stays stopped until the next request").

The extension's own warming could be started again inside a period it had taken, while the period's cache has not expired. A take-back built on that would work in some windows and silently not in others (not where Pi was the warmer and had already asked; not where the cache has expired since), and the window giving it could not tell which. So there is none:

- `/cache-keeper-warm` keeps its one meaning (the models left to Pi after two refreshes without a hit). It does not lift a stop, and where a stop holds in its window it says so (section 5).
- `/cache-keeper-stop` given again is harmless: it stops again the windows that have had a message since.
- A stopped period's `stopped` is set once and its warming's end is the state machine's `ended`, which nothing leaves.

## 5. What the user sees

### The command

`/cache-keeper-stop`, no arguments. It sits beside `/cache-keeper-warm`, which is why that command says it does not lift a stop. Its description in Pi's command list:

```
Stop keeping idle caches warm in every Pi window, until each one's next message
```

It writes the record, applies it to its own window at once, and prints (an `info` notice, one line each):

```
Warming is stopped in every Pi window that uses ~/.pi/agent, until each window's next message.
This window: the extension was keeping this idle period warm, and that has ended ($0.36 spent, a miss costs $2.07).
Other windows: each reads the stop before it sends anything, and its footer says "warming stopped" within a second where it shows a countdown. How many there are can't be known from here, and a window that has not loaded this version (no /reload since the update) doesn't read it.
A refresh already on its way is not called back. A stop can't be taken back: a window warms again as usual after the answer to the next message you send it.
Compacting before the cache expires still runs where it is on (compactBeforeExpiry); it starts no warming again.
```

The directory in the first line is the agent directory, written as the log's path is (`~` for the home directory). The last line is there only where `compactBeforeExpiry` is on. The second line is one of four, by the window's state before the command (the first that applies):

| The window | Second line |
| --- | --- |
| in a run | `This window: a run is going on; the idle period it ends in is stopped too, unless you send it a message first.` |
| already stopped | `This window: already stopped, since 14:02.` |
| idle, and the extension was the period's warmer (`the extension`, section 7) | `This window: the extension was keeping this idle period warm, and that has ended ($0.36 spent, a miss costs $2.07).` (the amounts as the footer says them; `3 of 10 refreshes` without prices) |
| idle otherwise | `This window: the extension was not keeping anything warm; Pi's own warming is told to stop the next time it asks.` |

Where the record can't be written, nothing is stopped anywhere, this window included, and it says (an `error` notice):

```
pi-cache-keeper could not write ~/.pi/agent/cache-keeper-stop.json: <the error>. Nothing was stopped.
```

### The footer

A stopped window says so with one part, muted, in the place of keep-warm's own muted part (the goal, `keep-warm ended (budget reached)`, `keep-warm: Pi's (…)`, `keep-warm: from your next message`), which is not shown while the stop holds:

```
cache warm · 41m left · warming stopped until your next message · long 1h (in use) · short 5m · sent 1h · api $3/$15 per M
```

- Narrower: `warming stopped`. It has the priority of the other keep-warm notes and is dropped where they are.
- It shows with keep-warm on or off: with `keepWarmMinutes: 0` it is the only thing the footer says about warming.
- It shows whatever the cache's state (`cache cold · next message full price · warming stopped until your next message`; after a compaction, where there is no countdown, it stands first), and on whatever model the window is on now: the stop is the window's, until its user's next message.
- Not while a run is going on: Pi warms during a run. After a run no message of the user's started, it shows again.
- Keep-warm's warnings stay beside it, since they are still true: `⚠ keep-warm: Pi's after 2 refreshes without a hit (/cache-keeper-warm)`, `⚠ keep-warm ended (a refresh missed the cache): …`.
- The countdown is not changed: it is the cache's time left, which the stop does not shorten.

The other windows (opened afterwards, or with a message since) show what they always show.

### `/cache-keeper`

One more line, right after `keep warm:`, only where there is something to say:

```
stopped: by /cache-keeper-stop at 14:02, until your next message: nothing is sent to keep this window's cache warm, and Pi's own warming is told to stop when it asks; compacting before expiry still runs; this idle period's refreshes: $0.36 spent, a miss costs $2.07
```

`; compacting before expiry still runs` is there only where `compactBeforeExpiry` is on, and the part from `; this idle period's refreshes` on only for a period the extension had taken. While the stop holds, the `keep warm:` line gives the rule alone (`up to 2 h after Pi goes idle; stops once refreshing has cost as much as one cache miss`, or `off`), followed as today by the line of a model left to Pi after two refreshes without a hit; where the period's warming had ended for another reason before the stop (a miss, the budget), that line stays as it was, since it is still true. Where the record is unreadable:

```
stopped: the stop record (~/.pi/agent/cache-keeper-stop.json) can't be read: <the reason>; the extension sends no refresh while that lasts, and /cache-keeper-stop writes it again
```

`/cache-keeper-warm`, where a stop holds in its window, ends its text with: ` A /cache-keeper-stop holds in this window until your next message; this command does not lift it.`

### Notices

The maintainer's rule: the extension shows a refresh that succeeded, one that did not, and every issue, always, whatever Pi's `showCacheMissNotices` says. Today it speaks only of a failure, a miss and a model left to Pi; everything else is in the footer and the log.

**The rule of the build: what is logged is said.** Every event the extension meets while keeping warm already ends in one `warm` record of the log, written through one function (`trace` in `index.ts`). Each such record now gets its notice there, worded by one function beside the one that words the log's line (`noticeOf` beside `describeTrace`, in `trace.ts`). So nothing is logged without being said and nothing is said without being logged, and the list of events below is the list of records. The few events that had no record get one (marked *new*). The stop's own notices have no record where the stop ended nothing of the extension's, and are said directly.

All of them are `ctx.ui.notify` notices, shown only where the session has an interface and is still alive, and none depends on a setting.

**How Pi draws them**, read in Pi 1.6.0, since the choice below rests on it:

- Pi's own line: after each refresh of its own that did not fail, its warmer appends a usage entry of kind `cache_warm` (in the session file and the session's cost), and the interactive mode draws it only where `showCacheMissNotices` is true: a dim line after a blank one, `Cache warmed: $0.210`; warms that follow each other are one line with their costs added up.
- An extension's `info` notice is drawn the same way, a dim line after a blank one, and **one that directly follows another `info` notice takes its place**: with nothing between them, the transcript keeps the latest.
- A `warning` is a line of its own in the warning color, `Warning: …`, and an `error` one in the error color, `Error: …`. Each stays.
- Over RPC every notice is sent to the client as it is; what the client draws is the client's.

**The levels.** `info`: the rule at work, and what the user did. `warning`: something went wrong, or money was spent without the cache being kept. `error`: a command could not do what was asked.

In the words below, `R` is what the refresh read, as the log has it without the output (`99% of 600k from the cache`); `C` its reported cost (`$0.18`, left out with its comma for a model without prices); `A` the idle period's amounts as the footer says them (`$0.36 spent, a miss costs $2.07`, without prices `3 of 10 refreshes`); `N` the refresh's number in its idle period.

*A refresh that was sent* settles in exactly one of these ways, and says it then:

| Event (the record) | Level | Words |
| --- | --- | --- |
| it read the cache (`warm`, a hit) | info | `Cache warmed (pi-cache-keeper, refresh 2): 99% of 600k from the cache, $0.18; $0.36 spent, a miss costs $2.07` |
| the same, and warming ended with it (the budget reached, the time limit) | info | the same, then ` Keep-warm ended until your next message (budget reached).` or `(2 h limit)` as the footer names it |
| the same, and what it wrote is against the period's lifetime (it read 95% and wrote the rest into a cache of another lifetime) | warning | the same, then ` Keep-warm ended, and this idle period is left to Pi's own warming: <the record's reason>.` |
| it read less than 90% from the cache (`missed`) | warning | `Keeping the cache warm read only 12% of 600k from the cache, so it wrote the context again: $2.25; $2.43 spent, a miss costs $2.07. Stopped until your next message.` Today's words, with what it read and cost. Also said for the second miss in a row, which today shows only the line below |
| it was answered without a prompt in its usage (`warm`, ended as `unknown`) | warning | `Keeping the cache warm: refresh 2 reported no usage, so what it cost is unknown; $0.36 spent, a miss costs $2.07. Stopped until your next message.` *Nothing is said today* |
| it failed without a hit (`failed`) | warning | `pi-cache-keeper could not keep the cache warm: <the failure>; $0.36 spent, a miss costs $2.07. Stopped until your next message.` Today's words, with the amounts. Where it had read under 90% before failing, ` It had read only 12% of 600k from the cache: $2.25.` is added |
| it failed after it had reported a hit (`failed`, a hit) | info | `Cache warmed (pi-cache-keeper, refresh 2): 99% of 600k from the cache, $0.18; $0.36 spent, a miss costs $2.07. The request then failed: <the failure>` *Nothing is said today* |
| a new request or a change of session cancelled it after it left (`cancelled`) | info | with a hit: the `Cache warmed …` line, then ` It was then cancelled by a new request or a change of session.`; with nothing reported: `The cache refresh on its way (refresh 2) was cancelled by a new request or a change of session; it stays counted: $0.36 spent, a miss costs $2.07`. *Nothing is said today* |
| the same, having read less than 90% | warning | `The cache refresh on its way (refresh 2) was cancelled by a new request; it had read only 12% of 600k from the cache: $2.25; $2.43 spent, a miss costs $2.07` |
| it was the model's second in a row without a hit | warning | today's notice, unchanged, after the refresh's own: `Two refreshes in a row without a hit for anthropic/claude-sonnet-4-6 (both missed the cache), so pi-cache-keeper stopped keeping it warm; Pi's own warming takes over. /cache-keeper-warm starts it again.` |

A cancelled refresh says nothing of warming having ended: the request that cancelled it normally brings a new period. Where that run sends nothing, the footer says the end, as today.

*A refresh that was due and not sent* (`skip` without an end; each is logged, and now said, once for the expiry it was due for, not on every try):

| Event | Level | Words |
| --- | --- | --- |
| Pi was busy or had queued messages when it was due, or got busy while it was being prepared | info | `Cache refresh held back: Pi is busy or has queued messages; tried again until the last safe moment.` |
| an earlier refresh of the model has not settled | info | `Cache refresh held back: an earlier refresh of this model has not settled yet, and it may have missed the cache; tried again until the last safe moment.` |
| too late: less than half the lead was left, at the timer or at the last gate | warning | `The cache was not refreshed: too late, less than half the warm lead was left before it expires (the computer slept, or Pi was busy until then). It expires in 12s.` |
| another refresh of the period is out; a run started before it left | none | nothing happened and nothing is logged: the refresh that is out says its own, and the run brings a new answer or the refresh is tried again |

*Warming ends without a refresh* (`skip` with an end, once per idle period):

| Event | Level | Words |
| --- | --- | --- |
| the next refresh would pass the budget | info | `Keep-warm ended until your next message (budget reached): <the record's reason>; $1.98 spent, a miss costs $2.07` |
| the cache already lasts to the end of the time limit | info | `Keep-warm ended until your next message (2 h limit): the cache lasts to the end of the 2 h limit after Pi went idle; $0.36 spent, a miss costs $2.07` |
| keep-warm was switched off, here or in another window | info | `Keep-warm ended for this idle period: keep-warm was turned off; $0.36 spent, a miss costs $2.07` |
| the request can no longer be re-sent, or was refused at the last gate (the conversation changed, the cache expired, no output limit within the proven one, the settings or the stop record can't be read, …) | warning | `Keep-warm ended until your next message (the request can't be re-sent): <the record's reason>; $0.36 spent, a miss costs $2.07` |
| it failed before it left (nothing sent) | warning | `pi-cache-keeper could not keep the cache warm: <the failure> (nothing was sent); $0.36 spent, a miss costs $2.07. Stopped until your next message.` |
| a stop | none here | the stop's own notice says it, with the amounts (below) |

*Who warms changes* (said when it changes):

| Event | Level | Words |
| --- | --- | --- |
| a period the extension kept warm is handed to Pi because what is read no longer agrees with its lifetime or its route | warning | `Keep-warm ended, and this idle period is left to Pi's own warming: <the record's reason>; $0.36 spent, a miss costs $2.07` |
| the same because its request was let go (a model switch, `/tree`, a compaction) | info | the same words |
| a period whose warming had already ended is handed to Pi (*new record*: today the footer alone changes) | as the two above | `This idle period is left to Pi's own warming from now: <the reason>` |
| a period is left to Pi from its start, with keep-warm on (*new record*, action `left`) | info | `Keep-warm: this session is left to Pi's own warming: <the full reason, as /cache-keeper gives it>`. Said when the reason is not the one last said in this session for this model, so once for a session that stays as it is and not after every answer; said again after a period the extension took. Not said where the footer says nothing either (no answer has used the cache yet) |
| Pi's own idle warming asks and is told to stop (`pi-stopped`) | info | `Told Pi's own idle warming to stop: <the record's reason>` (the extension keeps this period warm; nothing says a handed-over period's cache is alive; a `/cache-keeper-stop` holds) |
| the extension takes a period, or keeps one warm as before | none | the footer's goal says it (`keep-warm 2h until 16:40, …`); a notice after every answer would say nothing new |

*The stop command:*

| Event | Level | Words |
| --- | --- | --- |
| `/cache-keeper-stop` given | info | the command's text (above) |
| the record can't be written | error | `pi-cache-keeper could not write ~/.pi/agent/cache-keeper-stop.json: <the error>. Nothing was stopped.` |
| a stop takes effect in another window | info | `Warming is stopped in this window until your next message: /cache-keeper-stop was given at 14:02. This idle period's refreshes: $0.36 spent, a miss costs $2.07.` The second sentence only for a period the extension had taken. Once per stop and session: not again after `/reload`, nor for a later period that starts stopped; a later stop is said again where it stops a window that had a message since. Said when the window learns of the stop (section 3) |
| a refresh on its way when the stop came settles | as any refresh | its own line above |
| a refresh being prepared is refused because of the stop | none | the stop's notice has said it |
| Pi's own warming is told to stop for it | info | `Told Pi's own idle warming to stop: /cache-keeper-stop (given at 14:02) holds until your next message (Pi would have refreshed)` |
| the stop record can't be read | warning | where it ends a period's warming: the line of a refusal above (`… the stop record could not be read …`); `/cache-keeper` says it in every window |
| `/cache-keeper-warm` in a stopped window | info | its text, with the sentence above |
| the stop ends (the user's message, then its answer) | none | the user has just written to the window, and the footer changes back |

Unchanged, and outside this list: the notices of compacting (`Prompt cache expires in 20s … Compacting now, while the cache is warm.`, the card), of the model data and of a log that can't be written. Why a compaction before expiry did not start is still in the log only; if that is wanted on the screen too, it is the same build for the `expiry` records.

**Built: B.** The maintainer chose B (below): every refresh the extension sent keeps its own line, as a saved entry per refresh. A `warm` record that carries `refresh` (a refresh that left: its `warm`, `missed`, `failed` and `cancelled` records) is said as a custom entry of type `cache-keeper-refresh` with `{ level, text }` (`pi.appendEntry`), which the extension's entry renderer draws dim, or in the warning colour for a warning; every other record, and every issue, is a `ctx.ui.notify` notice at once, as the tables say. Both only where the session has an interface. This is Pi's own mechanism for a saved, drawn entry, and the path Pi's own warmer takes from idle (read in Pi 1.6.0): `appendEntry` → `SessionManager.appendCustomEntry`, which appends after the leaf and writes the session file, then `entry_appended`, which the interactive mode draws at once (`addCustomEntryToChat`) and again on reload (`renderSessionEntries` keeps `custom` entries), and which RPC forwards as a session event; Pi's `CacheWarmer` appends its `cache_warm` usage entry from idle the same way. A custom entry reaches no model (`buildSessionContext` skips it), Pi's warmer compares the agent's messages, not the leaf, and the extension's own path check counts `custom` as context-free, so a line on the branch changes no request and no refresh. As with the compaction card, a line as the session's last entry makes Pi answer a second `/compact` with "Nothing to compact" instead of "Already compacted". The words below are the entries' and the notices' alike; where they say an `info` line "takes the place of the one before", that now holds only for notices.

**Would a line for every refresh flood the screen?** Less than it looks, for three reasons that are the design's own:

- *The budget bounds it.* In one idle period the extension sends at most as many refreshes as one cache miss pays for; at a cached read of a tenth of the input price that is 11 where the write price is 1.25 times the input price, 8 where there is none, and 10 without prices; where the cached read is cheaper against the write, more (48 at `claude-fable-5-2`'s prices in Pi 1.6.0, whose cached read is 2% of its write price). A 5-minute cache is refreshed every 4 min 35 s until the budget or `keepWarmMinutes` ends it, whichever comes first: at the example prices the budget ends it after 11 refreshes, 55 minutes; at `claude-fable-5-2`'s it allows 48, so with a limit of 4 h or more refresh 48 comes at 220 minutes, and with the 2 h limit the limit ends it first. Then warming ends, with one line.
- *Pi keeps one `info` line.* Successes and hold-backs are `info`, and Pi draws each in the place of the one before while nothing else comes between (any `info` notice does that, also another extension's, and the extension's own line before a compaction). An idle window therefore ends with one line, the latest, and that line has the refresh's number and the period's sum: `Cache warmed (pi-cache-keeper, refresh 11): …; $1.98 spent, a miss costs $2.07`. What it replaced is in the log, line by line.
- *What repeats is said once*: a hold-back once per expiry, a session left to Pi once per reason, a stop once per window.

What does pile up: warnings, which each stay; there is at most one end of warming per idle period, so at most one or two per break. And a window that is written to all day has one idle period per answer, so a line wherever a pause was long enough for a refresh; that is the thing asked for.

The choice, which is the maintainer's (B was chosen):

| | What the transcript shows | What it takes |
| --- | --- | --- |
| A. One replacing `info` line | each refresh when it settles; the latest stands in place of the one before, with the number and the sum; every issue stays | nothing beyond Pi's own way of drawing an `info` notice. It rests on that way: a Pi that drew them otherwise would show each line |
| **B. Every refresh keeps its line (built)** | as many lines per idle period as the budget allows refreshes, each with its own cost: 8 to 11 at the example prices, more where the cached read is cheaper against the write (48 at `claude-fable-5-2`'s prices in Pi 1.6.0), at most 10 without prices | a saved entry per refresh (`pi.appendEntry` with a renderer, as the compaction card is): written into the session file from an idle window, drawn again after a reload, and a card as the session's last entry already changes what Pi answers to `/compact` |
| C. One line per idle period | a summary when warming ends or the next message comes (`Kept the cache warm 7 times: $1.26 spent, a miss costs $2.07`); issues at once | less on the screen than was asked: a refresh is not said when it happens |

### The log

No new kind of record. Two existing ones say it:

- Where the stop ended the warming of a period the extension had taken: a `warm` record with `action: "skip"`, `stop: "stopped"`, `reason: "given at 14:02"`, the period's `budget`, and the period's model. It reads `14:02:10 cache expires in 2400s: keep-warm ended (stopped by /cache-keeper-stop), given at 14:02; $0.36 of $2.07 (one cache miss) spent`.
- Where Pi's own warming asked and was told to stop for it: a `warm` record with `action: "pi-stopped"` and `reason: "/cache-keeper-stop (given at 14:02) holds until your next message (Pi would have refreshed)"` (or `stopped`), with the `budget` only where the period has one. It reads `14:06:31 told Pi's own idle warming to stop: /cache-keeper-stop (given at 14:02) holds until your next message (Pi would have refreshed)`.

The first is written once per period (a period that starts stopped, after a run no message of the user's started, writes its own); the second each time Pi asks and is told, which is once for each request that started Pi's warming. A window in which neither happened logs nothing: nothing was stopped there. A compaction before expiry in a stopped window is logged as it always is.

## 6. What it does to the rest

| | In a stopped period |
| --- | --- |
| The budget | what was spent stays counted, and nothing more is spent. A refresh on its way when the stop came is counted at its reserve until it reports, as always |
| The time limit | no longer declared: the period's warming has already ended |
| Two refreshes in a row without a hit | the counts are not touched. A refresh on its way that settles as a miss counts, and can be the second: the model is then left to Pi as usual (the notice, the footer's `⚠`), for later periods. This period stays stopped. `/cache-keeper-warm` clears the counts as before |
| The per-model hold | a refresh on its way still holds the model's other refreshes back, in other sessions of the process, until it settles or 10 minutes pass |
| The countdown | unchanged: the period's clock where the extension took the period, the plain reading otherwise, down to `cache cold · next message full price`. A hit reported by a refresh on its way moves it. Where Pi had been warming a period handed over to it, the countdown and `/cache-keeper` go on showing the time Pi's last refresh gives, as they did before the stop |
| Compacting before expiry | as after any end of warming: 20 s before the period's expiry, with its own conditions and its own last check (section 2). Where a refresh was on its way when the stop came, it waits for that refresh to settle, as always |
| After that summary, or a `/compact` | the window stays stopped: no period starts, the request is let go, there is no countdown, and neither the extension nor Pi sends a refresh (section 2). The footer says `warming stopped until your next message` |
| A route that changes, a lifetime that can no longer be read | read as before: the expiry is unknown and nothing is sent on that cache. A stopped period is never handed over to Pi on such evidence, as a period ended on its budget is not: Pi's warming stays stopped |
| The request let go (a model switch, `/tree`, a compaction) | as before; the period stays stopped and is not handed over |
| Keep-warm switched off or on | nothing: the period's warming has ended, and the stop holds either way |
| The next period | started by the next real answer, with a new budget and time limit: warmed as usual where a message of the user's came since the stop, stopped from its start otherwise |

## 7. The software

One new module; one more value in each of the two places that already own these questions; the rest is `index.ts` asking them.

### `stop-record.ts` (new)

The only file that names the record's path, reads it or writes it, and the only one that holds what a window remembers.

```ts
/** A stop as it is recorded: `id` is what is compared, `at` is for display only. */
export interface StopRecord { readonly id: string; readonly at: number }
/** One reading: the record, none (no file, no directory), or why it can't be read. */
export type StopRead = StopRecord | null | { readonly unreadable: string };

/** `cache-keeper-stop.json` in Pi's agent directory, with `~` for the home directory (as `modelsPathLabel` is). */
export function stopPathLabel(): string;
/** The agent directory, written the same way: what the command names as its reach. */
export function agentDirLabel(): string;

/** Reads the record. Never throws. */
export function readStop(): StopRead;
/** Writes a new record (a new random `id`, `at` as given), whole: a temporary file, then a rename. Throws where it can't. */
export function writeStop(at: number): StopRecord;
/** Whether a period whose window had seen `seen` (a record's id, or none) obeys `record`: its id is not `seen`. */
export function covers(record: StopRecord, seen: string | null): boolean;

/** Called once per load of the extension, first thing: on the first call in a process, samples the record in place. */
export function rememberLoad(): void;
/** The user's message reached the session with `id` in place (null: no record). */
export function noteMessage(session: string, id: string | null): void;
/** What the session had seen at the user's last message; else what any session of the process had at the latest one; else at load. */
export function seenFor(session: string): string | null;
/** Whether the stop `id` is said in this session for the first time; true once per session and id, and it remembers. */
export function firstSaid(session: string, id: string): boolean;
```

`writeStop` uses `writeAtomic` of `model-data.ts`, exported for it, and `randomUUID` of `node:crypto`. `rememberLoad` samples `null` where the record is unreadable. The path is read from `getAgentDir()` at each call, as `model-data.ts` reads its own.

### `trace.ts`

`WarmStop` gains `"stopped"`; `stopLabel("stopped")` is `stopped by /cache-keeper-stop`. Records written before read as they did.

For the notices, `WarmTrace` gains what a notice needs and the log did not have, all optional, and one action:

```ts
/** On the record of a refresh that left: its number in its idle period, and what its reported usage showed. */
refresh?: number;
verdict?: "hit" | "miss";
/** On a `skip` without an end: why the refresh that was due did not leave. */
hold?: "busy" | "settling" | "late";
/** On the record where a period changes hands: why it is Pi's from now. */
handedOver?: "evidence" | "let go";
/** New action `"left"`: a period left to Pi from its start, written when the reason changes; `reason` is the period's `notOwned`. */
action: "warm" | "missed" | "failed" | "cancelled" | "skip" | "pi-stopped" | "left";

export interface Notice { readonly level: "info" | "warning"; readonly text: string }
/** What a `warm` record says in the transcript (section 5), or nothing. `limit` names the time limit, as for `stopLabel`. */
export function noticeOf(record: WarmTrace, limit?: string): Notice | undefined;
```

`describeTrace` words the two new records: `14:02:10 keep-warm: left to Pi's own warming, <reason>` for `left`, and `14:02:10 cache expires in 2400s: left to Pi's own warming from now, <reason>` for a `skip` with `handedOver` and no end. `noticeOf` returns nothing for a record whose `stop` is `stopped` and for a `skip` that has neither an end, a `hold` nor `handedOver`. It takes the words of section 5 from the record alone: the amounts from `budget`, what was read and the cost from `usage`. The one end it tells by its reason is a switch-off: `trace.ts` exports `SWITCHED_OFF = "keep-warm was turned off"`, which `index.ts` uses where it writes that reason today.

### `warm-period.ts`

It stays the only owner of who warms a period and the only place `"stop"` is written.

- The phase table gains nothing but a word: `waiting, out | budget, time limit, unable, stopped (end) | ended`. `end(state, "stopped", reason)` is the existing function; from `out` it keeps the refresh that is out, so a hit it still reports counts for the cache.
- `Warmer` gains one value, and `warmer` one input, read first:

```ts
export type Warmer = "the extension" | "nobody" | "nobody, stopped" | "Pi" | "Pi, handed over";
export function warmer(p: { stopped: boolean; taken: boolean; on: boolean; fellBack: boolean; handedOver: boolean; warm: WarmPhase }): Warmer;
```

| `warmer` | When |
| --- | --- |
| nobody, stopped | the period obeys a stop, whatever else holds: taken or not, keep-warm on or off, left to Pi after two misses, handed over |
| the others | as today, where it does not |

- `answerToPi`: `"stop"` for `nobody, stopped` while the window is idle; nothing while it is not. (The existing lines already give this; its comment and its test say it.)
- `onAgainst`: `stays` for `nobody, stopped`.

### `footer.ts`

`FooterView` gains `stopped?: boolean`. In `footerParts`, after keep-warm's warning part and the data warnings, where keep-warm's muted part is pushed today (the goal beside a cache that is not warm, else the part that is not a warning): where `stopped`, the part `warming stopped until your next message` / `warming stopped`, muted, priority `warmNote`, is pushed in its place and neither of those is. Keep-warm's warning part, pushed earlier, is not touched. `ENDED_SHORT` gains `stopped: () => "stopped"` (the type asks for it; the part it words is never shown, since the stopped part stands in its place).

### `index.ts`

| Place | Change |
| --- | --- |
| the factory's first line | `rememberLoad()` |
| `WarmPeriod` | `seen: string \| null`, set once in `goIdle` from `seenFor(session id)` when a period is made (a period that goes on keeps its own); `stopped?: { id: string; at: number }`, set once by `obeyStop` |
| `stopRecord(fresh = false): StopRead` | beside `keepWarmSetting`, and like it: one reading per millisecond, `fresh` reads again |
| `obeyStop(ctx, fresh = false): void` | the only place a period becomes stopped. Nothing while there is no period, a run is going on, or the period is already stopped. It reads the record; where it is a record and `covers(record, period.seen)`: sets `period.stopped`; for a period the extension took (`taken`, whoever warms it now), ends its warming with `endWarm(p, "stopped", "given at HH:MM")` (the time as `fallbackLine` writes one) and, where that ended it, writes the one `skip` record of section 5 (seconds left from `look(ctx).sendBy`, the model from the period's `fixed`, the period's budget); then renders the footer; then, where `firstSaid(session id, record.id)` and the session has an interface, the notice of section 5 (the amounts where the period was taken). So a stopped period that was taken has always ended its warming |
| `warmerOf` | passes `stopped: p.stopped !== undefined` |
| `session_start`, `agent_settled` | `obeyStop(ctx, true)` right after `goIdle` |
| the countdown's `tick` | `obeyStop(ctx)` first, before the cache is read |
| `input` (a new handler) | reads `stopRecord(true)` and, unless it is unreadable, `noteMessage(session id, its id or null)`; returns nothing. For every source and every `streamingBehavior`. The only call of `noteMessage` |
| `owns` | true also for `nobody, stopped` where the period was taken: it has the budget, the fixed values and the clock the guard promises. So keep-warm's view of a stopped period is the one it had (a warning stays a warning), and a stopped period is never refreshed: `obeyStop` has ended its warming |
| `lastGate` | after `period !== p`, before `p.ended`: where `stopRecord(true)` is unreadable, `{ refuse: "the stop record could not be read" }`; else `obeyStop(ctx, true)`. A period it stopped is then refused by the existing line (`keep-warm ended: given at HH:MM`), nothing is reserved, and the refresh's own record says it was withheld, as for any refusal |
| `cache_warming_decision` | `obeyStop(ctx, true)` after the settings are read, before the cache is read (so a stopped period is not handed over at the same decision). The handler returns the action whenever `answerToPi` gives one, also for a period without a budget, and its `pi-stopped` record takes its reason from the warmer (section 5 for `nobody, stopped`) and carries a budget only where the period has one |
| the countdown's `shown`, `/cache-keeper`'s reading of a cache Pi keeps | `nobody, stopped` is read as Pi's periods are: the cache lasts as long as anything seen says, Pi's refreshes before the stop included |
| `renderFooter` | passes `stopped: period?.stopped !== undefined && !running` |
| `keepWarmNote` | for a stopped period, while no run is going on: where its warming had ended for another reason than the stop, as today; otherwise the rule alone, followed as today by the line of a model left to Pi after two refreshes without a hit |
| `/cache-keeper` | `obeyStop(ctx, true)` first; the `stopped:` line of section 5 |
| `/cache-keeper-warm` | `obeyStop(ctx, true)` first; the sentence of section 5 |
| `/cache-keeper-stop` (new) | notes the window's state (a run going on, already stopped, the period's warmer); `writeStop(Date.now())`; on failure the error notice and nothing else; else `firstSaid(session id, its id)` (so `obeyStop` says nothing of it here), `obeyStop(ctx, true)` and the command's text of section 5 |
| `say(ctx, notice)` (new) | the one door of the notices of this section: `ctx.ui.notify(notice.text, notice.level)` where the session has an interface; it never throws (a session that is gone says nothing) |
| `trace` | (built for B) after a `warm` record is written: its notice, `noticeOf(record, keepWarmLabel(warmMinutes()))`, kept as the refresh's saved line (`keepLine`, a `cache-keeper-refresh` entry) where the record carries `refresh`, else `say`; formerly: `say(ctx, noticeOf(record, keepWarmLabel(warmMinutes())))` where there is a notice. The only call of `noticeOf` |
| the refresh's settlement in `keepWarm` | its records carry `refresh` (the period's count when it left) and `verdict`; the two notices it shows today, of a failure and of a miss, are taken out, since `trace` now says them; the notice of two refreshes in a row stays where it is, after the record |
| the `skip` records of a refresh that was due | carry `hold`: `busy` (both wordings), `settling`, `late` (both wordings) |
| `changeHands`, `handTo` | what `changeHands` returns carries `handedOver` wherever the period changes hands, so every record it reaches has it; where a period changes hands without its warming ending (it had ended before), `handTo` writes the new `skip` record with the reason and `handedOver`, unless the caller takes it |
| `noteLeft(ctx)` (new) | called right after `obeyStop` in `session_start` and `agent_settled`. A period the extension took clears what the instance remembers. For a period that is not taken and not stopped, with keep-warm read on at its start and a label for the footer (`notOwnedLabel`): where `model + label` is not what this instance last said, it writes the `left` record (the reason is the period's `notOwned`) and remembers it |
| `obeyStop`, `/cache-keeper-stop` | their notices go through `say` |

Nothing else changes: who takes a period, the clock, the budget, the gate's other checks, compacting before expiry and its last check, what a compaction does to the period (`forget`), the settings and `config.ts` are as they are. `agent_start` is not touched: a run is not what ends a stop. `index.ts` still writes no `action: "stop"` of its own, sends in two places, and reads the period's starting lifetime in one place.

## 8. Tests

The repository's own kind: `node --test`, the harness of `tests/keep-warm-flow.test.ts`, Pi's real `CacheWarmer` beside the extension where a case needs it, the global `fetch` throwing. "Another window" is what it already is in those tests for the settings: the file written in the test's agent directory by the test (here through `writeStop`), since a window is a process and the record is all that passes between two.

**No test against a real provider, and none is added to `docs/live-tests.md`.** The stop sends nothing and assumes nothing about a provider that is not assumed already; what it relies on in Pi (the decision is asked before each refresh, "stop" holds until the next request, a reload keeps the warmer, a compaction starts none, `input` is raised for the user's messages and for nothing else) is checked against the installed Pi's own `CacheWarmer` and extension runner. `docs/live-tests.md` gains one line under "Not yet tested live": the command across two real windows, with the steps (two windows on a cheap model, a message in each, `/cache-keeper-stop` in one; both footers say `warming stopped`; `/session` in the other shows Pi's warming stopped by an extension once it has asked; a message in either brings its keep-warm line back).

`tests/stop-record.test.ts` (new):

- written and read back; two writes have different ids; no `.tmp` file is left; a leftover `.tmp` is not read.
- no file and no directory read as none; an empty file, text that is not JSON, an array, another `version`, a missing or empty `id`, an `at` that is not a number read as unreadable, each with a reason; `readStop` never throws.
- `covers`: the same id no, another id yes, none seen yes.
- what a window remembers: the first load samples the record in place, a later load does not sample again; a session's own message; a session without one takes the latest of any session, else the load's; an unreadable record at load samples none; it is the same after the module is loaded a second time in the process.

`tests/warm-period.test.ts`: `stopped` in "who warms: every combination" (always `nobody, stopped`); what Pi is told for it (stop while idle, nothing while busy); `onAgainst` stays; `end(…, "stopped")` from waiting and from out, where a hit of the refresh that was out still counts.

`tests/trace.test.ts`: the label; the two records of section 5 as they read, the `pi-stopped` one without a budget; records from before still read.

`tests/footer.test.ts`: the part's two wordings, its tone and its place; it replaces the goal, an end by the rule, `keep-warm: Pi's (…)` and `from your next message`; it stands beside the two warnings; with keep-warm off it stands alone; at 140, 60 and 40 columns.

`tests/keep-warm-flow.test.ts`, each with the record still on disk afterwards where that matters:

1. A stop from another window in a period the extension warms: no refresh from then on, one `skip` record with `stop: "stopped"`, the footer's part, the spending kept; Pi's real warmer is answered stop at its next idle decision.
2. The command in this window: the record on disk, the same effects at once, each of the four second lines, the last line only with `compactBeforeExpiry` on, the error notice where the directory can't be written.
3. `keepWarmMinutes: 0` with Pi's real warmer: its idle decision is answered stop, it sends nothing, the `pi-stopped` record has no budget; without a stop the handler returns nothing, as on 0.6.1.
4. A refresh on its way when the stop comes: not aborted; settling as a hit it is counted and moves the countdown, and nothing follows it; settling as a miss it counts toward two in a row.
5. A refresh being prepared when the stop comes: refused at the last gate, nothing leaves, nothing is reserved.
6. A window in a run when the stop comes: Pi's decision during the run stands; when the run settles with a new answer the period is stopped from its start and nothing is sent. With a message of the user's sent into that run after the stop (`input`, steering): the period is warmed as usual.
7. The user's next message: an `input` after the stop, its run brings an answer, and that period is warmed as usual, its first refresh on time; so is the period after it. The same for each source (`interactive`, `rpc`, `extension`).
8. The user's message after the stop, and its run sends nothing: still stopped. The next answer, from a run without a message, starts a period that is warmed as usual.
9. A run no message of the user's started (no `input`) brings a new answer: the new period is stopped from its start, with its own `skip` record where the extension took it; Pi's real warmer, started by that run's request, is answered stop at its idle decision. A second such run: stopped again.
10. A record already on disk when the extension loads stops nothing.
11. `/reload` (the extension loaded again in the process, the same session): still stopped, and Pi's warmer, which the reload did not touch, is answered stop; the two exceptions of section 13 are limits, not tested as held. `/new` in a stopped window: stopped until the first message there.
12. An unreadable record: no refresh leaves and the period's warming ends as `unable`, the handler adds nothing, `/cache-keeper` says it, the command repairs it.
13. Compacting before expiry in a stopped period, with `compactBeforeExpiry` on: the summary request leaves 20 s before the period's expiry, as after any end of warming. Afterwards, through four cache lifetimes: no refresh of the extension's, the period is not handed over, the footer says `warming stopped until your next message` without a countdown, and Pi's real warmer, whose run was for the request before the summary, sends nothing and asks nothing once the transcript is replaced. Then the user's message and its answer: warmed as usual.
14. A stop in a period handed over to Pi: Pi is answered stop, the period is not handed over again, the countdown still shows the time Pi's last refresh gives.
15. `/cache-keeper-warm` in a stopped window: the counts are cleared, its text says it does not lift the stop, the window stays stopped and sends nothing, also for a model that had been left to Pi.
16. A second stop: a window that had a message since is stopped again.
17. Two sessions in one process: a message in one does not lift the stop in the other.
18. A period whose warming had ended on a miss before the stop: the footer keeps the warning beside the stopped part, and `/cache-keeper` keeps its `keep warm:` line.
19. The notice of a stop: a stop from another window is said once in this one, with the period's amounts where the extension had taken it and without them otherwise; not again after `/reload`, nor for a later period that starts stopped; in the window that gave the command only the command's text is shown; a second stop is said again in a window that had a message since; nothing without an interface.
20. What is logged is said: in a session with an interface, every `warm` record written in a flow has its notice, the same number of each, and without an interface none. Run over the existing flows: a hit (`Cache warmed (pi-cache-keeper, refresh 1): 99% of 600k from the cache, $0.18; $0.18 spent, a miss costs $2.07`, the second with the sum), a hit that reaches the budget or the time limit, a miss, the second miss in a row (both lines), an unreported refresh, a failure with and without a hit, a cancellation with a hit, with a miss and with nothing, each hold-back once per expiry, each end without a refresh, a hand-over on evidence and one for a request let go, with and without an end, Pi told to stop.
21. A session left to Pi from its start: said once, not again for the next answers, again after the reason changes and after a period the extension took; nothing with keep-warm off, and nothing where the footer has no label.

`tests/trace.test.ts`: `noticeOf` for every row of section 5, its level and its exact words, with prices and without; nothing for a `stopped` end and for a bare `skip`; the two new records as `describeTrace` reads them.

Every existing test that lists a window's notices gains the new ones; no other assertion of an existing test changes.

What the design relies on in Pi, against the installed Pi:

- `tests/keep-warm-session.test.ts`, with Pi's real session runtime and extension runner: an input given to the runner (`emitInput`) for each source, idle and with a `streamingBehavior`, reaches the extension's handler and goes on unchanged (`continue`).
- With Pi's real `CacheWarmer` (as the flow tests build it): a run whose transcript is no longer current sends nothing and asks no decision at its next timer, and reads `conversation context changed`.
- Against Pi's source, as `tests/one-clock.test.ts` reads this repository's: `dist/core/sdk.js` calls `cacheWarmer.start(` in one place, under the condition that the request carries the session's own id. Skipped, with the reason, where the installed Pi has no such file.

That a compaction replaces the transcript a warmer's run is tied to, and raises no `agent_start` and no `agent_settled`, is read in Pi 1.6.0's code (`AgentSession.compact`) and not tested here: it would take Pi's whole agent loop with a transport in memory.

`tests/one-clock.test.ts`: `index.ts` still contains no `action: "stop"` and still sends in two places; only `stop-record.ts` contains the record's file name; `index.ts` calls `covers(` once, inside `obeyStop`, assigns `.stopped =` once, and calls `noteMessage(` once.

`tests/keep-warm-matrix.test.ts` and `docs/keep-warm-coverage.md` must come out unchanged: a stop does not change which sessions are kept warm.

## 9. The steps, in order

After each: `npm run typecheck` and `npm test` pass.

1. **`stop-record.ts` and its test**, with `writeAtomic` exported from `model-data.ts`. Nothing uses it yet: the extension behaves as 0.6.1.
2. **The one more value**: `WarmStop`, `stopLabel`, `Warmer`, `warmer`'s `stopped` input (every caller passes `false`), `ENDED_SHORT`; the tests of `warm-period`, `trace`. Still 0.6.1's behaviour, and every existing test passes untouched except where it lists all values.
3. **The window obeys a record**: the period's `seen` and `stopped`, `rememberLoad`, the `input` handler, `stopRecord`, `obeyStop` and its calls, `owns`, the decision handler, the last gate, `shown`. There is no command yet: flow tests 1, 3 to 14, 16 and 17 and the two session tests pass with the record written by the test (their footer and `/cache-keeper` assertions come with steps 4 and 5). With no record on disk, every existing test passes untouched.
4. **The command and what is said**: `/cache-keeper-stop`, the `stopped:` line, `/cache-keeper-warm`'s sentence, `keepWarmNote`, the notice of a stop (`firstSaid`, said through `say`, which comes in here). Flow tests 2, 15, 18 and 19.
5. **The footer**: `FooterView.stopped`, the part, `renderFooter`. The footer tests, and the footer assertions of the flow tests.
6. **The structure test** in `tests/one-clock.test.ts`.
7. **What is logged is said**: the new fields and the `left` action, `noticeOf`, the call in `trace`, the two notices taken out of the settlement, the records of a hand-over without an end and of a session left to Pi. Flow tests 20 and 21 and the `trace` test. It depends on steps 1 to 6 only for the stop's rows, and can be built first and released apart from them without those rows.
8. **The words**: the README, the changelog, the line in `docs/live-tests.md`, the version (section 10); this document corrected wherever the build differed from it.

## 10. The README, the changelog, the version

**Version 0.7.0**: a new command and a new file in the agent directory. In `package.json`.

**README.**

- *Commands*, a row after `/cache-keeper-warm`: `/cache-keeper-stop` | stops keeping idle caches warm in every Pi window that uses the same settings, until the next message you send each window: the extension sends no further refresh and Pi's own idle warming is told to stop when it next asks; compacting before expiry still runs; it changes no setting and can't be taken back (see [Keeping the cache warm](#keeping-the-cache-warm))
- `/cache-keeper-warm`'s row gains: it does not lift a `/cache-keeper-stop`.
- *Common tasks*, a row: Stop the idle spending in every window before a long break | `/cache-keeper-stop`
- *The footer*, after "Where the extension stepped back", one more short table, **A stop**: `warming stopped until your next message` | `/cache-keeper-stop` was given, in this window or another, since your last message here: nothing is sent to keep this window's cache warm, with keep-warm on or off, until the answer to your next message. In the place of keep-warm's own note; keep-warm's warnings stay beside it. Narrower: `warming stopped`
- *Keeping the cache warm*, a paragraph after "When warming ends", **Stopping it in every window**, saying in the README's manner: the rule of section 1, what the user's message is, and its two tables in prose; that it holds with keep-warm off, where it stops Pi's own idle warming; that compacting before expiry still runs, sooner than it would have, and that nothing warms the window after it (section 2); the record and why an old one stops nothing (section 3, without the code); what "every window" means; that a refresh on its way is not called back; that it can't be taken back and why (section 4).
- *Compacting before the cache expires*, one sentence: a `/cache-keeper-stop` does not hold it back.
- *Keeping the cache warm*, a paragraph **What it says**, in the place of today's sentence about Pi showing a warning: the extension says in the transcript each refresh it sends and every issue, whatever Pi's `showCacheMissNotices`; the tables of section 5 as one table (the event, the line, whether it is a notice that stays); that a line about a refresh that went well takes the place of the one before it, so an idle window keeps the latest with the period's sum, while warnings stay; that these lines are not kept in the session and the refreshes are not in Pi's session cost; that the log has every one.
- "Two refreshes in a row without a hit": the second miss now shows its own line before the one that is there today.
- The table "When warming ends" is not changed: the footer says a stop with its own part.
- *Limitations*, four items: a window that has not loaded this version does not obey; a window without a countdown shows the stop only when it next reads the record; an unreadable record stops the extension's refreshes until `/cache-keeper-stop` writes it again; a run another extension starts with a custom message does not end a stop, so a window that only such runs keep busy stays unwarmed until you send it a message.
- *Documentation*: a line for this document.
- The figure of footer states is not rendered again for this version (rendering needs Chrome and the network); the tables carry the new state.

**CHANGELOG**, under `## [0.7.0]`:

```markdown
### Added
- **`/cache-keeper-stop`: stop keeping idle caches warm in every Pi window, until each one's next message** — Typed in any window, it ends warming for the idle period every window is in (for a window in a run, the period that run ends in) and for the ones that follow there: the extension sends no further refresh, and Pi's own idle warming is told to stop the next time it asks, also with `keepWarmMinutes: 0`. No setting changes, and it undoes itself: the answer to the next message you send a window (typed, over RPC, or sent in your name by another extension) starts an idle period that is warmed as usual. Nothing Pi or the extension sends by itself ends it. A stop is one more way a period's warming ends (`keep-warm ended (stopped by /cache-keeper-stop)` in the log, a `stopped:` line in `/cache-keeper`), and the footer says `warming stopped until your next message`. It is recorded in `cache-keeper-stop.json` beside the settings, which every window reads before it sends anything; a window obeys a record only if it is not the one it saw when your last message reached it, so no clock is compared and an old record stops nothing later. A refresh already on its way is not called back; a stop can't be taken back, since Pi's own warming, once stopped, starts again only with the next request; and compacting before the cache expires still runs where it is on, after which the window stays quiet: a summary starts no warming, the extension's or Pi's. Each other window says once that it was stopped.
- **Keep-warm says what it does** — Every refresh the extension sends and every issue it meets is now said in the transcript, whatever Pi's `showCacheMissNotices`: a refresh that read the cache (`Cache warmed (pi-cache-keeper, refresh 2): 99% of 600k from the cache, $0.18; $0.36 spent, a miss costs $2.07`), a miss and a failure with what they cost, a refresh that reported no usage, one cancelled on its way, one held back or too late, warming ended and why, a period handed to Pi's own warming and why, a session left to Pi from its start (once per reason), and Pi's own warming told to stop. Before, only a failure, a miss and a model left to Pi after two misses were said. What went well is an `info` notice, which Pi draws in the place of the one before it, so an idle window keeps one line with the refresh's number and the period's sum; what went wrong is a warning and stays. Each notice is the log's record said aloud: nothing is logged that is not said. The lines are notices, not session entries, and the refreshes are still not in Pi's session cost.

### Changed
- **The second miss in a row shows its own line** before the notice that the model is left to Pi; a failed refresh's and a miss's notices name what was read and spent.
```

## 11. Simpler things that do not serve it

- **`keepWarmMinutes: 0`, which every window already reads at each decision.** It stops only the extension's refreshes: with keep-warm off Pi warms on its own, so the windows go on spending for up to 30 minutes each. It does not undo itself, and it changes a setting.
- **Pi's `cacheWarming: "off"`.** A running Pi reads its settings at start and on `/reload`, not from another window. It does not stop the extension's refreshes, does not undo itself, and changes a setting.
- **A time or an id under `cacheKeeper` in `settings.json`.** A stop is not a setting, and a settings file that is kept under version control or copied between machines would carry it along. And `loadConfig` rejects a key it does not know: a window still running an earlier version of the extension would fail to read its settings at all from the moment another window wrote the stop.

## 12. Where the ask is not met as said

- "All instances" is every Pi that uses the same agent directory and has loaded this version (section 3).
- "Stop" is every refresh from then on. A refresh already on its way arrives; there is at most one per window. And it is not "nothing is sent": the one summary before the cache expires still leaves where that setting is on, as decided (section 2).
- "The next message" is the first real answer after the user's next message. A message whose run sends nothing, or whose request fails before it reported any cache use, leaves the window stopped until an answer comes.
- It can't be taken back before the next message (section 4).

## 13. Decided, and what the build changed

All of the list below was decided as written, with these exceptions and additions:

- **11: B**, built as section 5 says under "Built: B".
- **The request let go, in words a user understands.** The footer says `keep-warm: Pi's (you switched model or branch, or compacted)`, and the reason (in `/cache-keeper`, the log and the notice) is "you switched the model or the branch, or the conversation was compacted, so the extension no longer has the request to re-send".
- **An unnamed route.** A proxy's `model-upstreams:answered` with `upstreams: []` means "this answer's route is unknown": it is kept as a report that names no route, which differs from every other report (an empty one included), so a period that sees one is treated as on a change of route, and one whose answer had one is Pi's from its start (`keep-warm: Pi's (the route is unknown)`).
- **Compacting before expiry, tried again.** A try postponed by a passing reason (Pi busy, a message queued) is made again each second while the cache lives; a lasting reason spends the try for that expiry only, and each reason is logged once per countdown. A failed compaction starts the countdown again with the expiry it was made for spent, so an expiry Pi's refresh moved in the meantime gets its own try. Every expiry tried is remembered for the answer it was read from, not only the last: a retention switched short -> long -> short for the same answer (300 s and 305 s tiers) sends two summary requests, not three. A new answer starts with none tried.
- **`/reload` is not chased.** An attempt to answer Pi's warming from the old instance while `/reload` loads (d92fe14) also told Pi to stop where no stop had been given, so nobody warmed; it was taken out, and `/reload` behaves as in 0.6.1. What remains, all rare, is in the README's limitations: while `/reload` loads the extensions, Pi's own warming sends a refresh at each due time that falls inside the loading (one or more where another extension's startup is slow); after a message of the user's that has not brought an answer yet (another extension handled it, or its run sent nothing), `/reload`, `/new`, `/resume` or `/fork` lifts the stop before the next answer; and a refresh that settles while a `/reload` is under way, or after `/new`, `/resume` or `/fork` replaced its session, may leave no saved line (the log keeps its record). A refresh that settles after the reload has finished keeps its line.
- **Pi's compaction cut.** Where Pi's own compaction cuts right after an entry without a message (a refresh's saved line, Pi's own `cache_warm` entry, a label, a model change), Pi treats the turn before as split and, where there is earlier history to summarise, sends one extra summary request: about 7% more input in a three-turn case, none in a two-turn case. Kept as a README limitation; it is Pi's cut selection.
- Where the build differed in detail: `pi-stopped` records carry a budget only for a period the extension took (a period Pi warms with keep-warm on has a budget computed but unused); a period a reloaded instance starts is never taken (it has not seen the request), so its stop writes no `skip` record, while Pi is told to stop all the same; the notice of a model left to Pi after two in a row comes after the refresh's own line; a `left` record carries the seconds left the plain reading gives.

## 13a. The list as it was put to the maintainer

Decided by the maintainer: compacting before the cache expires is not held back by a stop, and neither it nor anything else Pi or the extension sends by itself ends one; only the user's message does (sections 1 and 2). Pi offers all of that; nothing had to be given up.

To decide:

1. **The user's message is Pi's `input`, from every source**: typed, RPC, and another extension's `pi.sendUserMessage`. The other reading leaves the last one out, as software acting by itself. It is in because Pi presents such a message as the user's, and a program that delivers a person's messages to Pi (an orchestrator, a chat bridge, voice input) uses that call: left out, a window fed that way would never warm again after a stop. The extension itself never makes that call.
2. **A run another extension starts with a custom message does not end a stop**: the idle period its answer starts is stopped from its start. This is the maintainer's "only a message the user sends" taken at its word. The other reading (any run that brings a real answer ends the stop) is the same build with one more sample, at `agent_start`.
3. **A window in a run when the stop is given is covered**: the period its run ends in is stopped. The other reading (only windows idle at that moment) leaves a hole the user can't see: whatever was working when the command was typed warms again when it finishes.
4. **A message typed into such a run after the stop ends the stop there**: it is a message the user sent the window after the stop. The other reading (only a message that starts a run counts) keeps a window stopped that its user has just written to.
5. **No take-back.** If one is wanted all the same, it can only restart the extension's own warming, in periods it had taken, while their cache has not expired; Pi's cannot be restarted.
6. **An unreadable record stops the extension's refreshes**, as unreadable settings do. The other reading treats it as no record.
7. **The name** `/cache-keeper-stop` and the words of section 5.
8. **The footer says the stop in every stopped window**, also where there was nothing to warm (a cold cache, no lifetime). The other reading says it only where something was being warmed, and then a glance at a window does not tell whether it obeyed.
9. **The figure of footer states is left as it is** for this version.
10. **Version 0.7.0.**
11. **A line for every refresh: A, B or C of section 5.** The document is written for A: each refresh is said when it settles, and Pi keeps the latest such line in the place of the one before, with the number and the sum; issues stay. B keeps every line, as saved entries; C says one line per idle period.
12. **A session left to Pi from its start is said once per reason**, not after every answer. The other reading (every period) is a line after each answer in every session the extension cannot refresh.
13. **Nothing is said when the extension takes a period or when a stop ends**: the footer says both.
14. **The levels**: the budget, the time limit, a switch-off, a hold-back and a request let go are `info`; a miss, a failure, an unreported refresh, too late, a request that can't be re-sent and evidence against a period are warnings.
15. **The words** of section 5's tables.
16. **Compacting before expiry's reasons for not starting stay in the log only.** Said too, it is the same build for the `expiry` records.
