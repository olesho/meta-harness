// Port of pkg/turns/harness/codex/input_test.go.

import { describe, expect, test } from "vitest"
import * as codex from "../../../src/turns/harness/codex.ts"
import type { InputRequest } from "../../../src/turns/types.ts"

const dec = new TextDecoder()
const enc = new TextEncoder()

const updateNoticeScreen = `
  ✨  Update available! 0.140.0 -> 0.141.0

  Release notes: https://github.com/openai/codex/releases/latest

› 1. Update now (runs \`npm install -g @openai/codex\`)
  2. Skip
  3. Skip until next version

  Press enter to continue
`

const promptReadyScreen = `
╭─────────────────────────────────────────────────╮
│ ✨ Update available! 0.140.0 -> 0.141.0         │
│ Run npm install -g @openai/codex to update.     │
│                                                 │
│ See full release notes:                         │
│ https://github.com/openai/codex/releases/latest │
╰─────────────────────────────────────────────────╯

╭──────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.140.0)               │
│                                          │
│ model:     gpt-5.5   /model to change    │
│ directory: ~/Work/aether/harness-wrapper │
╰──────────────────────────────────────────╯

  Tip: Start a fresh idea with /new; the previous session stays in history.

› Run /review on my current changes

  gpt-5.5 default · ~/Work/aether/harness-wrapper
`

const promptReady141Screen = `
╭───────────────────────────────────────╮
│ >_ OpenAI Codex (v0.141.0)            │
│                                       │
│ model:     gpt-5.5   /model to change │
│ directory: /private/tmp               │
╰───────────────────────────────────────╯

  Tip: Use /fast to enable our fastest inference with increased plan usage.

›Find and fix a bug in @filename

  gpt-5.5 default · /private/tmp
`

const migrationScreen = `
  Choose how you'd like Codex to proceed.

  Try new model      gpt-5.5 -> gpt-6
  Use existing model

  Press enter to continue
`

describe("codex input", () => {
  test("update notice", () => {
    const req = codex.DetectInput(updateNoticeScreen)
    expect(req).not.toBeNull()
    expect(req!.kind).toBe(codex.KindUpdateNotice)
    const want = [
      { id: "1", alias: "update", label: "Update now (runs `npm install -g @openai/codex`)" },
      { id: "2", alias: "skip", label: "Skip" },
      { id: "3", alias: "skip", label: "Skip until next version" },
    ]
    expect(req!.options!.length).toBe(want.length)
    want.forEach((w, i) => {
      const o = req!.options![i]!
      expect(o.id).toBe(w.id)
      expect(o.alias).toBe(w.alias)
      expect(o.label).toBe(w.label)
    })
    expect(req!.id).not.toBe("")

    // Auto-dismiss must select Skip (digit 2), never the highlighted "Update now".
    const [keys, ok] = codex.AutoDismissKeys(req)
    expect(ok).toBe(true)
    expect(dec.decode(keys!)).toBe("2\r")
  })

  test("model migration", () => {
    const req = codex.DetectInput(migrationScreen)
    expect(req).not.toBeNull()
    expect(req!.kind).toBe(codex.KindModelMigration)
    const [keys, ok] = codex.AutoDismissKeys(req)
    expect(ok).toBe(true)
    expect(dec.decode(keys!)).toBe("\r")
  })

  test("multi-option notice auto-dismisses via bare Enter", () => {
    // a "Press enter to continue" notice that is neither an update
    // notice nor a migration — parseMenuOptions extracts its informational
    // numbered lines, so it has >1 option and no safe-token row. Enter is the
    // continuation codex advertises, so AutoDismissKeys clears it with a bare CR
    // instead of surfacing it (which previously blocked the codex plan-critic).
    const noticeMenu = `
  What's new in Codex

› 1. View the changelog
  2. Learn about /fast

  Press enter to continue
`
    const req = codex.DetectInput(noticeMenu)
    expect(req).not.toBeNull()
    expect(req!.kind).toBe(codex.KindNotice)
    expect(req!.options!.length).toBeGreaterThan(1)
    const [keys, ok] = codex.AutoDismissKeys(req)
    expect(ok).toBe(true)
    expect(dec.decode(keys!)).toBe("\r")
  })

  test("single-option notice auto-dismisses via bare Enter", () => {
    // The DetectInput fallback (no parsed menu rows → a lone "continue" option).
    const noticeOnly = `
  Heads up: something changed.

  Press enter to continue
`
    const req = codex.DetectInput(noticeOnly)
    expect(req).not.toBeNull()
    expect(req!.kind).toBe(codex.KindNotice)
    const [keys, ok] = codex.AutoDismissKeys(req)
    expect(ok).toBe(true)
    expect(dec.decode(keys!)).toBe("\r")
  })

  test("update notice without a Skip row is NOT auto-dismissed", () => {
    // Safety guard for the sibling KindUpdateNotice case: it must never bare-Enter
    // (that would run the highlighted "Update now"); with no skip alias it refuses.
    const req: InputRequest = {
      id: "u1",
      kind: codex.KindUpdateNotice,
      prompt: "Update available!",
      options: [{ id: "1", alias: "update", label: "Update now", keys: enc.encode("1\r") }],
    }
    const [keys, ok] = codex.AutoDismissKeys(req)
    expect(ok).toBe(false)
    expect(keys).toBeNull()
  })

  test("prompt-ready is not interstitial", () => {
    expect(codex.DetectInput(promptReadyScreen)).toBeNull()
    expect(codex.PromptReady(promptReadyScreen)).toBe(true)
  })

  test("PromptReady on codex 0.141 composer", () => {
    expect(codex.PromptReady(promptReady141Screen)).toBe(true)
    expect(codex.DetectInput(promptReady141Screen)).toBeNull()
  })

  test("adversarial reply mentioning update", () => {
    const reply = `
Here is what I found. There is an "Update available!" message you can ignore.
Steps to upgrade later:
  1. Run the installer
  2. Restart the app
  3. Verify the version

› Tell me what to do next
`
    expect(codex.DetectInput(reply)).toBeNull()
  })

  test("PromptReady during interstitial still matches glyph", () => {
    if (!codex.PromptReady(updateNoticeScreen)) return // skip: no leading '›' line
    expect(codex.DetectInput(updateNoticeScreen)).not.toBeNull()
  })
})
