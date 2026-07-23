# `meta-harness/wrapper`

Supervises a harness CLI under a pseudoterminal and normalizes its behavior. The wrapper
launches the binary, streams its PTY output into a [screen](screen.md), runs a
**classifier** on a fixed cadence, and folds everything — mid-run output _and_ the final
exit code — into a stable [`Status`](#status-values) and [`ErrorClass`](#error-taxonomy).
It owns the process lifecycle (start / wait / stop), stdin forwarding, resize, and a
durable line tap.

This is the layer the [`chat`](chat.md) and [`turns`](turns.md) layers build on. Two ways
in: the high-level [`run`](#run) (block until done, get a `Result`) and the low-level
[`start`](#start) (get a live [`Session`](#session) to observe and drive).

```ts
import {
  start, run, type RunContext,
  Session, type Result, type Snapshot, type SessionEvent,
  StatusIdle, /* … */,
  classifyOutput, type Classification, type Classifier, type ClassifierInput,
  ErrNone, ErrAuth, /* … */ errorClassString, type ErrorClass,
  ErrInvalidConfig, ErrBinaryNotFound, isBinaryNotFound, validateConfig, type Config,
  argsWithHarnessEffort, harnessSupportsEffort, isSupportedEffort, argsWithHarnessModel,
  isSupportedPermissionMode, harnessSupportsPermissionMode, argsWithHarnessPermissionMode,
  ErrPTYAllocation, ErrPTYRead,
  trace,
} from "meta-harness/wrapper"
```

---

## Quickstart

```ts
import { run } from "meta-harness/wrapper";
import { newScreen } from "meta-harness/screen";

const screen = newScreen(120, 40);
const { result, err } = await run(undefined, {
  binaryPath: "/usr/local/bin/claude",
  harness: "claude-code",
  args: ["-p", "hello"],
  stdout: screen,
});

console.log(result.status, result.class, result.exitCode);
// err is non-null only on a *wrapper* failure (bad config, missing binary, PTY alloc).
// A harness that ran and failed is reported in result, never thrown.
```

The crucial contract: **harness outcomes never throw.** `run` throws (via `err`) only
when the wrapper itself could not do its job. Everything the harness did — including
exiting non-zero, hitting a rate limit, or timing out — comes back in `result`.

---

## `Config`

```ts
interface Config {
  binaryPath?: string; // harness executable (required)
  stdout?: unknown; // PTY byte sink — a Screen, or any { write(Uint8Array) } (required)
  harness?: string; // "claude"/"claude-code", "codex", "cursor", "opencode", "pi"
  args?: string[]; // harness CLI args
  env?: string[]; // environment as "KEY=VALUE" entries
  effort?: string; // low | medium | high | xhigh | max
  model?: string; // model override
  permissionMode?: string; // plan | manual | ask | auto | bypass (+ native spellings)
  workingDir?: string;
  stdin?: unknown; // string | Uint8Array | async iterable, streamed to the PTY

  idleQuiet?: number; // ms of no output → "quiet"          (default 15_000)
  idleClassify?: number; // ms of no output → run classifier   (default 60_000)
  staleThreshold?: number; // ms of no output → StatusStale      (default 300_000)
  waitDelay?: number; // ms between SIGTERM and SIGKILL      (default 5_000)

  classifier?: Classifier | null; // override the per-harness classifier
  onLine?: ((line: string) => void) | null; // durable tap: one call per complete PTY line (ANSI intact)
  trace?: unknown; // a trace.Emitter for diagnostics
}
```

```ts
validateConfig(cfg: Config): Error | null
```

Validate without launching. Returns an error wrapping [`ErrInvalidConfig`](#errors) on
failure (e.g. missing `binaryPath`/`stdout`, or `idleClassify < idleQuiet`), else `null`.
`start`/`run` validate for you.

The idle thresholds are ordered: the classifier tick runs at `max(idleQuiet/3, 100)` ms;
`idleClassify` must be ≥ `idleQuiet`, and `staleThreshold` ≥ `idleClassify`.

---

## Launching

### `start`

```ts
start(ctx: RunContext | undefined, cfg: Config): Promise<Session>
```

Launch the harness under a PTY and return a live [`Session`](#session). Throws only on a
wrapper failure, with a cause chain you can match: [`ErrInvalidConfig`](#errors),
[`ErrBinaryNotFound`](#errors), [`ErrPTYAllocation`](#errors). Pass `undefined` for `ctx`
to run uncancelled.

### `run`

```ts
run(ctx: RunContext | undefined, cfg: Config): Promise<{ result: Result; err: Error | null }>
```

Convenience: `start` + `wait`. Always resolves with a `result`; `err` is non-null only on
a wrapper failure. If `start` failed with a missing binary, `result.status` is
`binary_not_found`.

### `RunContext`

```ts
interface RunContext {
  done(): Promise<void>; // resolves when cancelled
  err?(): unknown; // the cancellation cause
}
```

The wrapper's minimal cancellation surface — structurally satisfied by a
[`Context`](async.md) from `meta-harness/async`. When it fires, the harness is terminated
and the run ends as `StatusInterrupted`; a `ctxDeadlineExceeded` cause is reported as
"context deadline exceeded" (distinct from a plain cancel).

---

## `Session`

A live handle to the supervised harness.

```ts
class Session {
  pid(): number; // 0 until the PTY is open
  wait(): Promise<{ result: Result; err: Error | null }>; // block until terminated
  stop(ctx?): Promise<Error | null>; // graceful shutdown (SIGTERM → SIGKILL after waitDelay); idempotent
  snapshot(): Snapshot; // point-in-time { status, reason, lastOutputAt }
  events(): EventChannel; // ordered SessionEvent stream; closes after the terminal event
  recentOutput(): string; // last ~64 KB of raw PTY output (ANSI intact)
  writeStdin(data: Uint8Array): void; // forward keystrokes to the harness
  resize(cols: number, rows: number): void; // resize the PTY (0 values ignored)
  acquireWriter(): { release: () => void; ok: boolean }; // claim the exclusive stdin-writer lock
}
```

`acquireWriter` grants one exclusive writer; later callers get `ok: false` and should
treat themselves as read-only watchers (the restriction is advisory). This is what
[`chat`](chat.md) uses to guard the single harness stdin.

### `Result`

```ts
interface Result {
  status: Status;
  class: ErrorClass;
  exitCode: number;
  signal: string; // e.g. "interrupt", "terminated"; "" if not signalled
  reason: string;
  pid: number;
  startedAt: Date | null;
  endedAt: Date | null;
  lastOutputAt: Date | null;
}
```

### `SessionEvent`

```ts
interface SessionEvent {
  at: Date;
  status: Status;
  reason: string;
  terminated: boolean; // true when the run should end
  class: ErrorClass;
  httpCode: number; // upstream HTTP status for StatusAPIError, else 0
  retryAfter: number; // suggested wait (ms), else 0
  resumeAt: Date | null; // absolute reset instant parsed from a session-limit banner
}
```

Consumed by the [`turns.Watcher`](turns.md#the-watcher). Delivered through an
`EventChannel`:

```ts
class EventChannel {
  emit(e: SessionEvent): void; // enqueue (dropped if the buffer is full)
  receive(): Promise<EventRecv>; // { value, ok } — ok:false once closed and drained
  close(): void;
  [Symbol.asyncIterator](): AsyncIterator<SessionEvent>;
}
```

### Other exported session types

`Snapshot` (`{ status, reason, lastOutputAt }`), `EventRecv` (`{ value, ok }`),
`StdoutSink` (`{ write(data: Uint8Array): unknown }`), plus two low-level helpers:
`ClassifierFunc(fn)` adapts a plain function into a [`Classifier`](#classification), and
`classifyExit(exit, ctxCancelled, ctxErr?)` maps a finished PTY process into a status
(distinguishing deadline from cancel).

---

## Status values

```ts
type Status =
  | "idle"
  | "failed"
  | "blocked_by_cost"
  | "retry_later"
  | "api_error"
  | "waiting_for_input"
  | "stale"
  | "interrupted"
  | "unknown"
  | "binary_not_found";
```

Exported as constants: `StatusIdle`, `StatusFailed`, `StatusBlockedByCost`,
`StatusRetryLater`, `StatusAPIError`, `StatusWaitingForInput`, `StatusStale`,
`StatusInterrupted`, `StatusUnknown`, `StatusBinaryNotFound`. Meanings are tabulated in
[Concepts › Status](../concepts.md#status).

---

## Classification

The classifier turns harness output into a verdict.

```ts
classifyOutput(harness: string, output: string): Classification
```

One-shot classification over a finished output blob (forces `idle=true` so cost/retry
patterns are eligible). Returns a zero `Classification` (`status: ""`) when nothing
matches.

```ts
interface Classification {
  status: Status; // "" means "no classification" (a no-op; no state transition)
  class: ErrorClass;
  reason: string;
  terminal: boolean; // should the wrapper terminate to make progress?
  httpCode: number;
  retryAfter: number;
  resumeAt: Date | null;
}

interface ClassifierInput {
  recentOutput: string; // tail of PTY output (~64 KB), ANSI intact
  sinceLastOutput?: number; // ms since the last byte
  quiet?: boolean; // sinceLastOutput ≥ idleQuiet
  idle?: boolean; // sinceLastOutput ≥ idleClassify
}

interface Classifier {
  classify(input: ClassifierInput): Classification;
}
```

During a run the wrapper polls the resolved classifier every tick; classifiers are
**stateless** and re-invoked each time (output history is held by the wrapper, not the
classifier). The first `terminal: true` verdict terminates the harness. On a failing
exit with no mid-run verdict, a final one-shot pass runs over the recent output.

Classifier resolution: an explicit `cfg.classifier` wins; otherwise the `harness` name
selects a built-in pattern set (`claude`/`claude-code`, `codex`, `cursor`, `opencode`,
`pi`); otherwise a default that only catches cost/quota on idle. See
[Harnesses](../harnesses.md) for each set's fingerprints.

---

## Error taxonomy

```ts
type ErrorClass = number   // stable numeric enum
ErrNone (0) · ErrRateLimited (1) · ErrAuth (2) · ErrBilling (3) · ErrModelNotFound (4)
ErrContextOverflow (5) · ErrTimeout (6) · ErrTransient (7) · ErrUnknown (8)

errorClassString(c: ErrorClass): string   // canonical display name, e.g. ErrAuth → "AuthFailure"
```

Orthogonal to `Status`: `Status` says _what state_ the run is in, `ErrorClass` says _why_
it failed, in a form suitable for retry/backoff logic. The key split is cost/quota →
`ErrRateLimited` (transient) vs `ErrBilling` (fatal), decided by payment/credit hints in
the output. See [Concepts › Error class](../concepts.md#error-class).

---

## Effort & model

Translate the portable `effort`/`model` knobs into each harness's own flags. An override
already present in `args` always wins.

```ts
isSupportedEffort(effort: string): boolean        // low|medium|high|xhigh|max
harnessSupportsEffort(harness: string): boolean   // true for claude/claude-code, codex
argsWithHarnessEffort(harness: string, args: string[], effort: string): string[]
argsWithHarnessModel(harness: string, args: string[], model: string): string[]
```

- Claude Code: `--effort <level>`, `--model <m>`.
- Codex: `-c model_reasoning_effort="<level>"` (maps `max → xhigh`), `-c model="<m>"`.
- Cursor / OpenCode / pi: no effort or model translation.

---

## Permission mode

The third per-harness launch knob, beside effort and model. `Config.permissionMode` names
how much the guest may do without being asked, and the wrapper translates it into each
harness's own permission argv at launch.

```ts
isSupportedPermissionMode(harness: string, mode: string): boolean
harnessSupportsPermissionMode(harness: string): boolean   // true for claude/claude-code, codex
argsWithHarnessPermissionMode(harness: string, args: string[], mode: string): string[]
```

`isSupportedPermissionMode` takes the **harness**, deliberately unlike
`isSupportedEffort(effort)`: the accepted vocabulary genuinely differs per harness, so a
harness-blind predicate could only be the union of both — and would accept `dontAsk` on
Codex.

### The five rungs, least to most permissive

`plan` → `manual` → `ask` → `auto` → `bypass`.

**`ask` sits _above_ `manual`.** `manual` prompts before every edit; `ask` auto-accepts
edits and only asks about the rest. The name reads backwards, which is the single most
common misreading of this ladder — the ordering above is the authority, not the word.

### Per-harness translation

| Rung     | Claude Code                          | Codex                                    |
| -------- | ------------------------------------ | ---------------------------------------- |
| `plan`   | `--permission-mode plan`             | `-s read-only -a untrusted`              |
| `manual` | `--permission-mode manual`           | `-s workspace-write -a untrusted`        |
| `ask`    | `--permission-mode acceptEdits`      | `-s workspace-write -a on-request`       |
| `auto`   | `--permission-mode auto`             | `-s workspace-write -a never`            |
| `bypass` | `--permission-mode bypassPermissions` | `-s danger-full-access -a never`        |

Codex argv is `-s <sandbox> [-a <policy>]` — flags, never `-c sandbox_mode=…`.

**Native spellings are also accepted as input.** Claude Code additionally takes its own
`acceptEdits` (same argv as `ask`), `bypassPermissions` (same argv as `bypass`) and
`dontAsk`. Codex additionally takes its three native **sandbox** values — `read-only`,
`workspace-write`, `danger-full-access` — as a **single-axis** request: those emit
`-s <value>` only, leaving the approval axis to whatever `~/.codex/config.toml` holds. A
native sandbox value names half a posture, which is a valid request rather than an error.
Matching is case-sensitive; a wrong-case value is rejected loudly by `validateConfig`
rather than guessed.

- Unset or `""` injects nothing — the harness's own default wins.
- **An explicit flag or config override already present in `args` wins** and suppresses
  injection entirely — the same rule effort and model follow. It is all-or-nothing per
  harness, both axes at once: if the caller pinned only the sandbox, the wrapper does not
  half-inject an approval policy on top. On Claude Code the guard covers
  `--permission-mode` and the skip-permissions flags; on Codex it covers `-s`/`--sandbox`,
  `-a`/`--ask-for-approval`, `-p`/`--profile`,
  `--dangerously-bypass-approvals-and-sandbox`, and the `sandbox_mode` / `approval_policy`
  config keys in every `-c` spelling. (`-p` is guarded on Codex and **never** on Claude
  Code, where it is `--print`.)
- Codex `plan` is honestly **the launch half only**: `-s read-only -a untrusted` pins the
  permissions axis, but the collaboration axis stays unset. It is _not_ launch-time parity
  with Claude Code's `plan`.
- Cursor / OpenCode / pi: no permission-mode translation;
  `harnessSupportsPermissionMode` is `false` and `validateConfig` rejects a
  `permissionMode` on them.

Vocabulary probed at claude-code 2.1.217 / codex-cli 0.144.5. The rationale for the Codex
encoding — why `-s`/`-a` and not `-c`, why the guard is a strict superset of what we emit,
and why the rungs are ordered as they are — lives in
[`docs/design/permission-argv-parity.md`](../../design/permission-argv-parity.md).

---

## Errors

All are [sentinels](../concepts.md#sentinel-errors) — match by identity, not message.

| Sentinel            | Raised when                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `ErrInvalidConfig`  | `validateConfig`/`start` rejects the config.                                                                                     |
| `ErrBinaryNotFound` | The harness binary isn't found. Also detectable via `isBinaryNotFound(err)`, which walks the cause chain (and catches `ENOENT`). |
| `ErrPTYAllocation`  | The PTY bridge couldn't be spawned or the PTY died on open.                                                                      |
| `ErrPTYRead`        | A read on the PTY master failed.                                                                                                 |

```ts
isBinaryNotFound(err: unknown): boolean
```

---

## Diagnostics: `trace`

A structured event vocabulary for observing the wrapper internally, exported as a
namespace.

```ts
import { trace } from "meta-harness/wrapper"

interface trace.Event { at?: Date; kind: string; fields?: Record<string, unknown> }
interface trace.Emitter { emit(e: trace.Event): void }
trace.Discard: trace.Emitter                        // drops everything
trace.newWriterEmitter(w: trace.Writer): trace.Emitter   // one JSON event per line
trace.newLogAdapter(h: trace.LogHandler): trace.Emitter  // forward to a structured-log handler
```

Pass an emitter as `Config.trace` to see events like `pty_opened`, `harness_classified`,
`harness_blocked_by_cost`, `harness_stale`. `trace.LogRecord` (`{ time, message, attrs }`)
is the TS analogue of Go's `slog.Record`.

---

## How it works

- **The PTY bridge.** node-pty's native data stream didn't work under Bun (the reason
  the bridge exists), so the wrapper never drives the PTY in-process — it remains the
  bridged design under Node. It spawns a small Node helper,
  [`ptyHost.mjs`](../../../src/wrapper/internal/ptyHost.mjs), and talks to it over a
  length-framed stdio protocol (`r` ready, `o` output, `x` exit ← host; `i` stdin, `w`
  resize, `k` kill → host). Consequences for packaging are in
  [Architecture › The PTY bridge](../architecture.md#the-pty-bridge) and the
  [CLI doc](cli.md#packaging). `META_HARNESS_PTY_HOST` overrides the bridge path.
- **Output capture.** A ~64 KB ring buffer backs `recentOutput()`; a line splitter drives
  `onLine` synchronously once per `\n`-terminated line (used by `chat` for raw session-id
  capture and live transcript parsing). Slow `onLine` callbacks back-pressure the read
  loop — keep them cheap.
- **Exit classification.** `classifyExit` maps the finished process: context-cancel →
  `interrupted` (deadline vs abort distinguished), signal → `interrupted`, code 0 →
  `idle`, non-zero → `failed` (possibly upgraded by the final classification pass).

---

## Gotchas

- **Harness failure ≠ thrown error.** Only wrapper failures surface as `err`; the harness
  running and failing is always in `result`. Check `result.status`/`result.class`.
- **Classifiers are stateless.** They're re-run every tick; don't stash per-run state in
  one.
- **`status: ""` is a no-op.** A `Classification` with empty status records no transition
  — this is how a classifier declines to act.
- **`onLine` is synchronous and load-bearing.** It runs in the PTY read loop; blocking in
  it stalls output.
- **`stop()` is idempotent** and escalates SIGTERM → SIGKILL after `waitDelay`.
