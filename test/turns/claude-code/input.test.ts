// Port of pkg/turns/harness/claudecode/input_test.go.

import { describe, expect, test } from "vitest"
import * as claudecode from "../../../src/turns/harness/claudecode.ts"
import type { Event, InputOption } from "../../../src/turns/index.ts"
import { InputRequested, InputResolved, type Kind } from "../../../src/turns/index.ts"
import { textSnap } from "../corpus.ts"

const dec = new TextDecoder()

// claudecode.ts keeps these anchors module-private; mirror the literals here.
const trustAnchor = "Do you trust the files in this folder?"

const trustScreen = `╭─────────────────────────────────────────────────╮
│ Do you trust the files in this folder?            │
│                                                   │
│ /Users/oleh/Work/aether/harness-wrapper           │
│                                                   │
│ ❯ 1. Yes, proceed                                 │
│   2. No, exit                                     │
│                                                   │
│ Enter to confirm · Esc to exit                    │
╰─────────────────────────────────────────────────╯`

const bypassScreen = `WARNING: Claude Code running in Bypass Permissions mode

By proceeding, you accept all risks.

❯ 1. Yes, I accept
  2. No, exit
`

function findKind(evs: Event[], k: Kind): Event | null {
  return evs.find((e) => e.kind === k) ?? null
}

describe("claude-code input", () => {
  test("trust dialog", () => {
    const req = claudecode.DetectInput(trustScreen)
    expect(req).not.toBeNull()
    expect(req!.kind).toBe("trust_prompt")
    expect(req!.prompt).toBe(trustAnchor)
    const want: Array<Pick<InputOption, "id" | "alias" | "label"> & { keys: string }> = [
      { id: "1", alias: "proceed", label: "Yes, proceed", keys: "1\r" },
      { id: "2", alias: "deny", label: "No, exit", keys: "2\r" },
    ]
    expect(req!.options!.length).toBe(want.length)
    want.forEach((w, i) => {
      const o = req!.options![i]!
      expect(o.id).toBe(w.id)
      expect(o.alias).toBe(w.alias)
      expect(o.label).toBe(w.label)
      expect(dec.decode(o.keys)).toBe(w.keys)
    })
    expect(req!.id).not.toBe("")
  })

  test("bypass acceptance", () => {
    const req = claudecode.DetectInput(bypassScreen)
    expect(req).not.toBeNull()
    expect(req!.options!.length).toBe(2)
    expect(req!.options![0]!.alias).toBe("proceed")
    expect(req!.options![1]!.alias).toBe("deny")
  })

  test("stable id across redraw", () => {
    const a = claudecode.DetectInput(trustScreen)
    const b = claudecode.DetectInput(trustScreen + "\n")
    expect(a!.id).toBe(b!.id)
  })

  test("no dialog", () => {
    expect(
      claudecode.DetectInput("a normal Claude Code session\n❯ \n"),
    ).toBeNull()
    // Anchor present but no menu rendered yet → not actionable.
    expect(claudecode.DetectInput(trustAnchor + "\n")).toBeNull()
  })

  test("OnScreen: input requested then resolved", () => {
    const a = claudecode.New()

    const req = findKind(a.onScreen(textSnap(trustScreen)), InputRequested)
    expect(req).not.toBeNull()
    expect(req!.input).toBeDefined()
    expect(req!.input!.options!.length).toBe(2)

    // Same dialog re-renders → no duplicate request.
    expect(
      findKind(a.onScreen(textSnap(trustScreen)), InputRequested),
    ).toBeNull()

    // Dialog clears → InputResolved carrying the same ID.
    const res = findKind(a.onScreen(textSnap("Claude Code\n❯ \n")), InputResolved)
    expect(res).not.toBeNull()
    expect(res!.input!.id).toBe(req!.input!.id)
  })
})

// ── AskUserQuestion dialogs (screens verified live against 2.1.210) ─────────

const singleQuestionScreen = `⏺ I'll ask you the question now.
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 ☐ Color

Which color should I use?

❯ 1. Red
     Use red.
  2. Blue
     Use blue.
  3. Type something.
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`

const secondQuestionScreen = `⏺ I'll ask both questions in a single call.
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
←  ☒ Color  ☐ Size  ✔ Submit  →

Which size should I use?

❯ 1. Small
     Use small.
  2. Large
     Use large.
  3. Type something.
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  4. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`

const reviewScreen = `⏺ I'll ask both questions in a single call.

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
←  ☒ Color  ☒ Size  ✔ Submit  →

Review your answers

 ● Which color should I use?
   → Blue
 ● Which size should I use?
   → Small

Ready to submit your answers?

❯ 1. Submit answers
  2. Cancel
`

const multiSelectScreen = `⏺ I'll ask you the question now.
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
←  ☐ Toppings  ✔ Submit  →

Which toppings should I add?

❯ 1. [ ] Cheese
  Add cheese as a topping.
  2. [✔] Mushrooms
  Add mushrooms as a topping.
  3. [ ] Olives
  Add olives as a topping.
  4. [ ] Type something
     Submit
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`

