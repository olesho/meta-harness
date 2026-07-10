// Port of pkg/turns/harness/claudecode/busy_test.go.

import { describe, expect, test } from "vitest"
import { newScreen } from "../../../src/screen/index.ts"
import * as claudecode from "../../../src/turns/harness/claudecode.ts"
import { corpusBytes, textSnap } from "../corpus.ts"

describe("claude-code busy", () => {
  test("synthetic busy vs idle", () => {
    const a = claudecode.New()
    expect(
      a.busy(
        textSnap(
          "⏵⏵ bypass permissions on · esc to interrupt\n✢ Schlepping… (3s · ↓2 tokens)",
        ),
      ),
    ).toBe(true)
    expect(
      a.busy(textSnap("✻ Baked for 3s\n❯ \n⏵⏵ auto mode on · ← for agents")),
    ).toBe(false)
  })

  test("sub-agent spinner without footer still reads busy", () => {
    const a = claudecode.New()
    const frame =
      "✶ Cerebrating… (57s · ↓ 4.8k tokens)\n" +
      "  ◯ Explore  Verify queue, screen events, fleet-db types   24s · ↓ 35.8k tokens\n" +
      "❯ \n⏵⏵ bypass permissions on (shift+tab to cycle) · ↓ to manage"
    expect(a.busy(textSnap(frame))).toBe(true)
    expect(a.busy(textSnap("✢ Schlepping… (3s · ↓2 tokens)\n❯ "))).toBe(true)
  })

  test("settled summary is not working", () => {
    const a = claudecode.New()
    for (const idle of [
      "✻ Baked for 3s\n❯ \n⏵⏵ auto mode on · ← for agents",
      "✻ Cooked for 1m 22s\n❯ \n⏵⏵ auto mode on · ← for agents",
      "⏺ Done. See lib.ts.\n✻ Pondered for 9s\n❯ ",
    ]) {
      expect(a.busy(textSnap(idle))).toBe(false)
    }
  })

  test("corpus final frames are idle", async () => {
    const a = claudecode.New()
    for (const name of ["tool-call", "multi-turn", "interrupted-mid-reply"]) {
      const b = corpusBytes("claude-code", name)
      expect(b).not.toBeNull()
      const sc = newScreen(120, 40)
      await sc.write(b!)
      expect(a.busy(sc.snapshot())).toBe(false)
    }
  })
})
