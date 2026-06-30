// Port of pkg/turns/harness/codex/codex_test.go.
// Corpus replay: bytes.raw → Screen → adapter, asserting no-fire on real
// (post-0.142) recordings and fire on the synthetic legacy footer.

import { describe, expect, test } from "bun:test"
import { newScreen } from "../../../src/screen/index.ts"
import * as codex from "../../../src/turns/harness/codex.ts"
import { TurnComplete } from "../../../src/turns/index.ts"
import { corpusBytes } from "../corpus.ts"

describe("codex adapter", () => {
  test("no fire on real (0.142) recordings", async () => {
    for (const scenario of [
      "short-reply",
      "long-markdown",
      "code-block",
      "tool-call",
      "multi-turn",
    ]) {
      const bytes = corpusBytes("codex", scenario)
      expect(bytes).not.toBeNull()
      const scr = newScreen(120, 40)
      await scr.write(bytes!)
      for (const ev of codex.New().onScreen(scr.snapshot())) {
        expect(ev.kind).not.toBe(TurnComplete)
      }
    }
  })

  test("no fire on empty screen", () => {
    const scr = newScreen(80, 24)
    expect(codex.New().onScreen(scr.snapshot()).length).toBe(0)
  })

  test("refires when fingerprint changes", async () => {
    const scr = newScreen(120, 40)
    const a = codex.New()

    await scr.write(
      "\x1b[H\x1b[2JToken usage: total=100 input=80 (+ 50 cached) output=20\r\n",
    )
    expect(a.onScreen(scr.snapshot()).length).toBe(1)

    // Same fingerprint → no fire.
    expect(a.onScreen(scr.snapshot()).length).toBe(0)

    await scr.write(
      "\r\nToken usage: total=200 input=150 (+ 100 cached) output=50\r\n",
    )
    expect(a.onScreen(scr.snapshot()).length).toBe(1)
  })

  test("name", () => {
    expect(codex.New().name()).toBe("codex")
  })

  test("adversarial scenarios do not fire", async () => {
    for (const scenario of [
      "adversarial/prefix-only-marker",
      "adversarial/partial-stream-no-footer",
    ]) {
      const bytes = corpusBytes("codex", scenario)
      expect(bytes).not.toBeNull()
      const scr = newScreen(120, 40)
      await scr.write(bytes!)
      for (const ev of codex.New().onScreen(scr.snapshot())) {
        expect(ev.kind).not.toBe(TurnComplete)
      }
    }
  })
})
