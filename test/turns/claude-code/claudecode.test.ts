// Port of pkg/turns/harness/claudecode/claudecode_test.go.
// Corpus replay: bytes.raw → Screen → adapter, asserting marker fire/no-fire.

import { describe, expect, test } from "bun:test"
import { newScreen } from "../../../src/screen/index.ts"
import * as claudecode from "../../../src/turns/harness/claudecode.ts"
import { Errored, TurnComplete } from "../../../src/turns/index.ts"
import { corpusBytes } from "../corpus.ts"

describe("claude-code adapter", () => {
  test("fires TurnComplete on multi-turn recording", async () => {
    const bytes = corpusBytes("claude-code", "multi-turn")
    expect(bytes).not.toBeNull()
    const scr = newScreen(120, 40)
    await scr.write(bytes!)
    const evs = claudecode.New().onScreen(scr.snapshot())
    expect(evs.length).toBe(1)
    expect(evs[0]!.kind).toBe(TurnComplete)
  })

  test("detects interrupt", async () => {
    const bytes = corpusBytes("claude-code", "interrupted-mid-reply")
    expect(bytes).not.toBeNull()
    const scr = newScreen(120, 40)
    await scr.write(bytes!)
    const evs = claudecode.New().onScreen(scr.snapshot())
    expect(evs.some((e) => e.kind === Errored)).toBe(true)
  })

  test("refires across turns", async () => {
    const scr = newScreen(120, 40)
    const a = claudecode.New()

    await scr.write("⏺ first reply\r\n✻ Baked for 5s\r\n")
    expect(a.onScreen(scr.snapshot()).length).toBe(1)

    // Same fingerprint → no fire.
    expect(a.onScreen(scr.snapshot()).length).toBe(0)

    await scr.write("⏺ second reply\r\n✻ Brewed for 8s\r\n")
    expect(a.onScreen(scr.snapshot()).length).toBe(1)

    // Accented verb in the thinking summary.
    await scr.write("⏺ third reply\r\n✻ Sautéed for 4s\r\n")
    expect(a.onScreen(scr.snapshot()).length).toBe(1)
  })

  test("fires on minute/hour durations", async () => {
    const cases = [
      { name: "seconds", summary: "✻ Baked for 5s" },
      { name: "minutes", summary: "✻ Cooked for 1m 22s" },
      { name: "minutes-only", summary: "✻ Brewed for 2m" },
      { name: "hours", summary: "✻ Pondered for 1h 2m 3s" },
    ]
    for (const tc of cases) {
      const scr = newScreen(120, 40)
      const a = claudecode.New()
      await scr.write("⏺ reply\r\n" + tc.summary + "\r\n")
      const evs = a.onScreen(scr.snapshot())
      expect(evs.length).toBe(1)
      expect(evs[0]!.kind).toBe(TurnComplete)
    }
  })

  test("trailing content does not fire", async () => {
    const scr = newScreen(120, 40)
    const a = claudecode.New()
    await scr.write(
      "⏺ working\r\n✻ Cooked for 1m 22s · ↑ 3.1k tokens · esc to interrupt\r\n",
    )
    for (const ev of a.onScreen(scr.snapshot())) {
      expect(ev.kind).not.toBe(TurnComplete)
    }
  })

  test("name", () => {
    expect(claudecode.New().name()).toBe("claude-code")
  })

  test("adversarial thinking-line-mid-reply does not fire", async () => {
    const bytes = corpusBytes("claude-code", "adversarial/thinking-line-mid-reply")
    expect(bytes).not.toBeNull()
    const scr = newScreen(120, 40)
    await scr.write(bytes!)
    for (const ev of claudecode.New().onScreen(scr.snapshot())) {
      expect(ev.kind).not.toBe(TurnComplete)
    }
  })
})
