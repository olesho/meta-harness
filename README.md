# meta-harness

TypeScript project for autonomous plan → ship → release → redeploy.

## Documentation

Docs live in [`docs/`](docs/README.md), split by format:

- **Markdown** ([`docs/md/`](docs/md/README.md)) — the written docs: the
  [architecture overview](docs/md/architecture.md), the [getting-started guide](docs/md/getting-started.md),
  the [module reference](docs/md/modules/README.md), and the [task guides](docs/md/guides/README.md).
- **HTML** ([`docs/html/`](docs/html/index.html)) — a single-page visual overview with SVG
  architecture and turn-flow diagrams.

## Develop

```bash
npm install
npm test        # the release gate
```

## Session resume

A conversation can be relaunched against a harness that supports resuming a prior
session (currently `claude-code` and `codex`). Two entry points, both in
`src/chat`:

- `Open(ctx, { ..., resume })` — low level. `resume` names the *harness* session
  id (not the chat session id). The resolved adapter's resume args are prepended
  to `args` at launch and the new chat session's `harnessSessionID` is seeded.
  Throws `ErrResumeUnsupported` when the harness has no resume sequence.
- `Reopen(ctx, opts)` — convenience. Loads a stored chat `Session` by
  `opts.sessionID`, derives `harness`/`workingDir` from the record and the resume
  id from its `harnessSessionID`, and relaunches reusing the **same** chat session
  id so `sessionID()` and history reflect the resumed session.

The stored `Session` persists only `harness`, `workingDir`, and
`harnessSessionID`. All other launch knobs (`binaryPath`, `env`, `args`, `effort`,
`model`, `cols`/`rows`, input policy, …) must still be supplied by the caller via
`ReopenOptions`. `Reopen` throws `ErrNoHarnessSession` when the stored session
never captured a harness session id, and surfaces `ErrResumeUnsupported` when its
harness cannot resume.

## Autonomous pipeline

This project is wired to the `META-HARNESS` fleet-db workspace via the
`autonomous-dev-deploy` pipeline. Ship a plan from Claude Code with "ship this
plan", or check agents with "are the agents running?".

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

**Selection rule** (`src/chat/conversation.ts:891`): the transcript source is
used **only** when the adapter implements a `readTranscript` method **and**
`session.harnessSessionID` is non-empty. In every other case history comes from
the `Store` and is tagged `HistorySourceStore`.

> **Fallback behavior.** When the adapter has a reader but the transcript is
> missing or not yet flushed, `historyWithSource()` degrades to store history:
> a `readTranscript` that throws `ErrSessionNotFound` or `ErrEmptySessionID` is
> caught and the `Store` is read instead (tagged `HistorySourceStore`). Genuine
> reader failures (parse errors, permission problems, etc.) are **not** masked —
> they propagate. (OpenCode defines no `readTranscript` at all, so its
> `historyWithSource()` always uses the store.)

### Transcript reader classes

Independent of the chat layer, `meta-harness/transcript` ships low-level parsers
that turn a harness's on-disk session logs into a canonical event stream. These
are public and work today:

```ts
import {
  ClaudeCodeReader,
  CodexReader,
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
| Claude Code  | ✓ `ClaudeCodeReader`                                | ✓ `readTranscript` reads the on-disk log                                 |
| Codex        | ✓ `CodexReader`                                     | ✓ `readTranscript` reads the on-disk log                                 |
| pi           | ✓ `PiReader`                                        | ✓ `readTranscript` reads the on-disk log                                 |
| OpenCode     | ✗                                                   | n/a — no `readTranscript`, always uses the store                         |

Claude Code, Codex, and pi read history from the harness's on-disk transcript
once a `harnessSessionID` has been captured, falling back to the `Store` when the
transcript is missing or not yet flushed. OpenCode is always store-backed.
