# meta-harness

A TypeScript toolkit for running CLI agent harnesses (Claude Code, Codex, OpenCode, pi, …)
under supervision and exposing them as programmable chat sessions.
Each of these tools ships as an interactive CLI with its own TUI, its own output format,
its own session-log layout, and its own idea of "the turn is done" — meta-harness hides
those differences behind one small, stable API. The package layers in five steps:

1. **`meta-harness/screen`** — a headless VT100 emulator ([`@xterm/headless`](https://www.npmjs.com/package/@xterm/headless))
   that turns the harness's raw PTY byte stream into queryable `Snapshot` state.
2. **`meta-harness/wrapper`** — supervises a harness process under a PTY, streams its
   output, and classifies the run into a small vocabulary of normalized states
   (`idle`, `failed`, `interrupted`, `waiting_for_input`, `blocked_by_cost`,
   `retry_later`, …).
3. **`meta-harness/turns`** — per-harness adapters that translate screen state +
   wrapper status into a small set of chat events (`TurnComplete`, `ToolCall`,
   `Blocked`, `Errored`).
4. **`meta-harness/transcript`** — read-only parsers for each harness's own on-disk
   session logs, normalized into one canonical event stream.
5. **`meta-harness/chat`** — the `Conversation` API: `Open`, `acquireControl`, `send`,
   `events`, `history`. Storage is pluggable via the `Store` interface;
   `newMemStore()` ships the in-memory default.

Two entry points sit on top: [`meta-harness/oneshot`](docs/md/modules/oneshot.md)
(_prompt in → clean reply out_, one turn, then teardown) and the
[`meta-harness-run` CLI](docs/md/modules/cli.md) (the same loop across a process
boundary). Transport layers stay out of the core: this repo ships one gateway,
`meta-harness-chatd` (HTTP + SSE) — see [Use over HTTP](#use-over-http).

```
                ┌──────────────────────────────┐
   entry points │ cli (run) · oneshot          │
                └──────────────┬───────────────┘
                               │
                ┌──────────────▼───────────────┐
   the core     │ chat (Conversation API)      │
                └──────────────┬───────────────┘
                               │
            ┌──────────────────┴──────────────────┐
            │                                     │
   ┌────────▼──────────┐               ┌──────────▼──────────┐
   │ turns             │               │ transcript          │
   │  +harness/codex   │               │  +codex             │
   │  +harness/cc      │               │  +claudecode        │
   │  +harness/opencode│               │  +pi                │
   │  +harness/pi      │               │ (read-only JSONL)   │
   │  +generic         │               └─────────────────────┘
   └────────┬──────────┘
            │
   ┌────────▼──────────┐
   │ screen            │  headless VT100 → Snapshot
   └────────┬──────────┘
            │
   ┌────────▼──────────┐
   │ wrapper           │  PTY supervisor + status classifier
   └───────────────────┘

   sideband: env / env-openshell / env-daytona (sandboxed turns)
             discovery · versions (harness ops)   async (Context, …)
```

> 📖 **Full documentation** lives under [`docs/md/`](docs/md/README.md) (canonical
> markdown, renders on GitHub), with a single-page visual overview at
> [`docs/html/index.html`](docs/html/index.html) and the pluggable-environments doc
> under [`docs/env/`](docs/env/README.md).
>
> Start at the [Getting started](docs/md/getting-started.md) guide, the
> [Architecture](docs/md/architecture.md) overview, or the
> [Concepts](docs/md/concepts.md) vocabulary.

## Install

Not published to npm — consumers pin a commit of this repo:

```sh
npm install github:olesho/meta-harness#<commit-sha>
```

`dist/` is committed, so a git install needs no build step. Node ≥ 18 (the docs target
≥ 20); the one native dep is `node-pty` for the PTY bridge. Every layer is a separate
subpath export — import only what you need:

```ts
import { Open } from "meta-harness/chat";
import { runOneShot } from "meta-harness/oneshot";
import { ClaudeCodeReader } from "meta-harness/transcript";
```

## Use the chat library

A `Conversation` is a long-lived, multi-turn, resumable session. The shape is always
**Open → acquire control → send → observe events → close.**

```ts
import {
  Open,
  newMemStore,
  EventTurn,
  TurnStateComplete,
} from "meta-harness/chat";
import { Context } from "meta-harness/async";

const ctx = Context.background();

const conv = await Open(ctx, {
  harness: "claude-code", // adapter + classifier selector
  binaryPath: "/usr/local/bin/claude", // the harness executable
  workingDir: process.cwd(),
  store: newMemStore(), // required; in-memory default
});

const release = await conv.acquireControl(ctx); // one mutating op at a time
try {
  const turnID = await conv.send(ctx, "summarize this project");
  for await (const ev of conv.events()) {
    if (
      ev.type === EventTurn &&
      ev.turn?.id === turnID &&
      ev.turn.state === TurnStateComplete
    )
      break;
  }
} finally {
  release();
}

const turns = await conv.history();
await conv.close(ctx);
```

See the [Chat API reference](docs/md/modules/chat.md) and the
[Conversation guide](docs/md/guides/conversation.md) for the full library reference.

## Use one-shot turns

```ts
import { runOneShot } from "meta-harness/oneshot";
import { Context } from "meta-harness/async";

const { ctx, cancel } = Context.withDeadline(Context.background(), 120_000);
try {
  const reply = await runOneShot(ctx, {
    harness: "claude-code",
    binaryPath: "/usr/local/bin/claude",
    workingDir: process.cwd(),
    prompt: "Summarize README.md in one sentence.",
  });
  console.log(reply);
} finally {
  cancel();
}
```

Failure modes are typed: `EmptyPromptError`, `DeadlineError`, `TurnErroredError`. See
[One-shot turns](docs/md/guides/one-shot-turns.md).

## Use as a CLI

```sh
echo "Summarize README.md in one sentence." | npx meta-harness-run claude -- --some-flag
```

stdin is the prompt, stdout the clean reply; exit codes are the orchestrator contract
(`0` complete, `1` errored, `2` usage, `124` deadline). The
[CLI guide](docs/md/modules/cli.md) documents the flags, the exit codes, and the
`HARNESS_WRAPPER_RUN_TIMEOUT` / `HARNESS_BINARY_*` environment overrides.

Five more bins ship alongside it: `meta-harness-wrapper` (foreground TTY passthrough +
tmux-detached subcommands — see [wrapper-cli](docs/md/modules/wrapper-cli.md)),
`meta-harness-structured-run` (one turn → one JSON line carrying reply **and**
transcript, for sandboxed runners), `meta-harness-check-versions` (offline drift check),
`meta-harness-hooks` (the out-of-process harness-hook entry point), and
`meta-harness-screenbench-record` (the corpus recorder behind `rebake-corpus`).

## Use over HTTP

`meta-harness-chatd` exposes the chat layer over HTTP + Server-Sent Events so non-Node
clients can drive multi-turn conversations across a process boundary:

```sh
npx meta-harness-chatd --bind 127.0.0.1:8080
```

It serves a stateless one-shot (`POST /v1/turns`) and a stateful multi-turn surface
(`/v1/conversations/**` + an SSE event stream). The daemon **spawns harness processes on
request**; v1 has no auth — bind to localhost only, never `0.0.0.0`. See the
[HTTP gateway guide](docs/md/modules/gateway.md) for the endpoint reference, the
control-token lifecycle, the SSE stream contract, the sentinel → HTTP error table, and a
**known defect that currently blocks `POST /v1/conversations`**.

## Supported harnesses

| Harness         | name          | binary     | pinned¹ | chat adapter²   | effort / model | transcript history³   |
| --------------- | ------------- | ---------- | ------- | --------------- | -------------- | --------------------- |
| **Claude Code** | `claude-code` | `claude`   | 2.1.201 | ✅ full         | ✅ / ✅        | ✅ `ClaudeCodeReader` |
| **Codex**       | `codex`       | `codex`    | 0.142.5 | ✅ full         | ✅ / ✅        | ✅ `CodexReader`      |
| **pi**          | `pi`          | `pi`       | 0.76.0  | ✅ full         | ❌ / ❌        | ✅ `PiReader`⁴        |
| **OpenCode**    | `opencode`    | `opencode` | —       | ◑ stub          | ❌ / ❌        | ❌ store only         |
| **Cursor**      | `cursor`      | —          | —       | ❌ wrapper-only | ❌ / ❌        | ❌ n/a                |
| _(fallback)_    | `generic`     | any        | —       | ◑ status-only   | ❌ / ❌        | ❌ store only         |

¹ From [`versions.json`](src/versions/versions.json) — the upstream release each adapter
is verified against. ² Whether `chat.resolveAdapter` maps the name. ³ Whether
`historyWithSource()` can serve transcript-backed history rather than the `Store`.
⁴ `PiReader.read` returns the lossy `Turn[]` view, not `Event[]`.

The per-capability detail (busy detection, session-id extraction, resume, input
requests) is in [Harnesses](docs/md/harnesses.md); the "adding a harness" workflow is in
[Adding a harness](docs/md/guides/adding-a-harness.md). Other harnesses are supported by
implementing the `Adapter` interface (plus the optional capability interfaces
`SessionIDExtractor` / `SessionResumer` / `TranscriptReader` / …).

## Layout

- `src/screen/` — headless VT100 emulator → `Snapshot`
- `src/wrapper/` — PTY supervisor + `Status` vocabulary; `src/wrapper/trace/` diagnostics
- `src/turns/` — turn-detection interface, `generic` fallback, per-harness adapters under `harness/`
- `src/transcript/` — read-only harness JSONL parsers (`claudecode`, `codex`, `pi`)
- `src/chat/` — `Conversation` API, `Store` interface, in-memory store, control token
- `src/oneshot/` — the harness-agnostic one-shot turn loop
- `src/harness/` — `runTurn` / `TurnResult`: one complete turn, opened and torn down
- `src/turnproto/` — the structured turn-result wire protocol
- `src/acquisition/` — output-acquisition planning for a turn
- `src/cli/` — `run`, `wrapper`, `structured-runner`, `check-versions`, `hooks`, `screenbench-record` front-ends
- `src/gateway/` — HTTP + SSE gateway (`meta-harness-chatd`) exposing `chat` to non-Node clients
- `src/env/`, `src/env-openshell/`, `src/env-daytona/` — pluggable environments: Provisioner × Containment for sandboxed turns
- `src/hooks/` — harness-hook providers, guards, and the event spool
- `src/discovery/` — "is harness X installed on PATH, at what version?"
- `src/versions/` — read API for the embedded `versions.json` (pinned upstream versions per harness)
- `src/async/` — the public `Context`; `src/internal/async/` the Go-style concurrency primitives behind it
- `test/corpus/` — recorded PTY byte streams used by the adapter compatibility tests
- `docs/md/` — canonical documentation sources; `docs/html/` — the rendered visual overview

## Testing

```sh
harness test      # vitest run — the release gate
harness ci        # the authoritative gate: pin-check + verify + lint + test
harness lint      # or: pnpm typecheck / pnpm build
```

The suite needs **no network and no harness binaries**: it exercises the wrapper
classifier, the turn adapters (replaying `test/corpus/`), the chat state machine
(against an in-process fake harness), the transcript parsers, and the public-surface
contract (`test/exports-guard.test.ts`, `test/contract.test.ts`).

Per-harness adapter tests double as the **compatibility test suite** — they replay
recorded byte streams and assert that turn detection still fires correctly.

## Drift-detection pipeline

When an upstream CLI ships a new version, TUI markers / classifier strings / transcript
schemas can shift and break the adapters. A local, developer-on-demand pipeline catches
that before users do:

```sh
pnpm check-versions   # offline pinned-vs-latest check for every pinned harness (npm registry)
pnpm drift-canary     # the tightest single-harness signal — codex (@openai/codex) only
pnpm rebake-corpus    # re-record the scripted scenarios against the real binaries (paid)
```

`check-versions` and `drift-canary` share one exit-code contract: `0` match, non-zero
drift. `src/versions/versions.json` pins each harness to the upstream version its adapter
was last verified against.

`rebake-corpus` drives the `meta-harness-screenbench-record` bin (build the tree first,
or point `META_HARNESS_SCREENBENCH_RECORD` at `dist/cli/screenbench-record.js`); it exits
`3` when the recorder is absent. Coverage is per-harness: `claude-code` records
_multi-turn_, _tool-call_, and _interrupted-mid-reply_; `codex` records the first two
(it has no interrupt seam); `pi` is pinned but has no scripted corpus and is skipped by
design.

## Autonomous pipeline

This project is wired to the `META-HARNESS` fleet-db workspace via the
`autonomous-dev-deploy` pipeline. Ship a plan from Claude Code with "ship this plan", or
check agents with "are the agents running?".
