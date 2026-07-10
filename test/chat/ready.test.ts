// Port of pkg/chat/ready_test.go — per-harness submit key + pi send-readiness.
import { describe, expect, test } from "vitest"
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

describe("readyForInput(claude-code)", () => {
  test("claude-code requires prompt readiness", () => {
    expect(requiresPromptReadiness("claude-code")).toBe(true)
  })

  // Idle composer as rendered by 2.1.185 (corpus shape): empty "❯" prompt line
  // between horizontal rules, status hint below.
  const readyComposer185 = [
    " ▐▛███▜▌   Claude Code v2.1.185",
    "",
    "⏺ Paris.",
    "",
    "✻ Baked for 5s",
    "",
    "────────────────────────────────────────",
    "❯ ",
    "────────────────────────────────────────",
    "  ⏵⏵ auto mode on (shift+tab to cycle)",
  ].join("\n")

  // Idle composer as captured live from 2.1.201 (record-pty probe, 2026-07-05):
  // welcome box titled "Claude Code v2.1.201", effort indicator, then the empty
  // "❯ " prompt line between horizontal rules.
  const readyComposer201 = [
    "╭─── Claude Code v2.1.201 ──────────────────────────╮",
    "│                 Welcome back Oleh!                 │",
    "│                       ▐▛███▜▌                      │",
    "│   Fable 5 with high effort · Claude Max · Oleh     │",
    "╰────────────────────────────────────────────────────╯",
    "",
    " ⚠ 2 MCP servers need authentication · run /mcp",
    "",
    "                                     ● high · /effort to change",
    "────────────────────────────────────────────────────────────────",
    "❯ ",
    "────────────────────────────────────────────────────────────────",
    "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
  ].join("\n")

  const bypassDialog = [
    " ▐▛███▜▌   Claude Code v2.1.201",
    "",
    "╭────────────────────────────────────────╮",
    "│ Bypass Permissions mode                │",
    "│                                        │",
    "│ In Bypass Permissions mode, Claude     │",
    "│ Code will not ask for your approval    │",
    "│ before running potentially dangerous   │",
    "│ commands.                              │",
    "│                                        │",
    "│ ❯ 1. No, exit                          │",
    "│   2. Yes, I accept                     │",
    "╰────────────────────────────────────────╯",
  ].join("\n")

  const trustDialog = [
    " ▐▛███▜▌   Claude Code v2.1.201",
    "",
    " Do you trust the files in this folder?",
    "",
    " /Users/someone/project",
    "",
    " ❯ 1. Yes, proceed",
    "   2. No, exit",
  ].join("\n")

  const trustDialogAlt = [
    " ▐▛███▜▌   Claude Code v2.1.201",
    "",
    " Is this a project you created or one you trust?",
    "",
    " ❯ 1. Yes, I created or trust this project",
    "   2. No, exit",
  ].join("\n")

  const startupSplash = [
    " ▐▛███▜▌   Claude Code v2.1.201",
    "",
    "  Loading…",
  ].join("\n")

  const busyTurn = [
    " ▐▛███▜▌   Claude Code v2.1.201",
    "",
    "❯ what is the capital of France",
    "",
    "✻ Pondering… (3s · esc to interrupt)",
  ].join("\n")

  test("ready composer 2.1.185", () =>
    expect(readyForInput("claude-code", readyComposer185)).toBe(true))
  test("ready composer 2.1.201 (live capture)", () =>
    expect(readyForInput("claude-code", readyComposer201)).toBe(true))
  test("submit key on the 2.1.201 ready screen stays CSI 13 u", () =>
    expect(dec.decode(submitKeyForHarness("claude-code", readyComposer201))).toBe(
      "\x1b[13u",
    ))
  test("bypass permissions dialog not ready", () =>
    expect(readyForInput("claude-code", bypassDialog)).toBe(false))
  test("trust dialog not ready", () =>
    expect(readyForInput("claude-code", trustDialog)).toBe(false))
  test("trust dialog (created-or-trust variant) not ready", () =>
    expect(readyForInput("claude-code", trustDialogAlt)).toBe(false))
  test("startup splash not ready", () =>
    expect(readyForInput("claude-code", startupSplash)).toBe(false))
  test("busy turn (past prompt echoes ❯) not ready", () =>
    expect(readyForInput("claude-code", busyTurn)).toBe(false))
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