// A rendered reply with a to-do list and a numbered list — checkbox glyphs and
// menu-shaped rows WITHOUT a dialog. Must not fire.
const todoReplyScreen = `⏺ Here is the plan:
  ☐ Wire the adapter
  ☐ Add tests

  1. First step
  2. Second step

❯
`

describe("claude-code question dialogs", () => {
  test("single-select question", () => {
    const req = claudecode.DetectInput(singleQuestionScreen)
    expect(req).not.toBeNull()
    expect(req!.kind).toBe("question")
    expect(req!.prompt).toBe("Which color should I use?")
    expect(req!.header).toBe("Color")
    expect(req!.multiSelect).toBeUndefined()

    const want: Array<Pick<InputOption, "id" | "alias" | "label"> & { keys: string; desc?: string }> = [
      { id: "1", alias: "", label: "Red", keys: "1", desc: "Use red." },
      { id: "2", alias: "", label: "Blue", keys: "2", desc: "Use blue." },
      { id: "3", alias: "other", label: "Type something.", keys: "3\r" },
      { id: "4", alias: "", label: "Chat about this", keys: "4\r" },
    ]
    expect(req!.options!.length).toBe(want.length)
    want.forEach((w, i) => {
      const o = req!.options![i]!
      expect(o.id).toBe(w.id)
      expect(o.alias).toBe(w.alias)
      expect(o.label).toBe(w.label)
      expect(dec.decode(o.keys)).toBe(w.keys)
      expect(o.description).toBe(w.desc)
    })
    expect(req!.id).not.toBe("")
  })

  test("second question of a multi-question dialog", () => {
    const req = claudecode.DetectInput(secondQuestionScreen)
    expect(req).not.toBeNull()
    expect(req!.kind).toBe("question")
    expect(req!.prompt).toBe("Which size should I use?")
    // The active tab is the first unanswered (☐) entry, not the ☒ one.
    expect(req!.header).toBe("Size")
    // A DIFFERENT question must get a different id.
    expect(req!.id).not.toBe(claudecode.DetectInput(singleQuestionScreen)!.id)
  })

  test("review pane after the last question", () => {
    const req = claudecode.DetectInput(reviewScreen)
    expect(req).not.toBeNull()
    expect(req!.kind).toBe("question_review")
    expect(req!.prompt).toContain("Ready to submit your answers?")
    expect(req!.prompt).toContain("→ Blue")
    const labels = req!.options!.map((o) => o.label)
    expect(labels).toEqual(["Submit answers", "Cancel"])
    expect(req!.options![0]!.alias).toBe("proceed")
    expect(req!.options![1]!.alias).toBe("deny")
    expect(dec.decode(req!.options![0]!.keys)).toBe("1\r")
  })

  test("multi-select question", () => {
    const req = claudecode.DetectInput(multiSelectScreen)
    expect(req).not.toBeNull()
    expect(req!.kind).toBe("question")
    expect(req!.multiSelect).toBe(true)
    expect(dec.decode(req!.submitKeys!)).toBe("\t")
    // Checkbox markers are stripped so the id is stable across toggles.
    const labels = req!.options!.map((o) => o.label)
    expect(labels).toEqual(["Cheese", "Mushrooms", "Olives", "Type something", "Chat about this"])
    // Toggle keys: the bare digit, no CR.
    expect(dec.decode(req!.options![1]!.keys)).toBe("2")
    // The toggled variant of the same dialog keeps the id.
    const toggled = multiSelectScreen.replace("[✔]", "[ ]")
    expect(claudecode.DetectInput(toggled)!.id).toBe(req!.id)
  })

  test("checkbox glyphs in a reply do not fire", () => {
    expect(claudecode.DetectInput(todoReplyScreen)).toBeNull()
  })

  test("question pane without its footer does not fire", () => {
    const noFooter = singleQuestionScreen.replace(
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
      "",
    )
    expect(claudecode.DetectInput(noFooter)).toBeNull()
  })

  test("OnScreen: a superseding question resolves the previous one first", () => {
    const a = claudecode.New()

    const first = findKind(a.onScreen(textSnap(singleQuestionScreen)), InputRequested)
    expect(first).not.toBeNull()

    const evs = a.onScreen(textSnap(secondQuestionScreen))
    const resolved = findKind(evs, InputResolved)
    const requested = findKind(evs, InputRequested)
    expect(resolved).not.toBeNull()
    expect(resolved!.input!.id).toBe(first!.input!.id)
    expect(requested).not.toBeNull()
    expect(requested!.input!.prompt).toBe("Which size should I use?")
    // Order matters: resolve the old before surfacing the new.
    expect(evs.indexOf(resolved!)).toBeLessThan(evs.indexOf(requested!))

    // The dialog clears entirely → the second question resolves too.
    const done = findKind(a.onScreen(textSnap("Claude Code\n❯ \n")), InputResolved)
    expect(done).not.toBeNull()
    expect(done!.input!.id).toBe(requested!.input!.id)
  })
})
