# Concepts

The vocabulary used across meta-harness, in rough dependency order. Other docs link into
the anchors here. For how these pieces are wired, see [Architecture](architecture.md);
for APIs, see the [module reference](modules/).

---

## Harness

An external, terminal-based AI coding agent that meta-harness supervises: **Claude
Code**, **Codex**, **OpenCode**, **pi**, or **Cursor**. Each is an interactive CLI with
its own TUI, output format, and session-log layout. Throughout the code a harness is
identified by a short name string — `"claude-code"`, `"codex"`, `"opencode"`, `"pi"`,
`"generic"` — which selects the per-harness [adapter](#adapter) and classifier. See
[Harnesses](harnesses.md) for the support matrix.

The **generic** harness is the fallback: no screen-specific detection, no session
control — just the status-driven turn mapping. Any unknown-but-launchable CLI can run as
`generic`.

---

## Context

The cancellation and deadline primitive, ported from Go's `context.Context`. Every
blocking [`Conversation`](#conversation) / [one-shot](modules/oneshot.md) method takes a
`Context` as its first argument.

- `Context.background()` — the root, never-cancelled context.
- `Context.withCancel(parent)` — a child plus an explicit `cancel(cause?)`.
- `Context.withDeadline(parent, ms)` — a child that auto-cancels after `ms`.
- `fromAbortSignal(signal, deadlineMs?)` — adapt a DOM `AbortSignal`.

Cancellation propagates parent → child. The *cause* is recoverable via `ctx.err()` and
is one of the sentinels `ctxCanceled` (explicit/abort) or `ctxDeadlineExceeded`
(timeout), so callers can distinguish a timeout from an abort. Lives in
[`meta-harness/async`](modules/async.md).

---

## Screen & Snapshot

The [`Screen`](modules/screen.md) is a headless VT100 emulator. Raw PTY bytes are fed in
with `write()`; a **`Snapshot`** — the rendered text (one `\n` per row, trailing
whitespace preserved), `cols`/`rows`, cursor position, and a monotonic `generation`
counter — is read out with `snapshot()`. The `generation` bumps on every write, which is
how higher layers detect change. Adapters read Snapshots to decide "what is the harness
showing right now?"

---

## Status

The wrapper's normalized verdict about a harness at a moment in time. One of:

| Status | Meaning | Terminal? |
| --- | --- | --- |
| `idle` | Harness exited cleanly (code 0). | yes |
| `failed` | Harness exited non-zero (no signal). | yes |
| `blocked_by_cost` | Hit a cost / quota / usage-limit fingerprint. | yes |
| `retry_later` | Transient API/transport error worth a backoff-respawn. | yes |
| `api_error` | Upstream API error (429, 5xx, …), carries `httpCode` + `retryAfter`. | no (by default) |
| `waiting_for_input` | Emitted an interactive prompt; awaiting stdin. | no |
| `stale` | No output for the stale threshold; a state notice, not actionable. | no |
| `interrupted` | Ended by signal, `stop()`, or context cancellation. | — |
| `unknown` | Exit couldn't be classified. | — |
| `binary_not_found` | Harness binary not on PATH. | — |

`Status` appears in three layers with the same string values: as the wrapper's outcome
([`wrapper`](modules/wrapper.md)), as the input to a turns adapter's
`onWrapperStatus` ([`turns`](modules/turns.md)), and folded into [turn state](#turn-state)
by chat.

---

## Error class

A stable, numeric taxonomy of *why* a harness failed, orthogonal to [`Status`](#status)
and designed for programmatic retry/backoff decisions:

`ErrNone` (0), `ErrRateLimited` (1), `ErrAuth` (2), `ErrBilling` (3),
`ErrModelNotFound` (4), `ErrContextOverflow` (5), `ErrTimeout` (6), `ErrTransient` (7),
`ErrUnknown` (8). `errorClassString()` renders the canonical display name (e.g.
`ErrAuth → "AuthFailure"`).

The key distinction the classifier draws: cost/quota hits split into `ErrRateLimited`
(transient — retry later) vs `ErrBilling` (fatal — needs a human), based on payment /
credit / quota-exceeded hints in the output.

---

## Effort & model

Two per-harness knobs meta-harness translates into each CLI's own flags:

- **Effort** — reasoning effort, one of `low` / `medium` / `high` / `xhigh` / `max`.
  Supported by Claude Code (`--effort <level>`) and Codex
  (`-c model_reasoning_effort=...`, mapping `max → xhigh`); ignored by the others.
- **Model** — a model override. Claude Code (`--model <m>`), Codex (`-c model=...`);
  ignored by the others.

An override you pass explicitly in `args` always wins over the translated one. See
[`wrapper`](modules/wrapper.md#effort--model).

---

## Turn

One exchange in a conversation. A **[chat Turn](modules/chat.md#turn-vocabulary)** (the persisted
record) has an `id`, `sessionID`, `role` (`user` / `assistant` / `system`),
[`state`](#turn-state), `text`, and error metadata (`reason`, `httpCode`, `retryAfter`,
timestamps). A **[transcript Turn](modules/transcript.md)** is the lossier
`{ role, text, timestamp? }` view projected from a harness's own log.

Note the two nearby-but-distinct meanings: a chat `Turn` is a stored row; a turns
[`Event`](#turn-event) is a live state transition.

### Turn state

The lifecycle of an assistant turn: `pending` → `streaming` → `complete` | `errored`.
A `send()` creates a `pending` assistant turn; the [watcher](#turn-event) drives it to
`complete` (with clean reply text) or `errored` (with a `reason`).

---

## Turn event

A typed state transition emitted by the [`turns`](modules/turns.md) layer as it watches
a harness. The vocabulary: `TurnComplete`, `ToolCall`, `Blocked`, `Errored`,
`InputRequested`, `InputResolved`. A [`Watcher`](modules/turns.md#the-watcher) merges two
sources — the rendered screen and the wrapper's status stream — into one ordered event
stream, which chat consumes to drive [turn state](#turn-state).

---

## Adapter

A per-harness object that teaches the upper layers how *this* harness behaves. In
[`turns`](modules/turns.md) an adapter has a required core (`name`, `onScreen`,
`onWrapperStatus`) plus **optional capabilities**, each a separate structural interface
the chat layer probes for:

- session id: `SessionIDExtractor`, `RawSessionIDExtractor`, `SessionIDLocator`,
  `SessionIDPrimer`, `SessionInitializer`
- session control: `SessionResumer`, `SessionForkResumer`, `SessionControlFlags`
- interaction: `BusyDetector`, `MessageExtractor`, `Quitter`
- history: `TranscriptReader`

An adapter implementing none still works (it behaves like `generic`). Each capability it
*does* implement lights up a corresponding feature. This "optional interface" model is
the main extension point — see [Guides › Adding a harness](guides/adding-a-harness.md).

---

## Conversation

The top-level object ([`meta-harness/chat`](modules/chat.md)): one supervised harness
process plus a chat API. You `Open()` it, `acquireControl()`, `send()`, observe
`events()`, read `history()`, and `close()`. It owns the [wrapper session](modules/wrapper.md#session),
the [watcher](#turn-event), a [screen](#screen--snapshot), and a [store](#store).

### Control acquisition

Only one mutating operation (`send` / `answer` / `quit`) may be in flight at a time.
`acquireControl(ctx)` blocks on a **FIFO turnstile** (a `ControlQueue`) and returns a
`release()` function. This serializes access to the single harness stdin.

---

## Session

Two different "sessions" name the same conversation from two sides — keeping them straight
avoids most confusion:

- **Chat session** (`conv.sessionID()`) — **meta-harness's own** id, minted the moment you
  `Open()`. Independent of the harness; it's what the [store](#store) is keyed on and what
  identifies the conversation to your code.
- **Harness session** (`harnessSessionID`) — the **harness's own** session id (a UUID the
  CLI assigns itself). Empty until meta-harness *captures* it — from the screen, a raw
  output line, or the on-disk log — and it's the id that actually [resumes](#resume) the
  harness and locates its [transcript](#transcript-vs-store-history).

**Why two?** meta-harness needs a stable handle the instant you `Open()` — for the store,
events, and turn records — but at that point the harness hasn't revealed its internal id
yet. So it mints its own immediately and captures the harness's id separately, whenever the
harness surfaces it.

| | Chat session id | Harness session id |
| --- | --- | --- |
| Created by | meta-harness, at `Open` | the harness CLI, internally |
| Available | immediately, always | only once captured (empty `""` until then) |
| Used for | the store, your records, `Reopen` | resuming the harness, reading its transcript |

A typical lifecycle:

```text
Open()              chat id = "a1b2c3…"    harnessSessionID = ""      (nothing to capture yet)
first turn runs     (unchanged)            harness reveals its UUID → captured → "9f8e7d6c…"
Reopen("a1b2c3…")   pass the chat id       → internally resumes the harness via "9f8e7d6c…"
```

So `Reopen` takes the *chat* id (you always have it) but resumes with the *harness* id —
which is why it throws `ErrNoHarnessSession` when a conversation never ran far enough to
capture one. (Exceptions: **pi** mints the harness id at launch via `--session-id`, and
`Open({ resume })` seeds it up front.)

The stored `Session` persists only `id`, `harness`, `workingDir`, `createdAt`, and
`harnessSessionID`; every other launch knob is re-supplied on `Reopen`.

### Resume

Relaunching a harness so it continues a prior [harness session](#session). Low-level:
`Open({ resume: harnessSessionID, … })` prepends the adapter's `resumeArgs` at launch.
Convenience: [`Reopen({ sessionID })`](modules/chat.md#resume) loads a stored chat
session and resumes from its captured `harnessSessionID`, reusing the *same* chat session
id. Requires the adapter to support resuming; throws `ErrResumeUnsupported` otherwise,
or `ErrNoHarnessSession` if the stored session never captured an id. See
[Guides › Resuming sessions](guides/resuming-sessions.md).

Some harnesses **fork** on resume (mint a *new* id rather than continuing the old one);
adapters signal this with `resumeForksSessionID()`, and chat arms a one-shot refresh to
overwrite the seeded id with the freshly-minted one.

---

## Store & history

### Store

The persistence interface chat writes sessions and turns through
([`Store`](modules/chat.md#the-store)): `createSession`, `getSession`, `updateSession`,
`appendTurn`, `updateTurn`, `listTurns`. [`MemStore`](modules/chat.md#the-store) (via
`newMemStore()`) is the in-memory default; a durable store is a matter of implementing
the same six methods.

### Transcript vs store history

`history()` returns the conversation's turns. `historyWithSource()` additionally tells
you *where they came from*:

- **`HistorySourceTranscript`** — parsed from the harness's own on-disk log via the
  adapter's [`TranscriptReader`](modules/transcript.md). Authoritative, used **only**
  when the adapter has a reader **and** a `harnessSessionID` has been captured.
- **`HistorySourceStore`** — from the [store](#store). Used otherwise, and as a graceful
  fallback when the transcript is missing or not yet flushed (a reader throwing
  `ErrSessionNotFound` / `ErrEmptySessionID` degrades to the store; genuine parse/permission
  errors propagate).

See [Guides › Reading history](guides/reading-history.md).

---

## Input request

When a harness blocks on an interactive prompt (trust dialog, y/n confirmation, a menu),
the turns layer reports an **`InputRequest`**: `{ id, kind, prompt, options? }`, where
each `InputOption` carries an `id`, a human `label`, a portable `alias` (`"proceed"` /
`"deny"` / `"yes"` / `"no"`), and the raw `keys` to write. The `id` is a content hash —
stable across redraws of the *same* prompt, different for a new one.

### Disposition & InputPolicy

How a pending [input request](#input-request) gets resolved, without a human necessarily
in the loop. A **`Disposition`** is one of `DispositionAsk` (surface it to the client),
`DispositionAnswer` (pick an option), or `DispositionDeny` (pick the deny option). An
**`InputPolicy`** maps prompt `kind` → `Disposition` (`byKind`), with an optional
`default`. chat resolves a prompt through a ladder: **auto-dismiss** (Codex startup
interstitials) → **InputPolicy** → **in-process `onInputRequest` handler** → **surface to
the client** (who then calls [`answer()`](modules/chat.md#answering-prompts)). See
[Guides › Handling input](guides/handling-input.md). The one-shot loop ships a canned
policy, [`AutoAcceptTrust`](modules/oneshot.md), so unattended turns never wedge on a
trust prompt.

---

## Readiness

Whether a harness's composer is ready to accept input. Some harnesses (`claude-code`,
`codex`, `pi`) need the prompt to be *ready* before keystrokes land, so `send()` waits
for it. The [`ready` helpers](modules/chat.md#readiness-helpers) —
`requiresPromptReadiness`, `readyForInput`, `submitKeyForHarness` — encode the
per-harness UI markers and the correct submit key (Codex/Claude Code use a kitty-protocol
`ESC [ 13 u`; pi uses CR; generic uses LF).

---

## Quiescence & idle completion

Not every harness prints an unambiguous "done" marker. For those that need it, chat runs
an **idle-completion** fallback: once a turn is in flight and the composer is
[ready](#readiness) and *settled* (no recent screen changes), the turn auto-completes on
a timer. Claude Code narrows the window using an end-of-turn marker (~2s) versus the
plain idle window (~8s). This is why, for some harnesses, `TurnComplete` on the wire does
not by itself finalize the turn — chat waits for the screen to quiesce first.

---

## Sentinel errors

Errors are identified the Go way: a **`Sentinel`** is a stable, identity-comparable error
object, and `isSentinel(err, ErrX)` walks the `cause` chain to test membership (the
analogue of `errors.Is`). The public API exposes many sentinels — `ErrResumeUnsupported`,
`ErrNoControl`, `ErrBinaryNotFound`, `ErrSessionNotFound`, … — and you match against them
by identity, never by message string. `isSentinel` itself stays private to the internal
toolkit; import it there in your own tests, or use the provided predicates like
`isBinaryNotFound`.
