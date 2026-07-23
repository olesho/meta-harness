# `meta-harness/chat`

The core of meta-harness. A **`Conversation`** owns exactly one supervised harness
process and serves a chat-style API on top: exclusive control acquisition, message
`send`, interactive-prompt `answer`, turn-state `events`, `history`, `quit`, `close`, and
session `resume`. It composes the layers below — [`wrapper`](wrapper.md) for supervision,
[`turns`](turns.md) for turn detection, [`transcript`](transcript.md) for history,
[`screen`](screen.md) for rendering — behind [narrow interfaces](../architecture.md#the-backendadapter-seam),
so it never reimplements them.

```ts
import {
  Open, Reopen, resolveAdapter, Conversation,
  type Options, type ReopenOptions,
  type Store, MemStore, newMemStore,
  type Session, type Turn, type TurnState, type Role,
  type ConversationEvent, type EventType, EventTurn, EventInputRequest, EventInputResolved,
  type InputRequest, type InputOption, type InputAnswer,
  type Disposition, type InputPolicy, DispositionAsk, DispositionAnswer, DispositionDeny,
  type HistorySource, HistorySourceTranscript, HistorySourceStore,
  submitKeyForHarness, requiresPromptReadiness, readyForInput, cleanHarnessEnv,
  ErrNoControl, ErrResumeUnsupported, /* … */,
} from "meta-harness/chat"
```

---

## Quickstart

```ts
import {
  Open,
  newMemStore,
  EventTurn,
  TurnStateComplete,
  TurnStateErrored,
} from "meta-harness/chat";
import { Context } from "meta-harness/async";

const ctx = Context.background();
const conv = await Open(ctx, {
  harness: "claude-code",
  binaryPath: "/usr/local/bin/claude",
  workingDir: process.cwd(),
  store: newMemStore(),
});

const release = await conv.acquireControl(ctx);
let turnID: string;
try {
  turnID = await conv.send(ctx, "What files are here?");
} finally {
  release();
}

for await (const ev of conv.events()) {
  if (ev.type === EventTurn && ev.turn?.id === turnID) {
    if (ev.turn.state === TurnStateComplete) {
      console.log(ev.turn.text);
      break;
    }
    if (ev.turn.state === TurnStateErrored) {
      console.error(ev.turn.reason);
      break;
    }
  }
}

await conv.close();
```

The shape never changes: **Open → acquireControl → send → observe events → close.** A
step-by-step version is in [Guides › Building a conversation](../guides/conversation.md).

---

## Opening a conversation

```ts
Open(ctx: Context | undefined, opts: Options): Promise<Conversation>
```

Resolve the adapter, launch the harness under a PTY, wire the screen + watcher, persist a
fresh [`Session`](#session), and return a live `Conversation`. Throws
[`ErrInvalidOptions`](#errors), [`ErrUnknownHarness`](#errors), or
[`ErrResumeUnsupported`](#errors).

```ts
resolveAdapter(name: string): Adapter
```

Map a harness name to its [`turns`](turns.md) adapter. Known: `"claude-code"`, `"codex"`,
`"opencode"`, `"pi"`, `"generic"`, `""`. Throws `ErrUnknownHarness` otherwise. (`"cursor"`
is **not** a chat harness — see [Harnesses](../harnesses.md#cursor).)

### `Options`

| Field                                  | Type                              | Notes                                                                                                                        |
| -------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `harness`                              | `string`                          | **Required.** Adapter name (above).                                                                                          |
| `binaryPath`                           | `string`                          | **Required.** Harness executable.                                                                                            |
| `store`                                | `Store`                           | **Required.** Persistence; pass [`newMemStore()`](#the-store) for the default.                                               |
| `args`                                 | `string[]`                        | Extra harness CLI args. Rejected if they collide with the adapter's [`sessionControlFlags`](turns.md#optional-capabilities). |
| `resume`                               | `string`                          | A [harness session id](../concepts.md#session) to resume (prepends the adapter's `resumeArgs`).                              |
| `workingDir`                           | `string`                          | Child cwd.                                                                                                                   |
| `env`                                  | `string[]`                        | Child env as `KEY=VALUE`. Omitted → inherits (and materializes) the parent env.                                              |
| `effort` / `model` / `permissionMode`  | `string`                          | Passed through to the [wrapper](wrapper.md#effort--model); `permissionMode` is a [rung](wrapper.md#permission-mode).         |
| `cols` / `rows`                        | `number`                          | PTY geometry (default 120×40).                                                                                               |
| `eventBuffer`                          | `number`                          | Sizes the event stream (default 32).                                                                                         |
| `inputPolicy`                          | `InputPolicy`                     | Pre-resolve interactive prompts without a live client.                                                                       |
| `onInputRequest`                       | `(req) => [InputAnswer, boolean]` | In-process fallback resolver.                                                                                                |
| `disableCodexAutoDismiss`              | `boolean`                         | Turn off Codex startup-interstitial auto-dismiss.                                                                            |
| `idleGap` / `markerGap` / `primeBound` | `number`                          | Test-only timing overrides (ms).                                                                                             |

---

## The `Conversation` class

You get one from `Open`/`Reopen`; you don't construct it directly. Methods that mutate the
harness require the [control token](#sending--control).

### Lifecycle

```ts
close(ctx?: Context): Promise<void>   // terminate harness, release writer, stop watcher; unblocks all awaiters with ErrClosed
isClosed(): boolean
```

### Sending & control

```ts
acquireControl(ctx: Context): Promise<() => void>   // block for the FIFO control token; returns release()
send(ctx: Context, text: string): Promise<string>    // record turns, write keystrokes; returns the assistant turn id
quit(ctx: Context): Promise<void>                     // graceful exit via the adapter's quit sequence
```

`send` requires control and no turn in flight; it appends a _user_ turn and a _pending
assistant_ turn, waits for [readiness](#readiness-helpers) where needed, and writes your
text + the harness submit key. It **returns the assistant turn id**, not the reply — the
reply arrives through [`events()`](#observing) as that turn reaches
`TurnStateComplete`. Throws [`ErrNoControl`](#errors), [`ErrTurnInFlight`](#errors),
[`ErrInputPending`](#errors); `quit` throws [`ErrQuitUnsupported`](#errors) if the harness
has no quit sequence.

### Answering prompts

```ts
answer(ctx: Context, requestID: string, ans: InputAnswer): Promise<void>
pendingInput(): InputRequest | null
```

`answer` resolves the currently-pending [interactive prompt](#interactive-input).
`requestID` must match the surfaced request. `ans` names an option by id, alias, or
label; multi-select prompts take `optionIDs` (every option to toggle before the commit).
Throws [`ErrNoInputPending`](#errors), [`ErrStaleInputRequest`](#errors),
[`ErrUnknownOption`](#errors), [`ErrNotMultiSelect`](#errors).

`pendingInput` is the polling counterpart of `EventInputRequest`: the prompt currently
awaiting a client answer (null when none) — how a caller that missed the event still
detects "the harness stopped and is asking something" and reads the question.

### Observing

```ts
events(): /* async-iterable */   // yields ConversationEvent; one consumer
```

The turn-state and input event stream. Iterate with `for await`. Do not open two
concurrent consumers of the same conversation.

### History & introspection

```ts
history(): Promise<Turn[]>
historyWithSource(): Promise<[Turn[], HistorySource]>
sessionID(): string                    // the chat session id
getAdapter(): Adapter
screenSnapshot(): Snapshot             // current rendered screen
wrapper(): WrapperSession | undefined  // escape hatch to the underlying session
```

---

## Turn vocabulary

```ts
type Role = "user" | "assistant" | "system"; // RoleUser, RoleAssistant, RoleSystem
type TurnState = "pending" | "streaming" | "complete" | "errored"; // TurnState* constants

interface Turn {
  id: string;
  sessionID: string;
  role: Role;
  state: TurnState;
  text: string; // your text on a user turn; the reply once an assistant turn completes
  reason: string; // set on an errored turn (mirrors the turn-event reason)
  startedAt: Date;
  completedAt: Date;
  httpCode: number; // upstream status from a Blocked transition, else 0
  retryAfter: number; // retry hint (ms) from the harness, else 0
}
```

An assistant turn moves `pending → streaming → complete | errored`. Details in
[Concepts › Turn](../concepts.md#turn).

### Conversation events

```ts
type EventType = "turn" | "input_request" | "input_resolved"; // EventTurn, EventInputRequest, EventInputResolved

interface ConversationEvent {
  type: EventType;
  turn?: Turn; // on EventTurn
  input?: InputRequest; // on EventInputRequest / EventInputResolved
  err?: unknown; // out-of-band errors (e.g. a Store failure)
}
```

---

## Sessions & persistence

### `Session`

```ts
interface Session {
  id: string; // the chat session id (fresh; distinct from the harness id)
  harness: string;
  workingDir: string;
  createdAt: Date;
  harnessSessionID: string; // the harness's own id; empty until captured
}
```

Only these five fields persist. Everything else about a launch (`binaryPath`, `env`,
`args`, `effort`, `model`, `permissionMode`, geometry, policies) is supplied by the caller
and is **not** restored by [`Reopen`](#resume). See [Concepts › Session](../concepts.md#session)
for the chat-vs-harness id distinction.

### The Store

```ts
interface Store {
  createSession(s: Session): Promise<void>
  getSession(id: string): Promise<Session>
  updateSession(s: Session): Promise<void>      // e.g. to backfill harnessSessionID
  appendTurn(t: Turn): Promise<void>            // preserves insertion order
  updateTurn(t: Turn): Promise<void>
  listTurns(sessionID: string): Promise<Turn[]> // insertion order
}

class MemStore implements Store {}
newMemStore(): MemStore
```

[`MemStore`](../concepts.md#store) is the in-memory default (lost on restart). A durable
store is just these six methods against your database of choice.

---

## Resume

```ts
Reopen(ctx: Context | undefined, opts: ReopenOptions): Promise<Conversation>

interface ReopenOptions extends Omit<Options, "harness" | "workingDir" | "resume"> {
  sessionID: string   // the chat session id from Conversation.sessionID()
}
```

`Reopen` loads a stored [`Session`](#session), derives `harness`/`workingDir`/`resume`
from it, relaunches in resume mode, and **reuses the same chat session id** so
`sessionID()` and `history()` reflect the resumed session. You still must supply the other
launch knobs (`binaryPath`, `store`, `env`, …) via `ReopenOptions`.

- Low-level alternative: `Open({ resume: harnessSessionID, … })`.
- Throws [`ErrNoHarnessSession`](#errors) if the stored session never captured a harness
  id, and [`ErrResumeUnsupported`](#errors) if the harness can't resume.
- Adapters that **fork** on resume (mint a new id) are handled with a one-shot provisional
  refresh of the seeded id.

Full walkthrough: [Guides › Resuming sessions](../guides/resuming-sessions.md).

---

## Interactive input

When the harness blocks on a prompt, chat resolves it through a ladder — **auto-dismiss**
(Codex interstitials) → **[`InputPolicy`](#input-types)** → **`onInputRequest` handler** →
**surface to you** via `EventInputRequest` (answer with [`answer()`](#answering-prompts)).

### Input types

```ts
interface InputRequest {
  id: string;
  kind: string;
  prompt: string;
  options?: InputOption[];
  header?: string; // kind "question": the dialog's tab label
  multiSelect?: boolean; // kind "question": answer with optionIDs
}
interface InputOption {
  id: string;
  alias?: string;
  label: string;
  description?: string;
}
interface InputAnswer {
  optionID?: string;
  optionIDs?: string[];
  text?: string;
}

type Disposition = { kind: DispositionKind; optionID?: string; text?: string };
type DispositionKind = "ask" | "answer" | "deny"; // DispositionAsk / DispositionAnswer / DispositionDeny
interface InputPolicy {
  default?: DispositionKind;
  byKind?: Record<string, Disposition>;
}
```

`byKind[req.kind]` wins over `default`. The client-surfaced `kind`s are `trust_prompt`,
`menu_select`, `confirm`, `text_input`, `question`, `question_review` (both below), and
`approval_prompt` (Codex's command / apply-patch approval dialog — options carry
`proceed`/`deny` aliases). See
[Guides › Handling input](../guides/handling-input.md) for the full ladder and recipes.

### Clarifying questions

When the harness stops mid-turn to ask the user something (Claude Code's
`AskUserQuestion` dialog), the turn does NOT complete — a request of kind `"question"`
surfaces instead (then `"question_review"` for the Submit/Cancel confirmation after the
last question of a multi-question or multi-select dialog). Answer options with
`{ optionID }` / `{ optionIDs }`; a free-text answer is a two-step — answer the
`"other"`-aliased option (declines the dialog; the turn completes) and `send` the text as
the next message. Full recipes:
[Guides › Handling input › Clarifying questions](../guides/handling-input.md#clarifying-questions-question--question_review).

---

## History source

```ts
type HistorySource = "transcript" | "store"; // HistorySourceTranscript / HistorySourceStore
```

`historyWithSource()` returns the turns plus where they came from. The transcript source is
used **only** when the adapter implements `readTranscript` **and** a `harnessSessionID`
has been captured; otherwise, and as a graceful fallback when the log isn't flushed yet,
history comes from the [store](#the-store). See
[Guides › Reading history](../guides/reading-history.md).

---

## Readiness helpers

```ts
requiresPromptReadiness(harness: string): boolean          // true for claude-code, codex, pi
readyForInput(harness: string, screenText: string): boolean
submitKeyForHarness(harness: string, screenText: string): Uint8Array
```

Encode the per-harness composer-ready markers and submit key (Codex/Claude Code use a
kitty-protocol `ESC [ 13 u`; pi uses CR; generic uses LF). `send` uses them internally;
they're exported for callers driving a harness directly. See
[Concepts › Readiness](../concepts.md#readiness).

## Environment helper

```ts
cleanHarnessEnv(env?: string[] | null): string[]
```

Strip Claude Code nesting markers (`CLAUDECODE`, `CLAUDE_CODE_*`) so a nested harness
doesn't inherit the outer session context. With no argument, it materializes and cleans
the parent environment.

---

## Errors

All [sentinels](../concepts.md#sentinel-errors) — match by identity.

| Sentinel               | Raised when                                                   |
| ---------------------- | ------------------------------------------------------------- |
| `ErrInvalidOptions`    | `Open`/`Reopen` got incomplete/inconsistent options.          |
| `ErrUnknownHarness`    | `resolveAdapter` can't map the name.                          |
| `ErrNoControl`         | `send`/`quit`/`answer` without the control token.             |
| `ErrTurnInFlight`      | `send` while an assistant turn is still running.              |
| `ErrClosed`            | Any method after `close()`.                                   |
| `ErrInputPending`      | `send` while a client-facing prompt is pending.               |
| `ErrNoInputPending`    | `answer` with no prompt pending.                              |
| `ErrStaleInputRequest` | `answer` with a `requestID` that isn't the current prompt.    |
| `ErrUnknownOption`     | `answer` with an option id/alias that matches none.           |
| `ErrNotMultiSelect`    | `answer` with several `optionIDs` on a single-select prompt.  |
| `ErrQuitUnsupported`   | `quit` on a harness with no quit sequence.                    |
| `ErrResumeUnsupported` | `resume`/`Reopen` on a harness that can't resume.             |
| `ErrNoHarnessSession`  | `Reopen` when the stored session never captured a harness id. |

---

## Gotchas

- **Control is exclusive and FIFO.** Hold it only as long as needed and always
  `release()` in a `finally`; awaiting a never-resolving promise while holding it
  deadlocks subsequent `send`/`answer`/`quit`.
- **`send` returns a turn id, not a reply.** Read the reply from `events()` / `history()`.
- **Completion can lag the marker.** For harnesses needing readiness (claude-code, codex,
  pi), a turn finalizes only after the screen _settles_ — see
  [Quiescence](../concepts.md#quiescence--idle-completion). A `TurnComplete` on the wire
  does not by itself mean the chat turn is done.
- **First captured session id wins.** Once `harnessSessionID` is set it isn't overwritten
  — except the one-shot provisional refresh for resume-fork adapters.
- **Only supply `env` to strip it.** With `env` omitted the child inherits the parent
  environment as-is; to remove `CLAUDECODE` markers, pass `cleanHarnessEnv()` explicitly.
- **One event consumer.** Don't iterate `events()` from two places on the same
  conversation.
