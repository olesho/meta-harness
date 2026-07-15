# Handling input requests

Harnesses sometimes block on an interactive prompt — a folder-trust dialog, a y/n
confirmation, a menu, a startup notice. meta-harness surfaces these as
[`InputRequest`](../modules/chat.md#interactive-input)s and resolves them through a
**four-rung ladder**. You choose how much to automate: fully unattended, policy-driven, or
interactive.

---

## The resolution ladder

When the harness blocks, chat tries, in order:

1. **Auto-dismiss** — Codex startup interstitials ("Update available!", model migration,
   "Press enter to continue") are dismissed with safe keystrokes. Disable with
   [`disableCodexAutoDismiss`](../modules/chat.md#options).
2. **[`InputPolicy`](#policy-driven)** — if `Options.inputPolicy` has a
   [`Disposition`](#dispositions) for the prompt's `kind`, apply it.
3. **In-process handler** — if `Options.onInputRequest` is set, call it; if it returns
   `[answer, true]`, use that answer.
4. **Surface to you** — otherwise emit `EventInputRequest` and wait for your
   [`answer()`](#interactive).

Until a prompt is resolved, `send` throws [`ErrInputPending`](../modules/chat.md#errors).

---

## Fully unattended (one-shot)

The [one-shot loop](one-shot-turns.md) installs the canned policy
[`AutoAcceptTrust`](../modules/oneshot.md#environment-helpers), which answers the Claude
Code trust/bypass dialog with its `proceed` option — so a batch turn never wedges. You get
this for free with `runOneShot`; no configuration needed.

---

## Policy-driven

Pre-arm an [`InputPolicy`](../modules/chat.md#interactive-input) at `Open` to resolve
prompts by their `kind`, with no live handler:

```ts
import { Open, DispositionAnswer, DispositionDeny } from "meta-harness/chat"

const conv = await Open(ctx, {
  harness: "claude-code",
  binaryPath: "/usr/local/bin/claude",
  store: newMemStore(),
  inputPolicy: {
    byKind: {
      trust_prompt: { kind: DispositionAnswer, optionID: "proceed" },
      confirm:      { kind: DispositionDeny },   // pick the option aliased "deny"
    },
    default: DispositionAnswer,                    // fallback for unlisted kinds (optional)
  },
})
```

`byKind[req.kind]` wins over `default`; an explicit `{ kind: DispositionAsk }` entry means
"surface this one to me even though a default exists."

### Dispositions

```ts
type Disposition = { kind: DispositionKind; optionID?: string; text?: string }
```

| `kind` | Effect |
| --- | --- |
| `DispositionAnswer` | Choose `optionID` (or provide `text` for a free-text prompt). |
| `DispositionDeny` | Choose the option whose [`alias`](../modules/turns.md#interactive-prompts) is `"deny"`. |
| `DispositionAsk` | Don't resolve — fall through to the handler / surface to the client. |

---

## Interactive

To decide per-prompt at runtime, watch for `EventInputRequest` on the event stream and call
`answer()`:

```ts
import { EventInputRequest, EventTurn, TurnStateComplete, TurnStateErrored } from "meta-harness/chat"

for await (const ev of conv.events()) {
  if (ev.type === EventInputRequest && ev.input) {
    const req = ev.input
    console.log(req.prompt)
    for (const opt of req.options ?? []) console.log(`  [${opt.id}] ${opt.label}`)

    const release = await conv.acquireControl(ctx)
    try {
      await conv.answer(ctx, req.id, { optionID: "proceed" })   // or { text: "…" } for free-text
    } finally {
      release()
    }
  }
  if (ev.type === EventTurn && (ev.turn?.state === TurnStateComplete || ev.turn?.state === TurnStateErrored)) break
}
```

`answer(ctx, requestID, ans)` requires the [control token](conversation.md#3-send-and-wait)
and a `requestID` that matches the *currently* surfaced request. The
[`InputAnswer`](../modules/chat.md#interactive-input) is either `{ optionID }` (pick a
choice) or `{ text }` (free-text prompt).

### Or handle in-process

For a programmatic fallback without touching the event loop, supply `onInputRequest`:

```ts
const conv = await Open(ctx, {
  /* … */
  onInputRequest: (req) => {
    if (req.kind === "trust_prompt") return [{ optionID: "proceed" }, true]
    return [{}, false]   // not handled → falls through to surfacing
  },
})
```

Return `[answer, true]` to resolve, or `[…, false]` to decline and let the prompt surface.

---

## Clarifying questions (`question` / `question_review`)

Claude Code's `AskUserQuestion` tool halts the turn mid-flight and asks the user a
question. Without detection this is a **silent hang** — the dialog is neither busy nor a
ready composer, so the turn would never finalize. The claude-code adapter recognizes the
dialog and surfaces it through the same ladder as every other prompt:

- **kind `"question"`** — one question: `prompt` is the question text, `header` the
  dialog's tab label, `options` the model's choices (with `description`s) plus the UI's
  two affordances: *"Type something."* (alias `"other"`) and *"Chat about this"*.
- **kind `"question_review"`** — after the last question of a multi-question or
  multi-select dialog: a Submit/Cancel confirmation (`proceed`/`deny` aliases). Answer
  `{ optionID: "proceed" }` to commit the answers.

A multi-question dialog surfaces each question in sequence — answering one resolves it and
surfaces the next; the review pane comes last. Detect "the harness stopped to ask
something" either from `EventInputRequest` on the event stream or by polling
[`pendingInput()`](../modules/chat.md#answering-prompts).

```ts
for await (const ev of conv.events()) {
  if (ev.type === EventInputRequest && ev.input?.kind === "question") {
    const req = ev.input
    // req.prompt: "Which color should I use?"; req.options: Red / Blue / …
    const release = await conv.acquireControl(ctx)
    try {
      await conv.answer(ctx, req.id, { optionID: "Blue" })  // id, alias, or label
    } finally {
      release()
    }
  }
  if (ev.type === EventInputRequest && ev.input?.kind === "question_review") {
    /* acquire control and */ await conv.answer(ctx, ev.input.id, { optionID: "proceed" })
  }
  if (ev.type === EventTurn && ev.turn?.state === TurnStateComplete) break
}
```

**Multi-select questions** (`multiSelect: true`) accept several choices — answer with
`optionIDs`; chat toggles each and commits (which then surfaces the `question_review`
confirmation):

```ts
await conv.answer(ctx, req.id, { optionIDs: ["Cheese", "Olives"] })
```

Passing several `optionIDs` to a single-select question throws
[`ErrNotMultiSelect`](../modules/chat.md#errors).

**Free-text answers are a two-step.** Answering with the `"other"`-aliased option declines
the structured question: the dialog closes, the tool reports "user declined", and the
**turn completes**. Send your free-text answer as the next ordinary message:

```ts
await conv.answer(ctx, req.id, { optionID: "other" })  // turn completes ("declined")
// … wait for TurnStateComplete, then:
await conv.send(ctx, "Turquoise")                       // the actual answer, as a new turn
```

To auto-answer unattended runs, pre-arm a policy — e.g. always pick the first option and
submit reviews:

```ts
inputPolicy: {
  byKind: {
    question:        { kind: DispositionAnswer, optionID: "1" },
    question_review: { kind: DispositionAnswer, optionID: "proceed" },
  },
}
```

---

## Errors

| Sentinel | Raised when |
| --- | --- |
| [`ErrInputPending`](../modules/chat.md#errors) | `send` while a prompt is pending — answer it first. |
| [`ErrNoInputPending`](../modules/chat.md#errors) | `answer` with nothing pending. |
| [`ErrStaleInputRequest`](../modules/chat.md#errors) | `answer`'s `requestID` isn't the current prompt (it changed or resolved). |
| [`ErrUnknownOption`](../modules/chat.md#errors) | The `optionID`/alias matches no option. |

Because a prompt's `id` is stable only while that exact prompt is shown, answer promptly —
if the screen changes, your `requestID` goes stale.
