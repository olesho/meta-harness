// Port of pkg/chat/ready_test.go — per-harness submit key + pi send-readiness.
import { describe, expect, test } from "vitest";
import {
  submitKeyForHarness,
  requiresPromptReadiness,
  readyForInput,
} from "../../src/chat/ready.ts";

const dec = new TextDecoder();

describe("submitKeyForHarness", () => {
  const csi13u = "\x1b[13u";
  const cases: [string, string, string, string][] = [
    ["codex composer", "codex", "›Find and fix a bug in @filename", csi13u],
    ["codex any screen", "codex", "whatever is on screen", csi13u],
    ["claude bypass", "claude-code", "... bypass permissions ...", csi13u],
    ["claude vim hint", "claude-code", "ctrl+g to edit in Vim", csi13u],
    [
      "claude auto mode",
      "claude-code",
      "Claude Code ❯ ... auto mode on",
      csi13u,
    ],
    ["pi composer", "pi", "0.0%/131k (auto)  gpt-oss-120b • medium", "\r"],
    ["unknown", "some-other-harness", "anything", "\n"],
  ];
  for (const [name, harness, screen, want] of cases) {
    test(name, () => {
      expect(dec.decode(submitKeyForHarness(harness, screen))).toBe(want);
    });
  }
});

describe("readyForInput(claude-code)", () => {
  test("claude-code requires prompt readiness", () => {
    expect(requiresPromptReadiness("claude-code")).toBe(true);
  });

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
  ].join("\n");

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
  ].join("\n");

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
  ].join("\n");

  const trustDialog = [
    " ▐▛███▜▌   Claude Code v2.1.201",
    "",
    " Do you trust the files in this folder?",
    "",
    " /Users/someone/project",
    "",
    " ❯ 1. Yes, proceed",
    "   2. No, exit",
  ].join("\n");

  const trustDialogAlt = [
    " ▐▛███▜▌   Claude Code v2.1.201",
    "",
    " Is this a project you created or one you trust?",
    "",
    " ❯ 1. Yes, I created or trust this project",
    "   2. No, exit",
  ].join("\n");

  const startupSplash = [
    " ▐▛███▜▌   Claude Code v2.1.201",
    "",
    "  Loading…",
  ].join("\n");

  const busyTurn = [
    " ▐▛███▜▌   Claude Code v2.1.201",
    "",
    "❯ what is the capital of France",
    "",
    "✻ Pondering… (3s · esc to interrupt)",
  ].join("\n");

  test("ready composer 2.1.185", () => {
    expect(readyForInput("claude-code", readyComposer185)).toBe(true);
  });
  test("ready composer 2.1.201 (live capture)", () => {
    expect(readyForInput("claude-code", readyComposer201)).toBe(true);
  });
  test("submit key on the 2.1.201 ready screen stays CSI 13 u", () => {
    expect(
      dec.decode(submitKeyForHarness("claude-code", readyComposer201)),
    ).toBe("\x1b[13u");
  });
  test("bypass permissions dialog not ready", () => {
    expect(readyForInput("claude-code", bypassDialog)).toBe(false);
  });
  test("trust dialog not ready", () => {
    expect(readyForInput("claude-code", trustDialog)).toBe(false);
  });
  test("trust dialog (created-or-trust variant) not ready", () => {
    expect(readyForInput("claude-code", trustDialogAlt)).toBe(false);
  });
  test("startup splash not ready", () => {
    expect(readyForInput("claude-code", startupSplash)).toBe(false);
  });
  test("busy turn (past prompt echoes ❯) not ready", () => {
    expect(readyForInput("claude-code", busyTurn)).toBe(false);
  });
});

