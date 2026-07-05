# One-shot turns

When you want a single *prompt → reply* and nothing more, skip the
[`Conversation`](../modules/chat.md) ceremony and use the
[one-shot loop](../modules/oneshot.md). It opens a fresh harness, sends one prompt, waits
for exactly one assistant turn, returns the clean text, and tears everything down — trust
prompts auto-accepted, no store to manage.

There are three ways to run it: in-process (throwing), in-process (failure-safe), and as
the [`run` CLI](../modules/cli.md).

---

## In-process, the simple way

```ts
import { runOneShot } from "meta-harness/oneshot"
import { Context } from "meta-harness/async"

const { ctx, cancel } = Context.withDeadline(Context.background(), 120_000)
try {
  const reply = await runOneShot(ctx, {
    harness: "codex",
    binaryPath: "/usr/local/bin/codex",
    prompt: "Summarize README.md in one sentence.",
    workingDir: process.cwd(),
  })
  console.log(reply)
} finally {
  cancel()   // always release the deadline timer
}
```

**Always pass a deadline.** A one-shot with `Context.background()` will wait forever on a
wedged harness. `Context.withDeadline` gives you a timer *and* a `cancel()` you must call
in a `finally`.

`runOneShot` throws for the expected failures:

```ts
import { EmptyPromptError, DeadlineError, TurnErroredError } from "meta-harness/oneshot"

try {
  const reply = await runOneShot(ctx, cfg)
} catch (err) {
  if (err instanceof DeadlineError)     { /* timed out */ }
  else if (err instanceof TurnErroredError) { console.error(err.reason) }
  else if (err instanceof EmptyPromptError) { /* blank prompt */ }
  else throw err
}
```

---

## In-process, failure-safe

When you need the outcome *and* the harness session id even on failure — for example to
read the transcript back after a timeout — use
[`runOneShotDetailed`](../modules/oneshot.md#runoneshotdetailed). It never throws for
expected outcomes; it resolves with a tagged union:

```ts
import { runOneShotDetailed } from "meta-harness/oneshot"

const outcome = await runOneShotDetailed(ctx, cfg)
switch (outcome.status) {
  case "completed":     console.log(outcome.reply); break
  case "errored":       console.error("errored:", outcome.reason); break
  case "deadline":      console.error("timed out; session:", outcome.harnessSessionID); break
  case "startup_error": console.error("never started:", outcome.reason); break
}
```

The `completed` / `errored` / `deadline` outcomes all carry a `harnessSessionID` you can
hand to a [transcript reader](reading-history.md) or a later
[`Reopen`](resuming-sessions.md).

---

## Passing effort, model, and args

```ts
await runOneShot(ctx, {
  harness: "claude-code",
  binaryPath: "/usr/local/bin/claude",
  prompt: "Refactor the parser for clarity.",
  effort: "high",              // translated to the harness's own flag
  model: "opus",
  args: ["--some-harness-flag"],
  env: process.env ? undefined : [],   // omit to inherit; the loop cleans CLAUDECODE markers for you
})
```

`effort`/`model` only affect harnesses that support them ([Claude Code, Codex](../harnesses.md)).
The loop installs [`AutoAcceptTrust`](../modules/oneshot.md#environment-helpers) so a
Claude Code folder-trust prompt never wedges the run.

---

## As a process: the `run` CLI

The same loop as a disposable command — prompt on stdin, reply on stdout — which is how an
orchestrator invokes a turn:

```bash
echo "Summarize README.md in one sentence." \
  | HARNESS_WRAPPER_RUN_TIMEOUT=5m bun src/cli/run.ts claude -- --some-flag
```

Exit codes are the contract: `0` ok, `1` errored/fatal, `2` usage, `124` deadline (with a
fixed stderr anchor line). Point it at a binary with `HARNESS_BINARY` /
`HARNESS_BINARY_<NAME>`. Full grammar, exit codes, and container-packaging constraints are
in the [CLI module doc](../modules/cli.md).

---

## One-shot vs conversation

| | one-shot | [conversation](conversation.md) |
| --- | --- | --- |
| Turns | exactly one | many |
| Process lifetime | opened + torn down per call | persists across turns |
| Trust prompts | auto-accepted | you handle / policy |
| Store | internal `MemStore` | yours |
| Interactive answers | no | `answer()` |
| Best for | orchestrated steps, batch prompts | interactive sessions, follow-ups |

Reach for one-shot for orchestrated or batch work; reach for a conversation when you need
follow-up turns or interactive prompt handling.
