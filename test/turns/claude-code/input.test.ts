// Port of pkg/turns/harness/claudecode/input_test.go.

import { describe, expect, test } from "bun:test"
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
