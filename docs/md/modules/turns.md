# `meta-harness/turns`

Interprets a harness's low-level signals — [screen](screen.md) snapshots and
[wrapper](wrapper.md) status events — into a small vocabulary of typed turn
[`Event`](#the-event-vocabulary)s. It provides a per-harness **[`Adapter`](#the-adapter-contract)**
that does the pattern-matching, a generic fallback, and a **[`Watcher`](#the-watcher)**
that merges the two signal sources into one ordered event stream.

This layer is *stateless interpretation*: it doesn't own the process (that's
[`wrapper`](wrapper.md)) or the conversation (that's [`chat`](chat.md)). It answers one
question continuously — "given what's on screen and the wrapper's status, what just
happened in the conversation?"

```ts
import {
  type Kind, type Event, type Turn, type InputRequest, type InputOption,
  TurnComplete, ToolCall, Blocked, Errored, InputRequested, InputResolved,
  type Adapter, /* + optional capability interfaces */,
  type Status, type SessionEvent, type SessionLike, StatusIdle, /* … */,
  Watch, Watcher,
  generic, claudecode, codex, opencode, pi,
} from "meta-harness/turns"
```

---

## The event vocabulary

`Kind` is a deliberately small set; adapters attach detail via `reason`/`snap`/`input`
rather than growing it. Each name is a **string constant** you compare against `ev.kind`:

| Constant | Value | Meaning |
| --- | --- | --- |
| `TurnComplete` | `"turn_complete"` | Assistant finished; you may send the next message. |
| `ToolCall` | `"tool_call"` | Harness is invoking a tool. Informational; turn continues. |
| `Blocked` | `"blocked"` | Transient block (cost/quota/rate-limit); back off and retry. |
| `Errored` | `"errored"` | Terminal failure; the turn won't complete. |
| `InputRequested` | `"input_requested"` | Blocked on an interactive prompt — see `ev.input`. |
| `InputResolved` | `"input_resolved"` | A prompt is no longer on screen. |

```ts
interface Event {
  kind: Kind
  reason: string          // human-readable; not for parsing
  at?: Date               // Watcher backfills from the source event
  snap?: Snapshot         // present for screen-derived events
  httpCode?: number       // copied from the SessionEvent (api_error)
  retryAfter?: number     // parsed retry hint (ms)
  input?: InputRequest    // for input_requested / input_resolved
}
```

### Interactive prompts

```ts
interface InputRequest {
  id: string              // stable across redraws of the SAME prompt; changes for a new one
  kind: string            // "trust_prompt" | "menu_select" | "confirm" | "text_input"
                          //   | "question" | "question_review" | "approval_prompt"
  prompt: string
  options?: InputOption[] // undefined for free-text prompts
  header?: string         // kind "question": the dialog's tab label
  multiSelect?: boolean   // kind "question": options TOGGLE; commit with submitKeys
  submitKeys?: Uint8Array // bytes committing a multi-select answer after toggles
}

interface InputOption {
  id: string              // the answer references this (e.g. "1")
  alias: string           // portable intent: "proceed" | "deny" | "yes" | "no" | "other" | ""
  label: string
  keys: Uint8Array        // bytes to write to the PTY to choose this option
  description?: string    // explanatory text rendered under the label, when shown
}
```

The `id` is a content hash of the prompt — spoof-resistant and stable while the same
prompt is shown. [`chat`](chat.md) re-surfaces these as its own `InputRequest` and uses
`keys`/`alias` to answer.

Two kinds carry the mid-turn **clarifying-question** dialog (Claude Code's
`AskUserQuestion` tool, shapes verified live on 2.1.210): `"question"` — one question with
its options (plus the UI's `"other"`-aliased free-text affordance and "Chat about this");
and `"question_review"` — the Submit/Cancel confirmation after the last question of a
multi-question or multi-select dialog (`proceed`/`deny` aliases). A multi-question dialog
surfaces one `question` request per question: answering one emits `InputResolved` for it
and `InputRequested` for the next. Without this detection the dialog is a silent hang —
the screen is neither busy nor a ready composer, so no other signal ever fires.

`"approval_prompt"` carries Codex's mid-turn **command / apply-patch approval** dialog
("Would you like to run the following command?" / "Would you like to make the following
edits?"): the numbered menu rows become options with `proceed`/`deny` aliases. The codex
adapter checks for it *before* its startup-interstitial anchors, so an approval dialog
whose body quotes an interstitial phrase is never auto-dismissed — which would press
Enter on the highlighted "Yes" and silently auto-approve.

### `Turn`

```ts
interface Turn { role: string; text: string; timestamp?: Date }
```

The lossy transcript view returned by a [`TranscriptReader`](#optional-capabilities)
adapter. (Distinct from the richer stored [`chat.Turn`](chat.md#turn-vocabulary).)

---

## The Adapter contract

Every adapter implements a tiny required core:

```ts
interface Adapter {
  name(): string                                             // "generic", "codex", …
  onScreen(snap: Snapshot): Event[]                          // after each screen write
  onWrapperStatus(status: Status, reason: string): Event[]   // on each wrapper status event
}
```

`name()` is documentary (chat dispatches via [`resolveAdapter`](chat.md#opening-a-conversation), not this).
`onScreen` and `onWrapperStatus` each return zero or more events for the signal they were
handed.

### Optional capabilities

Everything beyond the core is an **optional interface** — a method an adapter may or may
not implement. The chat layer probes for each structurally (`typeof adapter.method ===
"function"`), the TypeScript analogue of a Go optional-interface assertion. Implement a
subset; each one lights up a feature.

| Interface | Method | Enables |
| --- | --- | --- |
| `SessionIDExtractor` | `extractSessionID(snap): [string, boolean]` | Scrape the harness id from the screen. |
| `RawSessionIDExtractor` | `extractSessionIDFromLine(line): [string, boolean]` | Recover the id from a raw PTY line. |
| `SessionIDLocator` | `locateSessionID(workingDir): [string, boolean]` | Recover the id from on-disk state. |
| `SessionIDPrimer` | `primeSessionIDKeys(): Uint8Array` | Keystrokes that surface the id on screen. |
| `SessionInitializer` | `initSession(): [string[], string]` | Mint a fresh id + the launch args pinning it. |
| `SessionResumer` | `resumeArgs(id): string[]` | Argv that resumes a prior session. |
| `SessionForkResumer` | `resumeForksSessionID(): boolean` | Report whether resume mints a *new* id. |
| `SessionControlFlags` | `sessionControlFlags(): string[]` | Flags chat manages (banned from user args). |
| `BusyDetector` | `busy(snap): boolean` | Whether the harness is still working. |
| `MessageExtractor` | `extractMessage(snap): [string, boolean]` | Isolate the clean reply text. |
| `Quitter` | `quitSequence(): Uint8Array` | Graceful-exit keystrokes. |
| `TranscriptReader` | `readTranscript(id, workingDir): Turn[]` | Read the harness's own session log. |

`[string, boolean]` returns are the Go `(value, ok)` idiom: the boolean says whether the
value is valid. Which harness implements which is tabulated in
[Harnesses › Capability detail](../harnesses.md#capability-detail-chat-adapters); adding
a new one is [its own guide](../guides/adding-a-harness.md).

---

## The Watcher

```ts
Watch(sess: SessionLike | null, scr: Screen | null, adapter: Adapter): Watcher

class Watcher {
  events(): AsyncIterableIterator<Event>   // the merged, ordered event stream
  close(): void                             // stop the screen pump (idempotent)
}
```

`Watch` composes a session's status stream, a screen's change notifications, and an
adapter into one `Event` stream. Internally it runs **two pumps**:

- a **status pump** — each [`SessionEvent`](#session-types) → `adapter.onWrapperStatus`,
  backfilling `at`/`httpCode`/`retryAfter`; ends when a terminal event arrives;
- a **screen pump** — each screen notification → `snapshot()` → `adapter.onScreen`,
  backfilling `at`/`snap`; ends when `close()` is called.

Either source may be `null` (that pump is skipped). **You must call `close()`** —
iterating `events()` to exhaustion does not by itself stop the screen subscription.

### Session types

```ts
interface SessionLike { events(): AsyncIterable<SessionEvent> }   // the minimal wrapper surface the Watcher needs

interface SessionEvent {
  at?: Date
  status: Status
  reason: string
  terminated: boolean
  httpCode?: number
  retryAfter?: number
}

type Status =
  | "idle" | "failed" | "blocked_by_cost" | "retry_later" | "api_error"
  | "waiting_for_input" | "stale" | "interrupted" | "unknown" | "binary_not_found"
```

`Status` is re-exported here with constants (`StatusIdle`, `StatusWaitingForInput`,
`StatusBlockedByCost`, …) matching the [wrapper's](wrapper.md#status-values). The generic
adapter maps them straight to events (see below).

---

## Adapters

Five adapters, each a namespace exposing `New()` (mirroring the Go per-package layout):

```ts
const a = claudecode.New()   // also: generic.New(), codex.New(), opencode.New(), pi.New()
```

- **`generic`** — the fallback. No screen scraping; `onWrapperStatus` maps status → event
  (`waiting_for_input → TurnComplete`, `blocked_by_cost`/`retry_later`/`api_error →
  Blocked`, `failed`/`interrupted`/`idle → Errored`). Every other adapter extends it.
- **`claudecode`** — thinking-marker turn completion, interrupt detection, trust-prompt
  detection, AskUserQuestion detection (`question`/`question_review` requests); implements
  `MessageExtractor`, `BusyDetector`, `Quitter`, `SessionResumer`,
  `RawSessionIDExtractor`, `TranscriptReader`.
- **`codex`** — `/status`-box and resume-hint session id (`SessionIDExtractor`,
  `RawSessionIDExtractor`, `SessionIDPrimer`), `SessionResumer`, `SessionForkResumer`
  (reports `false`), `TranscriptReader`, command / apply-patch approval detection
  (`approval_prompt` requests), plus startup-interstitial auto-dismiss helpers.
- **`pi`** — session control is the focus: `SessionInitializer`, `SessionResumer`,
  `SessionControlFlags`, `TranscriptReader`, `Quitter`, `BusyDetector`, and a launch-env
  binding hook.
- **`opencode`** — a minimal stub; behaves like `generic` (no optional capabilities yet).

See [Harnesses](../harnesses.md) for the per-adapter behavior in depth.

---

## Relationship to other layers

- **Below:** consumes [`screen`](screen.md) snapshots and [`wrapper`](wrapper.md)
  `SessionEvent`s. It doesn't import the wrapper package directly — it depends only on the
  structural `SessionLike`/`SessionEvent`/`Status` shapes.
- **Above:** [`chat`](chat.md) wraps each adapter behind its
  [`deps.ts` `Adapter`](../architecture.md#the-backendadapter-seam) interface and drives a
  `Watcher` to advance turn state. The `TranscriptReader` capability delegates to the
  [`transcript`](transcript.md) readers.
