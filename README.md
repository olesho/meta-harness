# meta-harness

TypeScript project wired to [Orche](../../new/orche) for autonomous plan → ship → release → redeploy.

## Develop

```bash
bun install
bun test        # the release gate (ORCHE_RELEASE_GATE_CMD)
```

## Orche

This project is wired to the `META-HARNESS` fleet-db workspace via the
`autonomous-dev-deploy` pipeline. See `.orche/config.json` and `.env`. Ship a plan
from Claude Code with "ship this plan", or check agents with "are the agents running?".

## Reading session history

`Conversation.historyWithSource()` (from `meta-harness/chat`) returns the
conversation's turns together with a tag saying where they came from:

```ts
import { Open, HistorySourceStore, HistorySourceTranscript } from "meta-harness/chat"

const conv = await Open(ctx, { harness: "claude-code", workingDir, store })
const [turns, source] = await conv.historyWithSource()

if (source === HistorySourceTranscript) {
  // history was parsed from the harness's on-disk transcript
} else if (source === HistorySourceStore) {
  // history came from the Store
}
```

**Selection rule** (`src/chat/conversation.ts:688`): the transcript source is
used **only** when the adapter implements a `readTranscript` method **and**
`session.harnessSessionID` is non-empty. In every other case history comes from
the `Store` and is tagged `HistorySourceStore`.

> **Caveat — no production adapter reads transcripts yet.** Every harness
> adapter's `readTranscript` is currently an unported stub that throws
> (`"<harness> transcript reader not yet ported"`). In practice this means
> `historyWithSource()` returns store-backed history (`HistorySourceStore`)
> today. `historyWithSource()` invokes the reader directly with no fallback, so
> passing a **non-empty** `harnessSessionID` to a real adapter makes it
> **throw** rather than silently fall back to the store. Transcript-backed chat
> history is forthcoming and tracked separately. (OpenCode defines no
> `readTranscript` at all, so its `historyWithSource()` always uses the store.)

### Transcript reader classes

Independent of the chat layer, `meta-harness/transcript` ships low-level parsers
that turn a harness's on-disk session logs into a canonical event stream. These
are public and work today:

```ts
import {
  ClaudeCodeReader,
  CodexReader,
  GeminiReader,
  PiReader,
  type Reader,
  ErrEmptySessionID,
  ErrEmptyWorkingDir,
  ErrSessionNotFound,
} from "meta-harness/transcript"

const reader: Reader = new ClaudeCodeReader()
const events = reader.read(harnessSessionID, workingDir)
```

`read(harnessSessionID, workingDir)` returns the parsed `Event[]` and throws on
missing or malformed input — including the sentinels `ErrEmptySessionID`,
`ErrEmptyWorkingDir`, and `ErrSessionNotFound`.

### Support matrix

| Harness      | Transcript reader class (`meta-harness/transcript`) | Chat-history adapter integration (`historyWithSource()` transcript path) |
| ------------ | :-------------------------------------------------: | :----------------------------------------------------------------------: |
| Claude Code  | ✓ `ClaudeCodeReader`                                | not yet — `readTranscript` stub throws                                   |
| Codex        | ✓ `CodexReader`                                     | not yet — `readTranscript` stub throws                                   |
| Gemini       | ✓ `GeminiReader`                                    | not yet — `readTranscript` stub throws                                   |
| pi           | ✓ `PiReader`                                        | not yet — `readTranscript` stub throws                                   |
| OpenCode     | ✗                                                   | n/a — no `readTranscript`, always uses the store                         |

No harness adapter is wired to the transcript path yet, so
`historyWithSource()` is store-backed across the board today.
