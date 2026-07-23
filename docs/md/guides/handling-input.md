# Handling input requests

Harnesses sometimes block on an interactive prompt — a folder-trust dialog, a y/n
confirmation, a menu, a startup notice. meta-harness surfaces these as
[`InputRequest`](../modules/chat.md#interactive-input)s and resolves them through a
**four-rung ladder**. You choose how much to automate: fully unattended, policy-driven, or
interactive.

---

## The prompt kinds

The client-surfaced `kind` values, and which harness produces each:

| `kind`               | Prompt                                                                                                     | Surfaced by |
| -------------------- | ---------------------------------------------------------------------------------------------------------- | ----------- |
| `trust_prompt`       | Folder-trust / "bypass permissions" startup dialog.                                                        | Claude Code |
| `menu_select`        | A numbered menu.                                                                                           | any         |
| `confirm`            | A y/n confirmation.                                                                                        | any         |
| `text_input`         | A free-text prompt (no `options`).                                                                         | any         |
| `question`           | A mid-turn [clarifying question](#clarifying-questions-question--question_review) (`AskUserQuestion`).     | Claude Code |
| `question_review`    | The Submit/Cancel confirmation ending a multi-question / multi-select dialog.                              | Claude Code |
| `approval_prompt`    | A mid-turn [command / apply-patch approval](#approval-prompts-approval_prompt).                            | Codex       |
| `permissions_prompt` | The `/permissions` ["Update Model Permissions"](#the-permissions-dialog-permissions_prompt) preset picker. | Codex       |

`permissions_prompt` is a **mid-turn dialog**, not the launch-time
[`permissionMode`](../modules/wrapper.md#permission-mode) knob — that one pins the posture
in argv before the harness starts and never surfaces as an input request.

Codex's startup interstitials ("Update available!", model migration, "Press enter to
continue") are auto-dismissed on the ladder's first rung and never surface as kinds.

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
import { Open, DispositionAnswer, DispositionDeny } from "meta-harness/chat";

const conv = await Open(ctx, {
  harness: "claude-code",
  binaryPath: "/usr/local/bin/claude",
  store: newMemStore(),
  inputPolicy: {
    byKind: {
      trust_prompt: { kind: DispositionAnswer, optionID: "proceed" },
      confirm: { kind: DispositionDeny }, // pick the option aliased "deny"
    },
    default: DispositionAnswer, // fallback for unlisted kinds (optional)
  },
});
```

`byKind[req.kind]` wins over `default`; an explicit `{ kind: DispositionAsk }` entry means
"surface this one to me even though a default exists."

### Dispositions

```ts
type Disposition = { kind: DispositionKind; optionID?: string; text?: string };
```

| `kind`              | Effect                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------- |
| `DispositionAnswer` | Choose `optionID` (or provide `text` for a free-text prompt).                           |
| `DispositionDeny`   | Choose the option whose [`alias`](../modules/turns.md#interactive-prompts) is `"deny"`. |
| `DispositionAsk`    | Don't resolve — fall through to the handler / surface to the client.                    |

---

## Interactive

To decide per-prompt at runtime, watch for `EventInputRequest` on the event stream and call
`answer()`:

```ts
import {
  EventInputRequest,
  EventTurn,
  TurnStateComplete,
  TurnStateErrored,
} from "meta-harness/chat";

for await (const ev of conv.events()) {
  if (ev.type === EventInputRequest && ev.input) {
    const req = ev.input;
    console.log(req.prompt);
    for (const opt of req.options ?? [])
      console.log(`  [${opt.id}] ${opt.label}`);

    const release = await conv.acquireControl(ctx);
    try {
      await conv.answer(ctx, req.id, { optionID: "proceed" }); // or { text: "…" } for free-text
    } finally {
      release();
    }
  }
  if (
    ev.type === EventTurn &&
    (ev.turn?.state === TurnStateComplete ||
      ev.turn?.state === TurnStateErrored)
  )
    break;
}
```

`answer(ctx, requestID, ans)` requires the [control token](conversation.md#3-send-and-wait)
and a `requestID` that matches the _currently_ surfaced request. The
[`InputAnswer`](../modules/chat.md#interactive-input) is either `{ optionID }` (pick a
choice) or `{ text }` (free-text prompt).

### Or handle in-process

For a programmatic fallback without touching the event loop, supply `onInputRequest`:

```ts
const conv = await Open(ctx, {
  /* … */
  onInputRequest: (req) => {
    if (req.kind === "trust_prompt") return [{ optionID: "proceed" }, true];
    return [{}, false]; // not handled → falls through to surfacing
  },
});
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
  two affordances: _"Type something."_ (alias `"other"`) and _"Chat about this"_.
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
    const req = ev.input;
    // req.prompt: "Which color should I use?"; req.options: Red / Blue / …
    const release = await conv.acquireControl(ctx);
    try {
      await conv.answer(ctx, req.id, { optionID: "Blue" }); // id, alias, or label
    } finally {
      release();
    }
  }
  if (ev.type === EventInputRequest && ev.input?.kind === "question_review") {
    /* acquire control and */ await conv.answer(ctx, ev.input.id, {
      optionID: "proceed",
    });
  }
  if (ev.type === EventTurn && ev.turn?.state === TurnStateComplete) break;
}
```

**Multi-select questions** (`multiSelect: true`) accept several choices — answer with
`optionIDs`; chat toggles each and commits (which then surfaces the `question_review`
confirmation):

```ts
await conv.answer(ctx, req.id, { optionIDs: ["Cheese", "Olives"] });
```

Passing several `optionIDs` to a single-select question throws
[`ErrNotMultiSelect`](../modules/chat.md#errors).

**Free-text answers are a two-step.** Answering with the `"other"`-aliased option declines
the structured question: the dialog closes, the tool reports "user declined", and the
**turn completes**. Send your free-text answer as the next ordinary message:

```ts
await conv.answer(ctx, req.id, { optionID: "other" }); // turn completes ("declined")
// … wait for TurnStateComplete, then:
await conv.send(ctx, "Turquoise"); // the actual answer, as a new turn
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

## Approval prompts (`approval_prompt`)

Codex stops mid-turn to ask before running a command or applying a patch — "Would you
like to run the following command?" / "Would you like to make the following edits?".
The codex adapter detects the dialog and surfaces it as kind `"approval_prompt"`: the
`prompt` is the approval question, and `options` are the dialog's numbered menu rows
with `proceed`/`deny` aliases. Answer it like any other prompt:

```ts
if (ev.type === EventInputRequest && ev.input?.kind === "approval_prompt") {
  /* acquire control and */ await conv.answer(ctx, ev.input.id, {
    optionID: "proceed",
  });
  // or { optionID: "deny" } to reject the command / edits
}
```

Or pre-arm a policy so unattended runs approve (or reject) automatically:

```ts
inputPolicy: {
  byKind: {
    approval_prompt: { kind: DispositionAnswer, optionID: "proceed" },
  },
}
```

Approval detection runs _before_ the interstitial auto-dismiss anchors, so an approval
dialog whose body happens to quote an interstitial phrase can never be auto-approved by
the dismiss keystrokes. Note the [one-shot loop](one-shot-turns.md) ships **no** policy
for `approval_prompt` — an unanswered approval waits out the deadline (see the
[one-shot caveat](../modules/oneshot.md#environment-helpers)).

---

## The permissions dialog (`permissions_prompt`)

Codex's `/permissions` command opens an "Update Model Permissions" picker — a numbered
menu of permission presets ("Ask for approval", "Approve for me", "Full Access", …),
one of which is marked `(current)` in its label. It is a **blocking modal**: while it is
up, the composer is gone, so a prompt sent in that window would be typed into the menu.
The codex adapter surfaces it as kind `"permissions_prompt"` (the `prompt` is the header
`"Update Model Permissions"`, `options` are the preset rows), and `readyForInput` holds
sends until it clears.

Do not confuse it with the launch-time
[`permissionMode`](../modules/wrapper.md#permission-mode) knob, which pins the same posture
in argv before the harness starts. The two really do interact: answering **this** dialog
writes the chosen preset to `~/.codex/config.toml` **globally**, for every later session,
whereas the flags the launch knob emits are **per-invocation** — which
is exactly why pinning the permissions axis at launch is the deterministic way to get a
known posture, whatever an earlier session wrote into the global config file.

Two things differ from `approval_prompt`:

- **It is never auto-dismissed.** Enter commits the highlighted preset to
  `~/.codex/config.toml` — globally, for every later session — so there is no safe
  keystroke. Detection runs _before_ the interstitial anchors precisely so the
  auto-dismiss ladder can never bare-Enter it.
- **Its rows carry stable preset-slug aliases, never `proceed`/`deny`.** Each row's
  `alias` is a slug derived from its label — lowercased, a trailing `(current)` suffix
  stripped, spaces hyphenated (e.g. `"Approve for me"` → `approve-for-me`) — addressable
  the same way regardless of build or config. The slug rule is guaranteed, by a test that
  checks every row of every `/permissions` fixture, to never produce `proceed` or `deny`,
  so no alias-keyed policy can auto-answer this dialog. That includes a bare
  `InputPolicy.default`: `resolvePolicy` does fall back to it for `permissions_prompt`
  when no `byKind` entry is set, but `default` is a bare `DispositionKind` with no
  `optionID`, so the `DispositionAnswer` branch resolves nothing and the
  `DispositionDeny` branch finds no `deny` alias to act on — either way the dialog is
  surfaced to the client.

Answer it by `optionID` — which, besides the row's digit (`"1"`, `"2"`, …), also accepts
one of the preset slugs above or the row's exact label, since option lookup matches on
id, alias, or label. The slug is what makes a row addressable **even while its label
carries the `(current)` suffix**: label matching is exact, so `optionID: "Approve for me"`
stops resolving the instant that preset becomes current and its label grows the suffix,
while `optionID: "approve-for-me"` resolves identically either way. That is what makes a
second run — or a machine whose global config already carries an earlier write —
addressable at all. Otherwise back out of the dialog yourself — it has no "go back"
option row, only the ESC key.

Note the highlighted row is the menu **cursor**, which moves with the arrow keys; the
`(current)` suffix in a label marks the preset already in effect. They usually coincide
when the dialog opens.

### Driving it programmatically: `setCodexPermissionPreset`

`Conversation.setCodexPermissionPreset(ctx, preset)` drives this dialog on the caller's
behalf and returns a freshly verified `PermissionModeReading`, confirmed through codex's
own `/status` reader — never by re-parsing the dialog. `preset` is one of the
`CodexPermissionPreset` slugs: `"ask-for-approval"`, `"approve-for-me"`, `"full-access"` —
the same three rows the alias rule above guarantees are addressable whenever the dialog
exists at all.

It is opt-in **and** containment-gated, through one option:
[`Options.allowCodexPermissionsWrite`](../modules/chat.md#options), a string naming the
**isolated `CODEX_HOME`** the conversation was launched under.

- **Why it's opt-in.** Selecting a preset through this dialog writes
  `approvals_reviewer = "auto_review"` into codex's `config.toml` — and that file is
  **global**: every later session sharing the same `CODEX_HOME`, in any directory, starts
  in that mode, and nothing in the dialog says so. Absent or empty
  `allowCodexPermissionsWrite` ⇒ `ErrCodexPermissionsDisabled`, thrown before a single
  byte is written.
- **Why it's also containment-gated.** The option must name the _exact_ isolated home the
  conversation is bound to — a boolean opt-in would not be enough. An ambient/inherited
  `CODEX_HOME` a caller happens to export can never satisfy the gate merely by matching:
  `cleanHarnessEnv` (`src/chat/env.ts`) forwards `process.env` verbatim, so a bare
  `CODEX_HOME !== ~/.codex` check would pass for a fleet/agent process's own real,
  persistent home while the global write still landed somewhere durable. A mismatch, or
  an adapter never bound to a launch env, throws `ErrCodexHomeNotIsolated`.
- **Seeding requirement.** The isolated home must be pre-seeded with a `0600` copy of
  `~/.codex/auth.json`, or codex sits on the first-run sign-in wall and the call times out
  rather than ever reaching the dialog.

Other refusals: `ErrPermissionsUnsupported` (the harness isn't codex, the resolved adapter
has no permissions capability, or a caller-supplied `Options.adapter` is also in play —
that seam binds last-writer-wins across conversations, which is not a foundation this gate
can rest on), `ErrCodexPermissionsRaced` (a caller-supplied `onInputRequest` already
answered the dialog before the driver's own poll could), and `ErrPermissionPresetUnavailable`
— raised for **both** "this build renders no row matching the requested preset" (the
`guardian_approval` feature flag is off, so the dialog shows `Read Only` / `Default` /
`Custom permissions` instead) **and** "the dialog never opened at all" — so the
feature-flag-off case is distinguishable from caller error and never leaks out as
`ErrUnknownOption`.

**The containment bar scopes to this one entry point.** It governs
`setCodexPermissionPreset` specifically — the surfaced `answer()` path stays open by
design, with no opt-in and no `CODEX_HOME` check, because that is the human answering
their own dialog after reading the rows codex printed on their own screen. A client that
receives `permissions_prompt` on `events()` and calls
`answer(ctx, id, { optionID: "approve-for-me" })` commits the preset exactly as it always
has. The bar exists for the _programmatic, unattended_ entry point — the one that can
commit a global config write without anyone having seen the dialog.

**Known limit.** An isolated home supplied only through `Options.env` (never exported into
the host process's own environment) is invisible to `src/cli/structured-runner.ts`'s
module-level `readTranscript` / `readUsage`, which take no root parameter — a run driven
that way reads back with an empty transcript and null usage. That's a documented
consequence of the signatures being out of scope here, not a bug.

---

## Errors

| Sentinel                                            | Raised when                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------- |
| [`ErrInputPending`](../modules/chat.md#errors)      | `send` while a prompt is pending — answer it first.                       |
| [`ErrNoInputPending`](../modules/chat.md#errors)    | `answer` with nothing pending.                                            |
| [`ErrStaleInputRequest`](../modules/chat.md#errors) | `answer`'s `requestID` isn't the current prompt (it changed or resolved). |
| [`ErrUnknownOption`](../modules/chat.md#errors)     | The `optionID`/alias matches no option.                                   |

Because a prompt's `id` is stable only while that exact prompt is shown, answer promptly —
if the screen changes, your `requestID` goes stale.
