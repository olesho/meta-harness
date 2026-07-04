// Port of pkg/chat/ready_test.go — per-harness submit key + pi send-readiness.
import { describe, expect, test } from "bun:test"
import {
  submitKeyForHarness,
  requiresPromptReadiness,
  readyForInput,
} from "../../src/chat/ready.ts"

const dec = new TextDecoder()

describe("submitKeyForHarness", () => {
  const csi13u = "\x1b[13u"
  const cases: Array<[string, string, string, string]> = [
    ["codex composer", "codex", "›Find and fix a bug in @filename", csi13u],
    ["codex any screen", "codex", "whatever is on screen", csi13u],
    ["claude bypass", "claude-code", "... bypass permissions ...", csi13u],
    ["claude vim hint", "claude-code", "ctrl+g to edit in Vim", csi13u],
    ["claude auto mode", "claude-code", "Claude Code ❯ ... auto mode on", csi13u],
    ["pi composer", "pi", "0.0%/131k (auto)  gpt-oss-120b • medium", "\r"],
    ["unknown", "some-other-harness", "anything", "\n"],
  ]
  for (const [name, harness, screen, want] of cases) {
    test(name, () => {
      expect(dec.decode(submitKeyForHarness(harness, screen))).toBe(want)
    })
  }
})

describe("readyForInput(pi)", () => {
  test("pi requires prompt readiness", () => {
    expect(requiresPromptReadiness("pi")).toBe(true)
  })

  const idle =
    "────\n~/proj (main)\n↑1.2k ↓32 $0.000 0.9%/131k (auto)   gpt-oss-120b • medium\n"
  const busy = " ⠧ Working...\n0.0%/131k (auto)   gpt-oss-120b • medium\n"
  const startup =
    " pi v0.76.0\n Press ctrl+o to show full startup help\n ripgrep not found. Downloading...\n"

  test("idle composer ready", () => expect(readyForInput("pi", idle)).toBe(true))
  test("busy not ready", () => expect(readyForInput("pi", busy)).toBe(false))
  test("startup not ready", () => expect(readyForInput("pi", startup)).toBe(false))
})
