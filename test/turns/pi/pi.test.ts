// Port of pkg/turns/harness/pi/pi_test.go.

import { describe, expect, test } from "bun:test"
import { newScreen } from "../../../src/screen/index.ts"
import type { Snapshot } from "../../../src/screen/index.ts"
import * as pi from "../../../src/turns/harness/pi.ts"
import { TurnComplete } from "../../../src/turns/index.ts"
import { StatusWaitingForInput } from "../../../src/turns/index.ts"

async function snap(text: string): Promise<Snapshot> {
  const scr = newScreen(120, 40)
  await scr.write(text)
  return scr.snapshot()
}

// Frames captured live from pi 0.76.0 (cerebras/gpt-oss-120b).
const piBusyFrame =
  " ⠧ Working...\n────────────\n~/proj (main)\n0.0%/131k (auto)        gpt-oss-120b • medium\n"
const piThinkFrame =
  " ⠇ Thinking...\n────────────\n0.0%/131k (auto)        gpt-oss-120b • medium\n"
const piIdleFrame =
  "────────────\n~/proj (main)\n↑1.2k ↓32 $0.000 0.9%/131k (auto)        gpt-oss-120b • medium\n"
const piStartupFrame =
  " pi v0.76.0\n Press ctrl+o to show full startup help and loaded resources.\n ripgrep not found. Downloading...\n"
const piMenuFrame = " Thinking Level\n 1. off  2. low  3. medium\n"

describe("pi adapter", () => {
  test("name", () => {
    expect(pi.New().name()).toBe("pi")
  })

  test("no screen events by default", async () => {
    const scr = newScreen(120, 40)
    await scr.write("any old content\r\n")
    expect(pi.New().onScreen(scr.snapshot()).length).toBe(0)
  })

  test("fires on waiting_for_input", () => {
    const evs = pi
      .New()
      .onWrapperStatus(StatusWaitingForInput, "prompt detected: (y/n)")
    expect(evs.length).toBe(1)
    expect(evs[0]!.kind).toBe(TurnComplete)
  })

  test("capabilities", () => {
    const a = pi.New()
    expect(typeof (a as { readTranscript?: unknown }).readTranscript).toBe(
      "function",
    )
    expect(typeof (a as { quitSequence?: unknown }).quitSequence).toBe(
      "function",
    )
    expect(typeof (a as { busy?: unknown }).busy).toBe("function")
    expect(
      typeof (a as { extractSessionID?: unknown }).extractSessionID,
    ).not.toBe("function")
  })

  test("Busy", async () => {
    const a = pi.New()
    const cases: Array<{ name: string; text: string; want: boolean }> = [
      { name: "working spinner", text: piBusyFrame, want: true },
      { name: "thinking spinner", text: piThinkFrame, want: true },
      { name: "idle status line", text: piIdleFrame, want: false },
      { name: "thinking-level menu is not busy", text: piMenuFrame, want: false },
    ]
    for (const tc of cases) {
      expect(a.busy(await snap(tc.text))).toBe(tc.want)
    }
  })

  test("PromptReady", () => {
    const cases: Array<{ name: string; text: string; want: boolean }> = [
      { name: "idle composer is ready", text: piIdleFrame, want: true },
      { name: "busy is not ready", text: piBusyFrame, want: false },
      { name: "thinking is not ready", text: piThinkFrame, want: false },
      { name: "startup is not ready", text: piStartupFrame, want: false },
    ]
    for (const tc of cases) {
      expect(pi.PromptReady(tc.text)).toBe(tc.want)
    }
  })

  test("QuitSequence", () => {
    expect(new TextDecoder().decode(pi.New().quitSequence())).toBe("/quit\r")
  })
})
