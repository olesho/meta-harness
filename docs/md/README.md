# meta-harness documentation

`meta-harness` turns heterogeneous, terminal-based AI coding agents — **Claude Code**,
**Codex**, **OpenCode**, **pi**, and **Cursor** — into one uniform, programmable
surface. Each of these tools ships as an interactive CLI with its own TUI, its own
output format, its own session-log layout, and its own idea of "the turn is done."
meta-harness hides those differences behind a small, stable API.

Given a harness binary, meta-harness will:

- **Supervise** it under a pseudoterminal (PTY) and render its TUI through a headless
  terminal emulator.
- **Classify** its output and exit code into a stable status / error-class taxonomy
  (rate-limited, auth, billing, transient, waiting-for-input, …).
- **Detect turns** — tool calls, turn completion, interactive prompts, blocks — from
  the rendered screen and the wrapper's status stream.
- **Parse transcripts** — read the harness's own on-disk session logs into one
  canonical event stream.
- **Manage sessions** — capture the harness's session id, resume a prior session, and
  reopen a stored conversation.

On top of that it exposes two programming models:

- A **chat-style [`Conversation`](modules/chat.md)** — a long-lived, multi-turn,
  resumable session you drive with `send()` / `answer()` / `history()`.
- A **[one-shot loop](modules/oneshot.md)** — *prompt in → clean reply out*, one turn,
  then teardown — available both in-process and as a disposable [`run` CLI](modules/cli.md).

meta-harness is the substrate an orchestrator uses to run many autonomous coding
agents; it is a **library**, not an application.

> **Heritage.** This is a TypeScript port of a Go original, and the design shows it
> throughout: a Go-style `Context` for cancellation, `Channel` / `Mutex` concurrency
> primitives, and an "optional-interface" capability model for harness adapters. See
> [Architecture › Go heritage](architecture.md#go-heritage).

---

## Start here

| If you want to… | Read |
| --- | --- |
| Install, build, and run your first turn | **[Getting started](getting-started.md)** |
| Understand how the pieces fit together | **[Architecture](architecture.md)** |
| Learn the vocabulary (session, turn, status, …) | **[Concepts](concepts.md)** |
| Know what each harness supports | **[Harnesses](harnesses.md)** |
| Look up a specific module's API | **[Module reference](modules/)** |
| Follow a task-oriented walkthrough | **[Guides](guides/)** |
| See it visually (SVG diagrams) | **[HTML overview](../html/index.html)** |

---

## The layer cake

meta-harness is built in layers, each a separately importable subpath under the
`meta-harness/*` package. Higher layers depend on lower ones; nothing lower reaches up.

```
                       ┌──────────────────────────────────────────┐
   entry points        │  cli (run)          oneshot               │
                       └──────────────┬─────────────┬──────────────┘
                                      │             │
                       ┌──────────────▼─────────────▼──────────────┐
   the core            │                 chat                      │
                       │        (Conversation: one harness)        │
                       └───────┬───────────┬───────────┬───────────┘
                               │           │           │
             ┌─────────────────▼──┐  ┌─────▼──────┐  ┌─▼──────────────┐
   surfaces  │      wrapper       │  │   turns    │  │   transcript   │
             │ PTY + classify     │  │ turn events│  │ log → events   │
             └─────────┬──────────┘  └─────┬──────┘  └────────────────┘
                       │                   │
             ┌─────────▼───────────────────▼──────┐
   substrate │             screen                 │   ┌───────────────┐
             │   headless VT100 → Snapshot        │   │ discovery /   │
             └─────────────────┬──────────────────┘   │ versions      │
                               │                       │ (harness ops) │
             ┌─────────────────▼──────────────────┐    └───────────────┘
   private   │   internal/async  (Context, …)     │
             │   only Context is public →  async  │
             └────────────────────────────────────┘
```

| Layer | Subpath | What it does |
| --- | --- | --- |
| **chat** | [`meta-harness/chat`](modules/chat.md) | A `Conversation` owns one supervised harness and serves a chat API on top: `send`, `answer`, `history`, control acquisition, resume. |
| **oneshot** | [`meta-harness/oneshot`](modules/oneshot.md) | One prompt → one reply → teardown, atop `chat`. |
| **cli** | [`meta-harness-run`](modules/cli.md) | A disposable process that runs one one-shot turn (stdin → stdout). |
| **turns** | [`meta-harness/turns`](modules/turns.md) | Per-harness adapters that read screen snapshots + wrapper status into typed turn `Event`s, plus a `Watcher`. |
| **transcript** | [`meta-harness/transcript`](modules/transcript.md) | Parsers that turn a harness's on-disk session log into a canonical `Event` stream. |
| **wrapper** | [`meta-harness/wrapper`](modules/wrapper.md) | Launches the harness under a PTY, classifies its output and exit into `Status` / `ErrorClass`. |
| **screen** | [`meta-harness/screen`](modules/screen.md) | A headless VT100 emulator: raw PTY bytes → coherent `Snapshot`s + change notifications. |
| **discovery** | [`meta-harness/discovery`](modules/discovery.md) | Probes which harness CLIs are installed and at what version. |
| **versions** | [`meta-harness/versions`](modules/versions.md) | The pinned/known-good harness version catalog (`versions.json`). |
| **async** | [`meta-harness/async`](modules/async.md) | The one sanctioned bridge that exposes the internal `Context` cancellation primitive. |

---

## A 20-second taste

```ts
import { Open, newMemStore } from "meta-harness/chat"
import { Context } from "meta-harness/async"

const conv = await Open(Context.background(), {
  harness: "claude-code",
  binaryPath: "/usr/local/bin/claude",
  workingDir: process.cwd(),
  store: newMemStore(),
})

const release = await conv.acquireControl(Context.background())
try {
  const turnID = await conv.send(Context.background(), "List the files in this repo.")
  // …observe conv.events() until the turn with `turnID` completes…
} finally {
  release()
  await conv.close()
}
```

Prefer a single shot? See [`runOneShot`](modules/oneshot.md):

```ts
import { runOneShot } from "meta-harness/oneshot"
import { Context } from "meta-harness/async"

const { ctx } = Context.withDeadline(Context.background(), 120_000)
const reply = await runOneShot(ctx, {
  harness: "codex",
  binaryPath: "/usr/local/bin/codex",
  prompt: "Summarize README.md in one sentence.",
})
console.log(reply)
```

---

## Repository layout

```
src/
  index.ts            package root (exports VERSION only)
  async/              public Context bridge
  internal/async/     private Go-style concurrency toolkit
  screen/             headless terminal emulator
  wrapper/            PTY supervision + classification
  turns/              turn-detection adapters + watcher
  transcript/         on-disk log parsers
  chat/               the Conversation layer
  oneshot/            one-shot turn loop
  cli/                the `run` binary
  discovery/          harness version probing
  versions/           pinned version catalog
test/                 vitest suites + a recorded PTY corpus
dist/                 committed Node build (see Packaging)
```

See **[Architecture](architecture.md)** for how these relate, the module boundaries the
test suite enforces, and how the package is built and distributed for Node (Bun still
supported).
