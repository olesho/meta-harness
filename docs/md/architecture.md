# Architecture

This document explains how meta-harness is put together: the layers and the direction
of their dependencies, how data flows through a single turn, the seams that keep the
layers decoupled, the module boundaries the test suite enforces, the library's Go
heritage, and how it is packaged for both Bun and Node.

For the API of any individual layer, see the [module reference](modules/). For the
vocabulary used throughout, see [Concepts](concepts.md).

---

## Design in one sentence

> A harness is a terminal program; meta-harness renders its terminal, watches the
> render, classifies what it sees, and serves the result as a conversation.

Everything else is a consequence of taking that seriously across five different
harnesses that agree on almost nothing.

---

## The layers

meta-harness is a stack of single-purpose layers. Each is a separately importable
subpath (`meta-harness/<layer>`), and the dependency graph is acyclic and points
**downward** — the core (`chat`) sits on top of three "surface" layers, which sit on a
`screen` substrate, which sits on the private async toolkit.

```
   cli ─────────────► oneshot ─────────────► chat
                                              │
                        ┌─────────────────────┼─────────────────────┐
                        ▼                     ▼                      ▼
                     wrapper               turns               transcript
                        │                     │
                        └───────────┬─────────┘
                                    ▼
                                  screen
                                    │
                                    ▼
                            internal/async ──(only Context)──► async
```

### `internal/async` — the private toolkit

