# Getting started

This walks you from a clone to a running turn — first as a full
[`Conversation`](modules/chat.md), then as a [one-shot](modules/oneshot.md) call and the
[`run` CLI](modules/cli.md). For the concepts behind the code, read
[Concepts](concepts.md); for the big picture, [Architecture](architecture.md).

---

## Prerequisites

- **[Bun](https://bun.sh)** ≥ 1.1 — the primary runtime and test runner.
- **Node.js** ≥ 20 on `PATH` — required at runtime even under Bun, because the PTY
  bridge (`ptyHost.mjs`) runs on Node. See
  [Architecture › The PTY bridge](architecture.md#the-pty-bridge).
- **At least one harness binary** to actually drive — `claude`, `codex`, `opencode`,
  or `pi` — installed and on `PATH` (or with a known absolute path). Check what you have
  with [`discovery`](modules/discovery.md):

  ```bash
  # from the checkout:
  bun -e 'import("./src/discovery/index.ts").then(d => console.log(d.discover()))'
  # as a consumer of the package: import("meta-harness/discovery")
  ```

You do **not** need a harness binary to work on the library itself or run its tests —
the suite uses recorded corpora and in-process fakes.

---

## Install

```bash
bun install
```

---

## Verify the checkout

```bash
bun test        # the full suite — this is the release gate
bun run typecheck   # tsc --noEmit against src + test
```

`bun test` is the project's release gate: it exercises the wrapper classifier, the turn
adapters (against a recorded PTY corpus), the chat state machine (against an in-process
fake harness), the transcript parsers, and the public-surface contract. It needs no
network and no harness binaries.

---

## Build (for Node consumers)

Bun consumers import `src/**` directly and never need a build. If you are consuming
meta-harness from **Node**, build the committed `dist/`:

```bash
bun run build       # runs scripts/build.mjs → dist/** (ESM + .d.ts) + ptyHost.mjs
```

See [Architecture › Packaging](architecture.md#packaging--distribution) for why `dist/`
is committed and how the export conditions route Bun vs Node.

---

## Your first conversation

A [`Conversation`](modules/chat.md) is a long-lived, multi-turn session. The shape is
always: **Open → acquire control → send → observe events → close.**

```ts
import { Open, newMemStore, EventTurn, TurnStateComplete, TurnStateErrored } from "meta-harness/chat"
import { Context } from "meta-harness/async"

const ctx = Context.background()

const conv = await Open(ctx, {
  harness: "claude-code",                 // adapter + classifier selector
  binaryPath: "/usr/local/bin/claude",    // the harness executable
  workingDir: process.cwd(),
  store: newMemStore(),                    // required; in-memory default
})

// One mutating operation at a time — take the control token.
const release = await conv.acquireControl(ctx)
let assistantTurnID: string
try {
  assistantTurnID = await conv.send(ctx, "List the files in this directory.")
} finally {
  release()
}

// Observe the event stream until our assistant turn reaches a terminal state.
for await (const ev of conv.events()) {
  if (ev.type === EventTurn && ev.turn?.id === assistantTurnID) {
    if (ev.turn.state === TurnStateComplete) {
      console.log("reply:", ev.turn.text)
      break
    }
    if (ev.turn.state === TurnStateErrored) {
      console.error("turn errored:", ev.turn.reason)
      break
    }
  }
}

await conv.close()
```

Key points:

- **`Context` first.** Every blocking method takes a `Context`. Use
  `Context.withDeadline(Context.background(), ms)` to bound a call.
- **Control is exclusive.** `send`, `answer`, and `quit` require the control token from
  `acquireControl`. Always `release()` in a `finally`.
- **`send` returns the assistant turn id**, not the reply. The reply arrives through
  `events()` (or later via `history()`), because a turn can take many screen updates,
  tool calls, and possibly an interactive prompt before it completes.
- **Interactive prompts** (trust dialogs, y/n) surface as `EventInputRequest`; resolve
  them with `conv.answer(...)` or pre-configure an
  [`inputPolicy`](guides/handling-input.md).

Full walkthrough: [Guides › Building a conversation](guides/conversation.md).

---

## Your first one-shot

When you just want *prompt in → reply out*, skip the ceremony and use
[`runOneShot`](modules/oneshot.md). It opens a fresh harness, sends one prompt, waits for
exactly one assistant turn, returns the clean text, and tears everything down.

```ts
import { runOneShot } from "meta-harness/oneshot"
import { Context } from "meta-harness/async"

const { ctx, cancel } = Context.withDeadline(Context.background(), 120_000)
try {
  const reply = await runOneShot(ctx, {
    harness: "codex",
    binaryPath: "/usr/local/bin/codex",
    prompt: "Summarize this repo's README in one sentence.",
    workingDir: process.cwd(),
  })
  console.log(reply)
} finally {
  cancel()
}
```

`runOneShot` throws `EmptyPromptError`, `DeadlineError`, or `TurnErroredError` for the
expected failure modes. If you need the outcome (including the captured harness session
id) *without* exceptions — e.g. to read the transcript back after a deadline — use
[`runOneShotDetailed`](modules/oneshot.md), which resolves with a tagged union instead.

---

## The `run` CLI

The same one-shot loop is available as a disposable process — prompt on **stdin**, clean
reply on **stdout** — which is how an orchestrator invokes a turn:

```bash
echo "Summarize README.md in one sentence." | bun src/cli/run.ts claude -- --some-harness-flag
```

Grammar: `run [--effort E] [--model M] <name> -- <harness args…>`. Exit codes are
orchestrator-friendly: `0` ok, `1` errored/fatal, `2` usage, `124` deadline. Configure
the harness binary and per-run timeout through the environment
(`HARNESS_BINARY*`, `HARNESS_WRAPPER_RUN_TIMEOUT`). Full details, including the container
packaging constraints, are in the [CLI module doc](modules/cli.md).

---

## Where to go next

- **[Concepts](concepts.md)** — session vs harness-session, status, turn events, input
  policy, readiness, quiescence.
- **[Guides](guides/)** — conversations, one-shot turns, resuming sessions, handling
  input, and adding a new harness.
- **[Module reference](modules/)** — the full API of each layer.
- **[Harnesses](harnesses.md)** — what each harness supports.
