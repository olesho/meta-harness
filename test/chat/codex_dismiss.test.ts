// Port of pkg/chat/codex_dismiss_test.go — Codex interstitial auto-dismiss.
import { describe, expect, test } from "bun:test"
import { codex } from "../../src/turns/index.ts"
import type { InputRequest as TurnsInputRequest } from "../../src/turns/index.ts"
import { KeyRecorder, newTestConv } from "./helpers.ts"

const enc = new TextEncoder()

function codexUpdateRequest(): TurnsInputRequest {
  return {
    id: "upd-1",
    kind: codex.KindUpdateNotice,
    prompt: "Update available!",
    options: [
      { id: "1", alias: "update", label: "Update now", keys: enc.encode("1\r") },
      { id: "2", alias: "skip", label: "Skip", keys: enc.encode("2\r") },
      { id: "3", alias: "skip", label: "Skip until next version", keys: enc.encode("3\r") },
    ],
  }
}

describe("codex auto-dismiss", () => {
  test("default: update notice cleared by Skip, nothing surfaced", () => {
    const rec = new KeyRecorder()
    const c = newTestConv({ harness: "codex" }, rec)
    c.handleInputRequested(codexUpdateRequest())
    expect(rec.text()).toBe("2\r")
    expect(c.inputSurfaced).toBe(false)
    expect(c.eventCh.tryReceive().ok).toBe(false)
  })

  test("notice: multi-option 'Press enter to continue' cleared by bare Enter, nothing surfaced", () => {
    // a codex_notice whose parsed rows carry no safe-token alias used
    // to return [null,false] and surface, blocking the codex plan-critic's first
    // send with ErrInputPending. tryAutoDismissCodex now clears it with a bare CR.
    const rec = new KeyRecorder()
    const c = newTestConv({ harness: "codex" }, rec)
    c.handleInputRequested({
      id: "ntc-1",
      kind: codex.KindNotice,
      prompt: "Press enter to continue",
      options: [
        { id: "1", alias: "", label: "View changelog", keys: enc.encode("1\r") },
        { id: "2", alias: "", label: "Learn more", keys: enc.encode("2\r") },
      ],
    })
    expect(rec.text()).toBe("\r")
    expect(c.inputSurfaced).toBe(false)
    expect(c.eventCh.tryReceive().ok).toBe(false)
  })

  test("disabled: interstitial surfaces to client", () => {
    const rec = new KeyRecorder()
    const c = newTestConv({ harness: "codex", disableCodexAutoDismiss: true }, rec)
    c.handleInputRequested(codexUpdateRequest())
    expect(rec.data.length).toBe(0)
    expect(c.inputSurfaced).toBe(true)
    expect(c.currentInput?.kind).toBe(codex.KindUpdateNotice)
  })

  test("never touches real approval prompts in either mode", () => {
    const approval = (): TurnsInputRequest => ({
      id: "ap-1",
      kind: "approval_prompt",
      prompt: "apply patch?",
      options: [
        { id: "1", alias: "proceed", label: "Yes", keys: enc.encode("1\r") },
        { id: "2", alias: "deny", label: "No", keys: enc.encode("2\r") },
      ],
    })
    for (const disable of [false, true]) {
      const rec = new KeyRecorder()
      const c = newTestConv({ harness: "codex", disableCodexAutoDismiss: disable }, rec)
      c.handleInputRequested(approval())
      expect(rec.data.length).toBe(0)
      expect(c.inputSurfaced).toBe(true)
    }
  })
})