A Go-style concurrency kit: `Context` (cancellation + deadlines), `Channel<T>`,
`Mutex`, `ControlQueue`, and a `Sentinel`/`isSentinel` error-identity system. It is
**private** — nothing above may import from `src/internal/**` — with exactly one
sanctioned exception: the [`async`](modules/async.md) subpath re-exports `Context`
(and its cancellation sentinels + `fromAbortSignal`) because the public `chat` methods
take a `Context`. See [Module boundaries](#module-boundaries) for how this is enforced.

### `screen` — the substrate

A headless VT100 emulator (built on `@xterm/headless`). Raw PTY bytes go in via
`write()`; coherent [`Snapshot`](modules/screen.md)s (rendered text, dimensions, cursor,
a monotonic `generation` counter) come out via `snapshot()`. A `subscribe()` channel
fires after every write so higher layers react without polling. This is the single
source of "what is on the harness's screen right now."

### `wrapper` — supervision + classification

Launches the harness binary under a PTY, streams its bytes into a `screen`, and runs a
**classifier** on a fixed cadence that folds the output into a normalized
[`Status`](concepts.md#status) and [`ErrorClass`](concepts.md#error-class). It owns the
process lifecycle (`start` / `wait` / `stop`), stdin forwarding, resize, and the
exit-code classification. Per-harness "patterns" recognize each CLI's cost/quota,
API-error, and prompt fingerprints; per-harness `effort`/`model` translators rewrite
those knobs into each CLI's flags. See [`wrapper`](modules/wrapper.md).

### `turns` — turn detection

Interprets the pair *(screen snapshots, wrapper status events)* into a small vocabulary
of typed turn [`Event`](modules/turns.md#the-event-vocabulary)s: `ToolCall`,
`TurnComplete`, `Blocked`, `Errored`, `InputRequested`, `InputResolved`. Each harness
gets an **Adapter**; a `Watcher` runs two pumps (screen + status) and emits the merged
event stream. Adapters also carry the *optional capabilities* — session-id extraction,
resume args, quit sequence, transcript reading — that the chat layer probes. See
[`turns`](modules/turns.md).

### `transcript` — the canonical log

Independent of the live screen, these parsers read a harness's **own on-disk session
log** (Claude Code / Codex / pi JSONL) into a canonical
[`Event`](modules/transcript.md#the-canonical-event-model) stream, with stable
per-event identity and a durable wire codec. This is the authoritative history once a
harness has flushed its log. See [`transcript`](modules/transcript.md).

### `chat` — the core

A [`Conversation`](modules/chat.md) owns exactly one supervised harness process and
serves the chat-style API: exclusive control acquisition, `send`, interactive-prompt
`answer`, turn-state `events()`, `history`, `quit`, `close`, and session
`resume`/`Reopen`. Crucially, **chat does not reimplement supervision** — it consumes
the `wrapper` session, the `turns` watcher/adapter, and the `transcript` readers through
narrow interfaces (see [The Backend/Adapter seam](#the-backendadapter-seam)).

### `oneshot` + `cli` — the entry points

[`oneshot`](modules/oneshot.md) wraps `chat` into *prompt → single reply → teardown*.
[`cli`](modules/cli.md) (`meta-harness-run`) is that loop as a disposable process:
stdin → stdout, with orchestrator-friendly exit codes. These are what an orchestrator
actually `exec`s per turn.

### `discovery` + `versions` — harness ops

Cross-cutting helpers, not part of the turn path.
[`discovery`](modules/discovery.md) answers "is harness X installed, and at what
version?" by probing `X --version`. [`versions`](modules/versions.md) is the pinned
catalog (`versions.json`) tying each adapter's code to a known-good upstream release.

---

## Data flow: the life of a turn

Here is what happens end-to-end when you `send()` a message to a `Conversation`:

1. **You acquire control** (`acquireControl`) — a FIFO turnstile
   ([`ControlQueue`](modules/async.md)) guarantees only one `send`/`answer`/`quit` is in
   flight at a time.
2. **`send` records turns and writes keystrokes.** It appends a *user* turn (state
   `complete`) and a *pending assistant* turn to the [`Store`](modules/chat.md#the-store),
   waits for the composer to be [ready](concepts.md#readiness) for harnesses that need it,
   then `writeStdin`s your text plus the harness's submit key.
3. **The harness runs.** Its PTY bytes flow through the `wrapper` read loop into the
   `screen`, bumping the screen's `generation` and firing its subscription.
4. **Two pumps observe it.** The `turns` [`Watcher`](modules/turns.md#the-watcher) runs a
   *screen pump* (each snapshot → `adapter.onScreen`) and a *status pump* (each
   `wrapper` `SessionEvent` → `adapter.onWrapperStatus`), merging both into one
   `TurnEvent` stream.
5. **chat drives the state machine.** Each `TurnEvent` moves the pending assistant turn:
   `ToolCall` keeps it streaming, `Blocked`/`Errored` mark it errored (with
   `httpCode`/`retryAfter`), `InputRequested` surfaces a prompt, and `TurnComplete` (or,
   for some harnesses, an *idle-completion* fallback) marks it complete and extracts the
   clean reply text.
6. **Session id gets captured.** The first time the harness reveals its own session id —
   scraped from the screen, recovered from a raw output line, or located on disk — chat
   records it on the `Session` so the conversation can later be resumed.
7. **You observe completion** via `conv.events()` (or `history()`), then release control.

Two subtleties worth calling out, because they explain a lot of the code:

- **Turn completion is not always a single marker.** Claude Code, for example, defers
  completion: chat sees the end-of-turn marker, then waits for the screen to *settle*
  (an idle window) before declaring the turn done. See
  [Concepts › Quiescence](concepts.md#quiescence--idle-completion).
- **Interactive prompts are resolved through a policy ladder.** A surfaced
  [`InputRequest`](concepts.md#input-request) is first auto-dismissed (Codex startup
  interstitials), then matched against an [`InputPolicy`](concepts.md#disposition--inputpolicy),
  then an in-process handler, and only if none resolve it is it surfaced to you. See
  [Guides › Handling input](guides/handling-input.md).

---

## The Backend/Adapter seam

The chat layer is deliberately decoupled from the concrete `wrapper` and `turns`
implementations. It depends only on a set of **structural interfaces** declared in
[`src/chat/deps.ts`](../../src/chat/deps.ts):

- **`WrapperSession`** — the slice of a `wrapper` session chat needs: `writeStdin`,
  `acquireWriter`, `resize`, `stop`.
- **`Adapter`** — a turns adapter expressed as a bag of *optional* methods
  (`extractSessionID?`, `resumeArgs?`, `readTranscript?`, `busy?`, `quitSequence?`, …).
  An adapter that implements none still drives a conversation (that is the *generic*
  harness); each method it *does* implement lights up a capability.
- **`Watcher`** — the turn-event stream (`events()` + `close()`).
- **`Backend`** — the three injected dependencies bundled together: `resolveAdapter`,
  `start`, and `watch`.

This is the TypeScript analogue of Go's optional-interface pattern (`turns.Quitter`,
`turns.BusyDetector`, …): capabilities are discovered by structural presence, not by a
class hierarchy. The payoff is testability — the production path wires the real
PTY-backed session, while the test suite wires an in-process fake harness against the
*same* `Conversation` logic, unchanged. It is also the extension point: teaching
meta-harness a new harness is largely a matter of implementing more of these optional
methods (see [Guides › Adding a harness](guides/adding-a-harness.md)).

---

## Module boundaries

Two ideas are load-bearing enough that the test suite freezes them.

### No internal leakage

Public barrels (`src/*/index.ts`) may **never** re-export anything from
`src/internal/**`. The one exception is `meta-harness/async`, which surfaces *exactly*
`Context`, `ctxCanceled`, `ctxDeadlineExceeded`, and `fromAbortSignal` — and nothing
else from the internal toolkit (not `Channel`, not `Mutex`, not `isSentinel`).

Enforced by [`test/exports-guard.test.ts`](../../test/exports-guard.test.ts), which checks
both that no barrel's source contains an `internal` import path and that no internal
runtime symbol is reachable through any barrel.

### A frozen public surface

[`test/contract.test.ts`](../../test/contract.test.ts) serializes the entire public TS
surface — every exported name from every barrel, tagged with its runtime kind (function,
class + its method set, const value, type) — and diffs it against a committed golden
([`test/testdata/ts_surface.golden`](../../test/testdata/ts_surface.golden)). A rename, a
removed export, a changed constant, or a type→value reclassification fails loudly and
forces a conscious golden update:

```bash
UPDATE_GOLDEN=1 bun test test/contract.test.ts
```

This is the TS analogue of the Go original's `go_api.golden`, widened from one package
to the whole public surface. Practical upshot: **the public API in these docs is exactly
what ships**, because CI won't let it drift silently.

---

## Go heritage

meta-harness is a port of a Go codebase, and the port is faithful rather than
idiomatic-at-all-costs. Recognizing the Go shapes makes the TypeScript easier to read:

| Go concept | TypeScript port |
| --- | --- |
| `context.Context` | [`Context`](modules/async.md) with `background()` / `withCancel()` / `withDeadline()` |
| `chan T` | `Channel<T>` (`send`/`receive`/`close`, async-iterable) |
| `sync.Mutex` | `Mutex` (`lock`/`unlock`/`withLock`) |
| `errors.Is(err, ErrX)` | `isSentinel(err, ErrX)` walking the `cause` chain |
| sentinel errors (`var ErrX = errors.New(...)`) | `Sentinel` objects via `defineSentinel` |
| optional interfaces (`v, ok := x.(turns.Quitter)`) | optional methods probed via `typeof x.method === "function"` |
| `//go:embed versions.json` | `versions.json` read at module load |
| package `init()` | side-effect import (`import "./probes.ts"`) registering defaults |
| package-per-harness layout | adapter namespaces (`turns.claudecode`, `turns.codex`, …) |

The `Context` model is the one to internalize: cancellation and deadlines propagate
parent→child down a tree, a cancelled parent cancels its descendants, and the *cause*
(`ctxCanceled` vs `ctxDeadlineExceeded`) is recoverable so callers can tell an abort
from a timeout. This is why every blocking chat/oneshot method takes a `Context` as its
first argument.

---

## Packaging & distribution

meta-harness has **two consumers with two runtimes**, and the package serves both from
one source tree via conditional exports in [`package.json`](../../package.json):

```jsonc
"exports": {
  ".":     { "bun": "./src/index.ts", "types": "./dist/index.d.ts", "import": "./dist/index.js" },
  "./chat":{ "bun": "./src/chat/index.ts", "types": "./dist/chat/index.d.ts", "import": "./dist/chat/index.js" },
  // …one entry per subpath…
}
```

- **Bun consumers** (e.g. the orchestrator) resolve the `bun` condition and import the
  **raw `src/**` TypeScript** directly — no build step. The `bun` condition is listed
  **first** so Bun never falls through to `dist`.
- **Node consumers** (e.g. a bundler or sandbox runner) resolve `import` and load the
  **compiled `dist/**` JavaScript** (+ `.d.ts`).

`dist/` is **built and committed**. `npm run build` runs
[`scripts/build.mjs`](../../scripts/build.mjs), which:

1. Compiles `src/**` → `dist/**` (ESM + declarations) via
   [`tsconfig.build.json`](../../tsconfig.build.json). `rewriteRelativeImportExtensions`
   turns the source's `./foo.ts` specifiers into `./foo.js` for real Node ESM output.
   The Bun-only CLI (`src/cli`) and all tests are excluded.
2. Copies the raw PTY bridge `ptyHost.mjs` (not a `.ts` input, so `tsc` won't emit it)
   next to its compiled importer.

### The PTY bridge

The one piece of genuine runtime awkwardness: **node-pty's native data stream does not
work under Bun.** So `wrapper` never drives the PTY in-process — it spawns a small Node
helper, [`ptyHost.mjs`](../../src/wrapper/internal/ptyHost.mjs), and talks to it over a
length-framed stdio protocol. This has consequences for anyone shipping the CLI in a
container:

- a `node` interpreter must be on `PATH` (even though the CLI itself runs on Bun),
- `ptyHost.mjs` must exist on disk next to its importer,
- node-pty's compiled `pty.node` addon must be present for the image's libc/arch, and
- `bun build --compile` is therefore **not** self-contained.

The full image-layout guidance lives in [`src/cli/PACKAGING.md`](../../src/cli/PACKAGING.md)
and is summarized in the [CLI module doc](modules/cli.md#packaging).

---

## Where this fits: autonomous orchestration

meta-harness is developed and consumed inside an autonomous plan → ship → release →
redeploy pipeline (the `.orche` workspace and the `META-HARNESS` fleet-db workspace).
The [`run` CLI](modules/cli.md) is the seam: the orchestrator bakes it into an image and
`exec`s one turn per agent step, reading the reply off stdout and the outcome off the
exit code. The library's stable status/error taxonomy is what lets the orchestrator make
retry/backoff/escalation decisions without parsing free-form harness prose. This
pipeline is operational context, not part of the library's API; the library stands alone.
