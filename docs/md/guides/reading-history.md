# Reading history

meta-harness can serve a conversation's history from two places — its own
[store](../modules/chat.md#the-store), or the harness's **own on-disk transcript** — and it
tells you which. This guide covers `history()` / `historyWithSource()`, the selection rule,
and reading a transcript directly (independent of a live conversation).

---

## The two sources

- **`HistorySourceStore`** — the turns meta-harness recorded as they happened. Always
  available; the metadata is authoritative, but the assistant _text_ is what was extracted
  from the screen.
- **`HistorySourceTranscript`** — parsed from the harness's own session log via the
  adapter's [`TranscriptReader`](../modules/transcript.md). Authoritative text, but only
  exists once the harness has flushed its log and meta-harness has captured a
  [`harnessSessionID`](../concepts.md#session).

---

## history() and historyWithSource()

```ts
const turns = await conv.history(); // Turn[]
const [turns2, source] = await conv.historyWithSource(); // [Turn[], HistorySource]
```

`history()` just returns the turns. `historyWithSource()` also tells you where they came
from:

```ts
import { HistorySourceTranscript, HistorySourceStore } from "meta-harness/chat";

const [turns, source] = await conv.historyWithSource();
if (source === HistorySourceTranscript) {
  // parsed from the harness's on-disk log — authoritative text
} else {
  // came from the store (fallback, or no transcript reader for this harness)
}
for (const t of turns) console.log(`${t.role}: ${t.text}`);
```

---

## The selection rule

The transcript source is used **only** when **both** are true:

1. the adapter implements `readTranscript` ([Claude Code, Codex, pi](../harnesses.md) — not
   OpenCode, not generic), **and**
2. `session.harnessSessionID` is non-empty (the id has been captured).

In every other case history comes from the store, tagged `HistorySourceStore`.

### Graceful fallback

Even when a reader exists, the on-disk log may be missing or not yet flushed. A
`readTranscript` that throws [`ErrSessionNotFound`](../modules/transcript.md#errors) or
[`ErrEmptySessionID`](../modules/transcript.md#errors) is caught and the store is read
instead (tagged `HistorySourceStore`). **Genuine reader failures are not masked** — a parse
error or a permission problem propagates. So a `HistorySourceStore` result means "no
usable transcript _yet_," while an exception means "the transcript exists but couldn't be
read."

---

## Reading a transcript directly

The [`transcript`](../modules/transcript.md) readers are public and usable without a
`Conversation` — handy when you have a harness session id (say, from
[`runOneShotDetailed`](one-shot-turns.md#in-process-failure-safe)) and just want the log:

```ts
import {
  ClaudeCodeReader,
  CodexReader,
  type Reader,
} from "meta-harness/transcript";

const reader: Reader = new ClaudeCodeReader(); // defaults to ~/.claude/projects
const events = reader.read(harnessSessionID, workingDir); // Event[]
```

`read(harnessSessionID, workingDir)` returns the canonical `Event[]` and throws on missing
or malformed input (`ErrEmptySessionID`, `ErrEmptyWorkingDir`, `ErrSessionNotFound`).
Project events to the lossy chat view with `turnsFromEvents(events)`.

> **pi is different.** [`PiReader.read`](../modules/transcript.md#pireader) returns
> `Turn[]` directly, not `Event[]` — don't call `turnsFromEvents` on it. Codex ignores the
> `workingDir` argument (it locates sessions by id); Claude Code needs it.

---

## Support at a glance

| Harness     | Transcript reader              | `historyWithSource()` can serve transcript? |
| ----------- | ------------------------------ | ------------------------------------------- |
| Claude Code | `ClaudeCodeReader` (`Event[]`) | ✓                                           |
| Codex       | `CodexReader` (`Event[]`)      | ✓                                           |
| pi          | `PiReader` (`Turn[]`)          | ✓                                           |
| OpenCode    | —                              | ✗ always store                              |
| generic     | —                              | ✗ always store                              |

See [Harnesses](../harnesses.md) and the [transcript module](../modules/transcript.md) for
file locations and formats.
