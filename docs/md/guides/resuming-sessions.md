# Resuming sessions

A conversation can be relaunched so the harness continues a **prior session** — the model
keeps its context across a teardown. There are two entry points: the convenience
[`Reopen`](#reopen) and the low-level [`Open` with `resume`](#low-level-open-with-resume).
First, the two ids you have to keep straight.

---

## Two ids

- **Chat session id** — meta-harness's own record id, what `conv.sessionID()` returns and
  what the [store](../modules/chat.md#the-store) is keyed on.
- **Harness session id** — the harness's _own_ id (a UUID it assigns itself). This is what
  actually resumes a session. It is **empty until meta-harness captures it** (from the
  screen, a raw output line, or the on-disk log) during the first turn.

You resume with the _harness_ id; `Reopen` looks it up from the chat id for you. See
[Concepts › Session](../concepts.md#session).

---

## Requirements

Resuming works only when both hold:

1. **The adapter supports resume** (implements `SessionResumer`). Claude Code, Codex, and
   pi do; OpenCode and generic do not → [`ErrResumeUnsupported`](../modules/chat.md#errors).
2. **A harness session id was captured** on the original run. If the original conversation
   never got far enough to capture one, its stored `harnessSessionID` is empty →
   [`ErrNoHarnessSession`](../modules/chat.md#errors).

Check the capture before relying on it:

```ts
const s = await store.getSession(conv.sessionID());
if (!s.harnessSessionID) {
  /* nothing to resume yet */
}
```

---

## Reopen

`Reopen` loads a stored [`Session`](../modules/chat.md#session), derives
`harness`/`workingDir`/`resume` from it, relaunches in resume mode, and **reuses the same
chat session id** — so `sessionID()` and `history()` reflect the resumed session.

```ts
import { Open, Reopen, newMemStore } from "meta-harness/chat";
import { Context } from "meta-harness/async";

const ctx = Context.background();
const store = newMemStore();

// --- first run ---
const first = await Open(ctx, {
  harness: "claude-code",
  binaryPath: "/usr/local/bin/claude",
  workingDir: process.cwd(),
  store,
});
// … drive a turn so the harness session id gets captured …
const chatID = first.sessionID();
await first.close();

// --- later: resume the SAME session ---
const resumed = await Reopen(ctx, {
  sessionID: chatID,
  binaryPath: "/usr/local/bin/claude", // launch knobs are NOT stored — re-supply them
  store,
});
console.log(resumed.sessionID() === chatID); // true — same chat session
```

**What the store persists vs what you re-supply.** A `Session` stores only `harness`,
`workingDir`, and `harnessSessionID`. Everything else — `binaryPath`, `env`, `args`,
`effort`, `model`, geometry, policies — is _not_ restored; pass it again via
[`ReopenOptions`](../modules/chat.md#resume) (which omits `harness`/`workingDir`/`resume`,
since those come from the record).

> **Cross-process resume needs a durable store.** `MemStore` lives in memory, so it can
> only `Reopen` within the same process. To resume after the process exits, implement the
> six-method [`Store`](../modules/chat.md#the-store) against a database — or capture the
> `harnessSessionID` yourself and use the low-level form below.

---

## Low-level: Open with resume

If you already hold the harness session id (e.g. from
[`runOneShotDetailed`](one-shot-turns.md#in-process-failure-safe), or your own persistence),
resume directly:

```ts
const conv = await Open(ctx, {
  harness: "codex",
  binaryPath: "/usr/local/bin/codex",
  workingDir: process.cwd(),
  store: newMemStore(),
  resume: harnessSessionID, // prepends the adapter's resumeArgs at launch
});
```

`resume` names the **harness** session id (not the chat id). The adapter's resume args are
prepended to `args` at launch, and the new chat session is seeded with that
`harnessSessionID` so history is immediately readable. Throws `ErrResumeUnsupported` if the
harness can't resume. Unlike `Reopen`, this mints a **new** chat session id.

---

## Fork-on-resume

Some harnesses **fork** on resume — they mint a _new_ harness session id rather than
continuing the old one. Adapters signal this with `resumeForksSessionID()`. When it's true,
chat arms a one-shot provisional refresh: the seeded id is allowed to be overwritten
exactly once by the freshly-minted id captured on the resumed run. You don't manage this —
but it's why, right after a fork-resume, `conv`'s `harnessSessionID` may change from the id
you passed to a new one. (Claude Code and Codex do **not** fork — Codex's no-fork behavior
is verified against codex-cli 0.142.5.)

---

## Errors

| Sentinel                                            | Meaning                                                |
| --------------------------------------------------- | ------------------------------------------------------ |
| [`ErrResumeUnsupported`](../modules/chat.md#errors) | The harness can't resume (no `SessionResumer`).        |
| [`ErrNoHarnessSession`](../modules/chat.md#errors)  | `Reopen`'s stored session never captured a harness id. |
