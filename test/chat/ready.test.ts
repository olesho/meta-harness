// Port of pkg/chat/ready_test.go — per-harness submit key + pi send-readiness.
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  submitKeyForHarness,
  requiresPromptReadiness,
  readyForInput,
  authRequired,
  onboardingWall,
  usageLimitMessage,
} from "../../src/chat/ready.ts";
import { newScreen } from "../../src/screen/index.ts";
import { corpusBytes } from "../turns/corpus.ts";

const dec = new TextDecoder();

/** Replays a codex corpus recording through the screen emulator to its text. */
async function codexCorpusScreen(scenario: string): Promise<string> {
  const bytes = corpusBytes("codex", scenario);
  expect(bytes, `corpus recording codex/${scenario} is missing`).not.toBeNull();
  const scr = newScreen(120, 40);
  await scr.write(bytes!);
  return scr.snapshot().text;
}

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

  // Live 2.1.263 wording: the trust dialog is UNNUMBERED there and defaults to
  // "No, exit". Anchored by the created-or-trust sentence, so it stays rejected
  // by the blocking-dialog early-return, not by the composer predicate.
  const trustDialog263 = [
    " Claude Code",
    "",
    " Quick safety check: Is this a project you created or one you trust?",
    "",
    " \u276f No, exit",
    "   Yes, I trust this folder",
  ].join("\n");

  // Pristine (pre-first-turn) composer captured live from 2.1.263 via tmux on
  // 2026-09-06 — PUPPET-519. The placeholder hint never clears while the
  // session has taken no turn, and its body rotates (see src/chat/ready.ts).
  const readyComposerPlaceholder263 = [
    " \u2590\u259b\u2588\u2588\u2588\u259b\u2588   Claude Code v2.1.263",
    "\u259d\u259c\u2588\u2588\u2588\u2588\u2588\u2588\u2580  Opus 5 (1M context) with medium effort \u00b7 API Usage Billing",
    "  \u259d\u259d \u259d\u259d    /\u2026/scratchpad/probe",
    "",
    "                                     \u25d0 medium \u00b7 /effort",
    "\u2500".repeat(64),
    '\u276f Try "write a test for <filepath>"',
    "\u2500".repeat(64),
    "  \u23f5\u23f5 auto mode on (shift+tab to cycle) \u00b7 \u2190 for agents",
  ].join("\n");

  // Same shape, the OTHER hint observed live in the same session — the body
  // rotates over an eight-entry table, so a fixture pinning one string would
  // pass while the predicate stayed version-fragile.
  const readyComposerPlaceholderAlt = readyComposerPlaceholder263.replace(
    'Try "write a test for <filepath>"',
    'Try "how does <filepath> work?"',
  );

  // A turn in flight whose echoed user prompt is ITSELF the placeholder shape.
  // The one screen the widened regex would misread; the busy guard rejects it.
  const busyTurnTryEcho = [
    " \u2590\u259b\u2588\u2588\u2588\u259c\u258c   Claude Code v2.1.263",
    "",
    '\u276f Try "write a test for foo.ts"',
    "",
    "\u273b Pondering\u2026 (3s \u00b7 esc to interrupt)",
  ].join("\n");

  // An echoed user prompt that merely STARTS with the hint shape: text after
  // the closing quote must keep it out of the placeholder alternative.
  const echoTryWithTail = [
    " \u2590\u259b\u2588\u2588\u2588\u259c\u258c   Claude Code v2.1.263",
    "",
    '\u276f Try "write a test for foo.ts" please',
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

  // --- PUPPET-519: the pristine composer carries a placeholder hint ---

  test("pristine placeholder composer 2.1.263 is ready", () => {
    expect(readyForInput("claude-code", readyComposerPlaceholder263)).toBe(
      true,
    );
  });
  test("placeholder composer with a rotated hint body is ready", () => {
    expect(readyForInput("claude-code", readyComposerPlaceholderAlt)).toBe(
      true,
    );
  });
  test("submit key on the placeholder composer stays CSI 13 u", () => {
    expect(
      dec.decode(
        submitKeyForHarness("claude-code", readyComposerPlaceholder263),
      ),
    ).toBe("\x1b[13u");
  });
  test("echoed `Try \"…\"` prompt mid-turn is not ready (busy guard)", () => {
    expect(readyForInput("claude-code", busyTurnTryEcho)).toBe(false);
  });
  test("echoed `Try \"…\"` prompt with a tail is not ready", () => {
    expect(readyForInput("claude-code", echoTryWithTail)).toBe(false);
  });
  test("trust dialog (2.1.263 unnumbered variant) not ready", () => {
    expect(readyForInput("claude-code", trustDialog263)).toBe(false);
  });
});