describe("readyForInput(codex)", () => {
  test("codex requires prompt readiness", () => {
    expect(requiresPromptReadiness("codex")).toBe(true);
  });

  // The live 0.144.4 shell-command approval dialog (test/corpus/codex/
  // approval-command), trimmed to the rows the predicate keys on.
  const approvalDialog = [
    "• Running touch /tmp/codex-approval-probe-marker",
    "",
    "  Would you like to run the following command?",
    "",
    "  Environment: local",
    "",
    "  $ touch /tmp/codex-approval-probe-marker",
    "",
    "› 1. Yes, proceed (y)",
    "  2. Yes, and don't ask again (p)",
    "  3. No, and tell Codex what to do differently (esc)",
    "",
    "  Press enter to confirm or esc to cancel",
  ].join("\n");

  const applyPatchDialog = [
    "• Added hello.txt (+1 -0)",
    "    1 +hello",
    "",
    "  Would you like to make the following edits?",
    "",
    "› 1. Yes, proceed (y)",
    "  2. Yes, and don't ask again for these files (a)",
    "  3. No, and tell Codex what to do differently (esc)",
    "",
    "  Press enter to confirm or esc to cancel",
  ].join("\n");

  const readyComposer = [
    "• Ran touch /tmp/codex-approval-probe-marker",
    "",
    "› ",
    "",
    "  gpt-5.6-sol default · /private/tmp",
  ].join("\n");

  const updateInterstitial = [
    "  ✨  Update available! 0.140.0 -> 0.141.0",
    "",
    "› 1. Update now",
    "  2. Skip",
    "",
    "  Press enter to continue",
  ].join("\n");

  test("idle composer ready", () => {
    expect(readyForInput("codex", readyComposer)).toBe(true);
  });
  test("update interstitial not ready", () => {
    expect(readyForInput("codex", updateInterstitial)).toBe(false);
  });

  // Without the approval gate these would read as ready: the dialog's
  // "›"-highlighted menu row satisfies the codex composer regex.
  test("command approval dialog not ready", () => {
    expect(readyForInput("codex", approvalDialog)).toBe(false);
  });
  test("apply-patch approval dialog not ready", () => {
    expect(readyForInput("codex", applyPatchDialog)).toBe(false);
  });
  test("ready again once the dialog is answered", () => {
    expect(readyForInput("codex", readyComposer)).toBe(true);
  });

  // Ready-side adversarial, mirroring the DetectInput one. A bare includes() on
  // the approval anchors would pin this screen not-ready forever: awaitPromptReady
  // would block sends and maybeIdleComplete would never complete the turn — a
  // silent hang on an ordinary reply. The structural "anchor AND highlighted
  // numbered menu row" predicate keeps it ready.
  test("idle reply quoting the anchor without a highlighted menu row stays ready", () => {
    const prose = [
      "• Codex asks for approval before running a command. It prints:",
      '    "Would you like to run the following command?"',
      "  and then offers you:",
      "    1. Yes, run it",
      "    2. No, cancel that",
      "",
      "› ",
    ].join("\n");
    expect(readyForInput("codex", prose)).toBe(true);
  });

  test("plain prose asking a yes/no question stays ready", () => {
    const prose = [
      "• All done. Would you like to run the tests?",
      "",
      "› ",
    ].join("\n");
    expect(readyForInput("codex", prose)).toBe(true);
  });
});

describe("readyForInput(pi)", () => {
  test("pi requires prompt readiness", () => {
    expect(requiresPromptReadiness("pi")).toBe(true);
  });

  const idle =
    "────\n~/proj (main)\n↑1.2k ↓32 $0.000 0.9%/131k (auto)   gpt-oss-120b • medium\n";
  const busy = " ⠧ Working...\n0.0%/131k (auto)   gpt-oss-120b • medium\n";
  const startup =
    " pi v0.76.0\n Press ctrl+o to show full startup help\n ripgrep not found. Downloading...\n";

  test("idle composer ready", () => {
    expect(readyForInput("pi", idle)).toBe(true);
  });
  test("busy not ready", () => {
    expect(readyForInput("pi", busy)).toBe(false);
  });
  test("startup not ready", () => {
    expect(readyForInput("pi", startup)).toBe(false);
  });
});
