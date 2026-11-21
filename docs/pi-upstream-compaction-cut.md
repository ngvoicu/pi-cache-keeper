# Draft: Pi issue on the compaction cut and non-message entries

Not filed. A draft for a Pi upstream issue, written against Pi 1.6.0.

## Title

Compaction splits a turn when the cut falls right after an entry that carries no message

## What happens

When Pi compacts on its own (`prepareCompaction`), `findProjectedCutPoint` picks a cut at a message that starts a turn
and then walks the cut back over the entries just before it that carry no model message:

```js
while (cutIndex > startIndex) {
    const previous = entries[cutIndex - 1];
    if (previous.sourceEntry.type === "compaction" || previous.messages.length > 0)
        break;
    cutIndex--;
}
```

The cut then sits on that entry. The next lines ask whether the entry at the cut starts a turn:

```js
const startsTurn = isProjectedTurnStart(entries[cutIndex]);
const turnStartIndex = startsTurn ? -1 : findProjectedTurnStartIndex(entries, cutIndex, startIndex);
```

A custom entry, a label or a model change starts no turn, so Pi looks back for the previous user message and reports
`isSplitTurn: true`. The turn before the cut is complete, but `compact()` treats its messages as the prefix of a split
turn and sends a second summary request for them ("turn prefix"), beside the history summary.

Every entry kind without a model message does this: `custom` (an extension's `pi.appendEntry`), `label`,
`model_change`, `session_info`, `thinking_level_change`, and Pi's own `usage` entry of kind `cache_warm`, which Pi's
idle cache warmer appends between an answer and the user's next message, so exactly where a cut can fall.

## Reproduction

Three turns, built with `SessionManager.inMemory`: user and assistant messages of about 1,000 tokens each in turns 1
and 2, about 10,000 each in turn 3; one non-message entry after turn 2's answer. Then
`prepareCompaction(branch, { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 })`.

| entry after turn 2 | cut lands on | `isSplitTurn` | messages summarized | turn prefix messages |
| --- | --- | --- | --- | --- |
| none | turn 3's user message | false | 4 | 0 |
| `custom` | the custom entry | true | 2 | 2 |
| `usage` (`cache_warm`) | the usage entry | true | 2 | 2 |
| `label` | the label entry | true | 2 | 2 |
| `model_change` | the model change | true | 2 | 2 |
| `session_info` | the session info | true | 2 | 2 |
| `thinking_level_change` | the level change | true | 2 | 2 |

With the entry, the compaction makes two model calls instead of one, and in this case reads about 7% more input
(18,828 estimated input tokens against 17,608). The summary is still correct; it costs one extra request.

## Suggested fix

Decide whether the cut starts a turn from the message entry the walk-back started from, not from the entry it ended
on. The entries walked over carry nothing the model sees, so a turn that starts at the message still starts at the cut:

```js
const anchor = cutIndex; // the message entry chosen as the cut, before the walk-back
while (cutIndex > startIndex) { /* unchanged */ }
const startsTurn = isProjectedTurnStart(entries[anchor]);
const turnStartIndex = startsTurn ? -1 : findProjectedTurnStartIndex(entries, anchor, startIndex);
```

The kept entries still begin at the walked-back `cutIndex`, so the metadata entries stay with the turn they precede.
A test: the reproduction above, expecting `isSplitTurn: false` and no turn prefix for every entry kind.