// PUPPET-519 regression, pinned to a REAL recording rather than a hand-typed
// frame: interrupted-mid-reply is a live claude 2.1.201 capture whose boot paint
// contains the placeholder composer. Replaying the stream PREFIX up to the end
// of that paint reproduces the pristine composer exactly as claude drew it.
// (Replaying the whole stream lands on the post-turn screen, which paints the
// bare "❯" and matched even before this fix.)
describe("readyForInput(claude-code) — recorded corpus", () => {
  /** Byte-wise indexOf, so the prefix cut lands on the recorded paint. */
  function indexOfBytes(hay: Uint8Array, needle: Uint8Array): number {
    return Buffer.from(hay).indexOf(Buffer.from(needle));
  }

  test("recorded boot composer (corpus prefix replay) is ready", async () => {
    const bytes = corpusBytes("claude-code", "interrupted-mid-reply");
    expect(bytes).not.toBeNull();
    const needle = new TextEncoder().encode('Try "write a test for <filepath>"');
    const at = indexOfBytes(bytes!, needle);
    expect(at).toBeGreaterThan(0);
    const scr = newScreen(120, 40);
    await scr.write(bytes!.subarray(0, at + needle.length));
    const text = scr.snapshot().text;
    expect(text).toContain('Try "write a test for <filepath>"');
    expect(readyForInput("claude-code", text)).toBe(true);
  });

  // The negative half over the same tree: the widened predicate must not leak.
  // model-picker is a menu, not a composer, and stays NOT ready.
  test("recorded model-picker final screen stays not ready", async () => {
    const bytes = corpusBytes("claude-code", "model-picker");
    expect(bytes).not.toBeNull();
    const scr = newScreen(120, 40);
    await scr.write(bytes!);
    expect(readyForInput("claude-code", scr.snapshot().text)).toBe(false);
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

  // ── The /permissions dialog (META-HARNESS-104) ─────────────────────────────
  //
  // Same class as the approval dialogs: a "›"-highlighted menu row satisfies the
  // codex composer regex, so before the fix readyForInput answered TRUE and a
  // prompt sent while it was up got typed into the dialog's menu.

  // The live 0.144.5 dialog (test/corpus/codex/permissions-dialog), trimmed to
  // the rows the predicate keys on. The footer is NOT an anchor (it is assembled
  // upstream from template fragments); the header is.
  const permissionsDialog = [
    "  Update Model Permissions",
    "",
    "› 1. Ask for approval (current)  Codex can read and edit files in the current workspace, and run",
    "                                 commands. Approval is required to access the internet.",
    "  2. Approve for me              Only ask for actions detected as potentially unsafe.",
    "  3. Full Access                 Codex can edit files outside this workspace and access the",
    "                                 internet without asking for approval.",
    "",
    "  Press enter to confirm or esc to go back",
  ].join("\n");

  test("permissions dialog not ready", () => {
    expect(readyForInput("codex", permissionsDialog)).toBe(false);
  });

  test("corpus: permissions dialog not ready", async () => {
    expect(
      readyForInput("codex", await codexCorpusScreen("permissions-dialog")),
    ).toBe(false);
  });

  test("ready again once the permissions dialog is dismissed", () => {
    expect(readyForInput("codex", readyComposer)).toBe(true);
  });

  // The false-positive-hang guard, mirroring the approval one: the header is a
  // short UI string an assistant reply can easily quote. A bare includes() would
  // pin this screen not-ready forever — sends blocked, turn never completed.
  test("idle reply quoting the permissions header without a highlighted row stays ready", () => {
    const prose = [
      '• Run /permissions to open the "Update Model Permissions" dialog. It lists:',
      "    1. Ask for approval",
      "    2. Approve for me",
      "    3. Full Access",
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

describe("authRequired", () => {
  // claude-code — real observed output: `claude -p` on an unauthenticated box
  // prints "Not logged in · Please run /login"; the TUI shows a "run /login"
  // re-auth banner.
  test("claude: detects the logged-out banner", () => {
    expect(
      authRequired("claude-code", "Not logged in · Please run /login"),
    ).toBe(true);
    expect(
      authRequired(
        "claude-code",
        "  ⚠ Your login expires in 1 day · run /login to renew\n❯ ",
      ),
    ).toBe(true);
  });

  // codex — real observed output: the `codex exec` turn path fails with a 401,
  // `codex login status` says "Not logged in", remediation is "run `codex login`".
  test("codex: detects 401 / missing-bearer / not-logged-in / codex login", () => {
    expect(
      authRequired(
        "codex",
        "ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
      ),
    ).toBe(true);
    expect(authRequired("codex", "Not logged in")).toBe(true);
    expect(
      authRequired(
        "codex",
        "ChatGPT account ID not available, please re-run `codex login`",
      ),
    ).toBe(true);
  });

  // Gating context: authRequired is only consulted on a turn that produced no
  // clean output, but even so it must not fire on ordinary text lacking the
  // anchors, nor cross harnesses, nor for an unknown harness.
  test("no false positive on ordinary screen text", () => {
    expect(authRequired("claude-code", "⏺ I refactored the auth module.")).toBe(
      false,
    );
    expect(authRequired("codex", "› ready\nthinking about the task")).toBe(
      false,
    );
  });
  test("codex anchors do not fire for claude-code and vice versa", () => {
    // "401 Unauthorized" is a codex-only anchor; claude's set is /login-based.
    expect(
      authRequired("claude-code", "HTTP 401 Unauthorized from the API"),
    ).toBe(false);
    // "run /login" is a claude-only anchor; not in codex's set.
    expect(authRequired("codex", "please run /login")).toBe(false);
  });
  test("unknown harness never fires", () => {
    expect(authRequired("some-other-harness", "Not logged in")).toBe(false);
  });

  // claude-code 2.1.263 OAuth browser sign-in (PUPPET-315): the wall the
  // login-method menu advances into. "Select login method" is GONE from this
  // screen, so before the fix nothing matched it and send hung to the deadline.
  // Both prose lines are anchors; either alone suffices.
  test("claude: detects the OAuth browser sign-in wall", () => {
    expect(
      authRequired(
        "claude-code",
        " Browser didn't open? Use the url below to sign in (c to copy)",
      ),
    ).toBe(true);
    expect(
      authRequired("claude-code", " Paste code here if prompted >"),
    ).toBe(true);
  });

  // The anchors are deliberately the full UI phrasings, not /paste code/: an
  // assistant reply merely saying "paste code" must not be gated.
  test("claude: a reply mentioning 'paste code' is not gated", () => {
    expect(
      authRequired(
        "claude-code",
        "⏺ Copy the snippet and paste code into main.ts.",
      ),
    ).toBe(false);
  });
});

// The claude 2.1.263 pre-reply screens, as measured live on 2026-09-06
// (PUPPET-315), read straight off the corpus fixtures the Go repo shares. The
// OAuth browser sign-in screen is the one that used to match nothing: it is a
// WALL (onboardingWall true, so awaitPromptReady throws ErrAuthRequired
// IMMEDIATELY rather than after the 2s debounce — the CLI can replace this frame
// within one paint), and it is never ready for input. The logged-out composer is
// the deliberate contrast: authRequired true but readyForInput ALSO true, because
// a real composer carrying a stale banner is usable.
describe("claude-code 2.1.263 pre-reply screens (corpus)", () => {
  const corpusScreen = (fixture: string): string =>
    readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../corpus/auth/claude-code",
        fixture,
        "screen.txt",
      ),
      "utf8",
    );

  const cases: [string, boolean, boolean, boolean][] = [
    // fixture, onboardingWall, readyForInput, authRequired
    ["oauth-browser-signin", true, false, true],
    ["login-method-2.1.263", true, false, true],
    ["not-logged-in-2.1.263", false, true, true],
  ];
  for (const [fixture, wall, ready, auth] of cases) {
    test(fixture, () => {
      const screen = corpusScreen(fixture);
      expect(onboardingWall("claude-code", screen)).toBe(wall);
      expect(readyForInput("claude-code", screen)).toBe(ready);
      expect(authRequired("claude-code", screen)).toBe(auth);
    });
  }
});

// Chat-layer cross-check for the PUPPET-452 class of regression: 2.1.261 dropped
// the folder-trust dialog's numbered options, which broke the turns-layer menu
// matcher. The chat layer matches by literal substring, not menu shape, so the
// dialog is still not-ready on 2.1.263 — and it is not an auth screen. Frame body
// captured live 2026-09-06.
describe("claude-code 2.1.263 folder-trust dialog", () => {
  const trustDialog = [
    " Accessing workspace:",
    "",
    " /tmp/probe/wd4",
    "",
    " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source",
    " project, or work from your team). If not, take a moment to review what's in this folder first.",
    "",
    " Claude Code'll be able to read, edit, and execute files here.",
    "",
    " Security guide",
    "",
    " ❯ No, exit",
    "   Yes, I trust this folder",
    "",
    " Enter to confirm · Esc to cancel",
    "",
  ].join("\n");

  test("not ready, not a wall, not auth", () => {
    expect(readyForInput("claude-code", trustDialog)).toBe(false);
    expect(onboardingWall("claude-code", trustDialog)).toBe(false);
    expect(authRequired("claude-code", trustDialog)).toBe(false);
  });
});

describe("usageLimitMessage(claude-code)", () => {
  // Captured live from claude-code 2.1.216 (2026-07-20): the usage window is
  // exhausted, so the CLI renders the wall AS the assistant reply for the turn.
  const sessionLimitReply =
    "You've hit your session limit · resets 10:20pm (Europe/Warsaw)";

  test("detects the session-limit wall and returns the full line", () => {
    expect(usageLimitMessage("claude-code", sessionLimitReply)).toBe(
      sessionLimitReply,
    );
  });

  test("captures the '· resets …' reset tail for the reason detail", () => {
    const msg = usageLimitMessage(
      "claude-code",
      "  ⏺ You have hit your usage limit · resets at 6:40pm\n",
    );
    expect(msg).toBe("You have hit your usage limit · resets at 6:40pm");
  });

  test("matches under a tool-result decoration glyph in scrollback", () => {
    const screen = [
      "────────────────────────────────────────",
      "  ⎿  You've hit your session limit · resets 10:20pm",
      "────────────────────────────────────────",
      "❯",
    ].join("\n");
    expect(usageLimitMessage("claude-code", screen)).toBe(
      "You've hit your session limit · resets 10:20pm",
    );
  });

  test("no false positive on a genuine reply mentioning limits in prose", () => {
    // A real model reply discussing the feature — must NOT be mistaken for the
    // wall. The CLI's wall always leads its line with "You've/You have hit your".
    expect(
      usageLimitMessage(
        "claude-code",
        "⏺ I added a check for when the user hits their session limit, resetting the counter.",
      ),
    ).toBeNull();
  });

  test("does not fire for other harnesses (claude-only wall today)", () => {
    expect(usageLimitMessage("codex", sessionLimitReply)).toBeNull();
    expect(
      usageLimitMessage("some-other-harness", sessionLimitReply),
    ).toBeNull();
  });
});
