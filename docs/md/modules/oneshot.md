# `meta-harness/oneshot`

The harness-agnostic one-shot turn loop: **prompt in → clean reply out, one turn, then
teardown.** It opens a [`Conversation`](chat.md) over a fresh harness, sends a single
prompt, waits for exactly one assistant turn to reach a terminal state, extracts the reply
text, and tears the process down. This is the loop shared by the in-process path and the
separate-process [`run` CLI](cli.md).

```ts
import {
  runOneShot, runOneShotDetailed,
  type OneShotConfig, type OneShotOutcome,
  DeadlineError, TurnErroredError, EmptyPromptError,
  cleanEnv, isLeakedClaudeEnv, AutoAcceptTrust,
} from "meta-harness/oneshot"
```

---

## `runOneShot`

```ts
runOneShot(ctx: Context, cfg: OneShotConfig): Promise<string>
```

Open, send `cfg.prompt`, and resolve with the clean reply of the single assistant turn —
always tearing down first. Throws on the expected failure modes:

- `EmptyPromptError` — `cfg.prompt` is blank.
- `DeadlineError` — `ctx`'s deadline fired before completion.
- `TurnErroredError` — the assistant turn errored (has a `.reason`).
- otherwise, the underlying error from `Open`/`send`.

```ts
import { runOneShot } from "meta-harness/oneshot"
import { Context } from "meta-harness/async"

const { ctx, cancel } = Context.withDeadline(Context.background(), 120_000)
try {
  const reply = await runOneShot(ctx, {
    harness: "claude-code",
    binaryPath: "/usr/local/bin/claude",
    prompt: "Summarize README.md in one sentence.",
    workingDir: process.cwd(),
  })
  console.log(reply)
} finally {
  cancel()
}
```

## `runOneShotDetailed`

```ts
runOneShotDetailed(ctx: Context, cfg: OneShotConfig): Promise<OneShotOutcome>
```

The failure-safe sibling: it **never throws** for expected outcomes, resolving instead
with a tagged union that preserves the captured harness session id even on deadline or
error — so you can read the transcript back afterward.

```ts
type OneShotOutcome =
  | { status: "completed";     reply: string;  harnessSessionID: string;  workingDir: string }
  | { status: "errored";       reason: string; harnessSessionID: string;  workingDir: string }
  | { status: "deadline";                      harnessSessionID: string;  workingDir: string }
  | { status: "startup_error"; reason: string; harnessSessionID?: string; workingDir: string }
```

The first three guarantee a `harnessSessionID` (the session became durable);
`startup_error` covers failures *before* a session existed (blank prompt, launch failure,
early PTY error, or a deadline during `Open`).

---

## `OneShotConfig`

```ts
interface OneShotConfig {
  harness: string          // adapter name, e.g. "claude-code", "codex"
  binaryPath: string       // absolute path to the harness binary
  prompt: string           // the text to submit
  args?: string[]
  workingDir?: string
  env?: string[]           // KEY=VALUE; run through cleanEnv() unless you handle it
  effort?: string
  model?: string
  cols?: number            // default 120
  rows?: number            // default 40
  idleGap?: number         // test-only ms overrides
  markerGap?: number
}
```

The loop installs the [`AutoAcceptTrust`](#environment-helpers) input policy and a fresh
`newMemStore()` internally, so a one-shot never wedges on a trust dialog and needs no store
from you.

---

## Errors

```ts
class DeadlineError extends Error {}                 // "one-shot: context deadline exceeded"
class TurnErroredError extends Error { reason: string }   // "one-shot: turn errored: <reason>"
class EmptyPromptError extends Error {}              // "one-shot: empty prompt"
```

`runOneShot` throws these; `runOneShotDetailed` maps them to the `deadline` / `errored` /
`startup_error` outcomes instead.

---

## Environment helpers

```ts
AutoAcceptTrust: InputPolicy   // answers the claude-code trust/bypass dialog with "proceed"
                               // (trust_prompt ONLY — see the question caveat below)
cleanEnv(env: string[]): string[]        // strip CLAUDECODE / CLAUDE_CODE_* so a nested harness is clean
isLeakedClaudeEnv(key: string): boolean  // predicate cleanEnv() uses
```

`AutoAcceptTrust` is `{ byKind: { trust_prompt: { kind: DispositionAnswer, optionID:
"proceed" } } }` — the same guard the Go `run.go` one-shot used, so an unattended turn is
never blocked behind Claude Code's folder-trust prompt. Pass your `env` through `cleanEnv`
(the [CLI](cli.md) does this for you) so a harness launched from inside Claude Code doesn't
inherit the outer session context.

> **Mid-turn prompt caveat.** `AutoAcceptTrust` covers `trust_prompt` only. If the
> model stops mid-turn to ask a [clarifying question](chat.md#clarifying-questions)
> (`question` / `question_review`), or Codex stops on a command / apply-patch approval
> (`approval_prompt`), the one-shot has no client to answer it and no `inputPolicy` knob
> to arm — the turn waits until the `ctx` deadline (`DeadlineError` / the `deadline`
> outcome). If your prompts can trigger `AskUserQuestion` or a Codex approval, either
> instruct the model not to ask (answer from assumptions instead) or drive a
> [conversation](chat.md) and answer the prompt.

---

## The loop, step by step

1. Reject a blank prompt (`EmptyPromptError`).
2. `Open(ctx, …)` with your config plus `inputPolicy: AutoAcceptTrust` and a fresh
   `newMemStore()`.
3. Acquire control, `send` the prompt, release.
4. Drain conversation [events](chat.md#observing) until the assistant turn reaches
   `complete` or `errored`, or `ctx` fires.
5. Return the reply (or throw `TurnErroredError`).
6. In `finally`, `close()` the conversation with a short deadline; close errors are
   suppressed.

For the CLI packaging of this loop and its exit-code contract, see the
[CLI module doc](cli.md).
