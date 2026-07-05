# Building a conversation

A [`Conversation`](../modules/chat.md) is a long-lived, multi-turn session over one
supervised harness. This guide drives it end to end: open, send, wait for the reply,
send again, handle errors, read history, close. For the vocabulary, see
[Concepts](../concepts.md).

---

## 1. Open

```ts
import { Open, newMemStore } from "meta-harness/chat"
import { Context } from "meta-harness/async"

const ctx = Context.background()

const conv = await Open(ctx, {
  harness: "claude-code",
  binaryPath: "/usr/local/bin/claude",
  workingDir: process.cwd(),
  store: newMemStore(),
})
```

`harness`, `binaryPath`, and `store` are required. `Open` launches the harness under a
PTY, wires the [screen](../modules/screen.md) and [watcher](../modules/turns.md#the-watcher),
persists a fresh [`Session`](../modules/chat.md#session), and (for Codex) primes the
session id. See [`Options`](../modules/chat.md#options) for every knob.

---

## 2. A helper to await a turn

`send` returns the *assistant turn id*; the reply arrives asynchronously through
[`events()`](../modules/chat.md#observing). This small helper waits for a specific turn to
reach a terminal state — you'll reuse it every turn:

```ts
import { EventTurn, TurnStateComplete, TurnStateErrored, type Turn } from "meta-harness/chat"

async function awaitTurn(conv, turnID: string): Promise<Turn> {
  for await (const ev of conv.events()) {
    if (ev.type === EventTurn && ev.turn?.id === turnID) {
      if (ev.turn.state === TurnStateComplete || ev.turn.state === TurnStateErrored) {
        return ev.turn
      }
    }
    // ev.type === EventInputRequest here means the harness is blocked on a prompt;
    // see the Handling input guide.
  }
  throw new Error("event stream ended before the turn completed")
}
```

> **One consumer.** Iterate `events()` from a single place. If you need to fan out, tee
> the stream yourself.

---

## 3. Send and wait

Every mutating call needs the [control token](../modules/chat.md#sending--control). Take
it, send, and release promptly:

```ts
async function ask(conv, ctx, text: string): Promise<Turn> {
  const release = await conv.acquireControl(ctx)
  let turnID: string
  try {
    turnID = await conv.send(ctx, text)
  } finally {
    release()               // release BEFORE awaiting the reply, so the harness isn't blocked
  }
  return awaitTurn(conv, turnID)
}

const t1 = await ask(conv, ctx, "List the files in this directory.")
if (t1.state === TurnStateComplete) console.log(t1.text)
else console.error("errored:", t1.reason)
```

Note the ordering: **release control before awaiting the reply.** `send` only needs
control to write the keystrokes; holding it while you wait would block nothing useful and
risks deadlocking the next call.

---

## 4. Multi-turn

Because the harness process persists, the next `send` continues the same session — the
model keeps its context:

```ts
const t2 = await ask(conv, ctx, "Now show me the largest of those files.")
console.log(t2.text)
```

Send them strictly one at a time. `send` throws
[`ErrTurnInFlight`](../modules/chat.md#errors) if a previous assistant turn hasn't
finished — the `awaitTurn` in `ask` enforces that ordering for you.

---

## 5. Handle the failure modes

An errored turn carries a [`reason`](../modules/chat.md#turn-vocabulary) and, for API
blocks, `httpCode` / `retryAfter`:

```ts
const t = await ask(conv, ctx, "…")
if (t.state === TurnStateErrored) {
  console.error(`turn failed: ${t.reason}` +
    (t.httpCode ? ` (HTTP ${t.httpCode}, retry after ${t.retryAfter}ms)` : ""))
}
```

Bound any call with a deadline so a wedged harness can't hang you:

```ts
const { ctx: bounded, cancel } = Context.withDeadline(Context.background(), 120_000)
try {
  await ask(conv, bounded, "…")   // acquireControl / send reject if the deadline fires
} finally {
  cancel()
}
```

Interactive prompts (trust dialogs, y/n) surface as `EventInputRequest` rather than
completing the turn — resolve them per [Handling input](handling-input.md), or pre-arm an
[`inputPolicy`](../modules/chat.md#interactive-input) at `Open`.

---

## 6. Read history, then close

```ts
const turns = await conv.history()
for (const t of turns) console.log(`${t.role}: ${t.text}`)

await conv.close()
```

`close()` terminates the harness, releases the writer lock, stops the watcher, and unblocks
any awaiters with [`ErrClosed`](../modules/chat.md#errors). Always close — a leaked
conversation leaks a process. To distinguish store-backed from transcript-backed history,
use [`historyWithSource()`](reading-history.md).

---

## The whole thing

```ts
import { Open, newMemStore, EventTurn, TurnStateComplete, TurnStateErrored } from "meta-harness/chat"
import { Context } from "meta-harness/async"

const ctx = Context.background()
const conv = await Open(ctx, {
  harness: "claude-code",
  binaryPath: "/usr/local/bin/claude",
  workingDir: process.cwd(),
  store: newMemStore(),
})

async function awaitTurn(conv, turnID) {
  for await (const ev of conv.events())
    if (ev.type === EventTurn && ev.turn?.id === turnID &&
        (ev.turn.state === TurnStateComplete || ev.turn.state === TurnStateErrored))
      return ev.turn
  throw new Error("stream ended early")
}

async function ask(conv, ctx, text) {
  const release = await conv.acquireControl(ctx)
  let id
  try { id = await conv.send(ctx, text) } finally { release() }
  return awaitTurn(conv, id)
}

try {
  console.log((await ask(conv, ctx, "List the files here.")).text)
  console.log((await ask(conv, ctx, "Which is largest?")).text)
} finally {
  await conv.close()
}
```

---

## Next

- [Resuming sessions](resuming-sessions.md) — pick this conversation back up later.
- [Handling input requests](handling-input.md) — trust dialogs and prompts.
- [Reading history](reading-history.md) — transcript vs store.
- Just need one reply? [One-shot turns](one-shot-turns.md).
