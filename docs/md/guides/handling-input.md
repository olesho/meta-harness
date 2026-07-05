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

## Errors

| Sentinel | Raised when |
| --- | --- |
| [`ErrInputPending`](../modules/chat.md#errors) | `send` while a prompt is pending — answer it first. |
| [`ErrNoInputPending`](../modules/chat.md#errors) | `answer` with nothing pending. |
| [`ErrStaleInputRequest`](../modules/chat.md#errors) | `answer`'s `requestID` isn't the current prompt (it changed or resolved). |
| [`ErrUnknownOption`](../modules/chat.md#errors) | The `optionID`/alias matches no option. |

Because a prompt's `id` is stable only while that exact prompt is shown, answer promptly —
if the screen changes, your `requestID` goes stale.
