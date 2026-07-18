// Port of pkg/turns/harness/codex/input_test.go.

import { describe, expect, test } from "vitest";
import { newScreen } from "../../../src/screen/index.ts";
import * as codex from "../../../src/turns/harness/codex.ts";
import type { InputRequest } from "../../../src/turns/types.ts";
import { corpusBytes } from "../corpus.ts";

const dec = new TextDecoder();
const enc = new TextEncoder();

/** Replays a corpus recording through the screen emulator to its final text. */
async function corpusScreen(scenario: string): Promise<string> {
  const bytes = corpusBytes("codex", scenario);
  expect(bytes, `corpus recording codex/${scenario} is missing`).not.toBeNull();
  const scr = newScreen(120, 40);
  await scr.write(bytes!);
  return scr.snapshot().text;
}

const updateNoticeScreen = `
  ✨  Update available! 0.140.0 -> 0.141.0

  Release notes: https://github.com/openai/codex/releases/latest

› 1. Update now (runs \`npm install -g @openai/codex\`)
  2. Skip
  3. Skip until next version

  Press enter to continue
`;

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
`;

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
`;

const migrationScreen = `
  Choose how you'd like Codex to proceed.

  Try new model      gpt-5.5 -> gpt-6
  Use existing model

  Press enter to continue
`;

describe("codex input", () => {
  test("update notice", () => {
    const req = codex.DetectInput(updateNoticeScreen);
    expect(req).not.toBeNull();
    expect(req!.kind).toBe(codex.KindUpdateNotice);
    const want = [
      {
        id: "1",
        alias: "update",
        label: "Update now (runs `npm install -g @openai/codex`)",
      },
      { id: "2", alias: "skip", label: "Skip" },
      { id: "3", alias: "skip", label: "Skip until next version" },
    ];
    expect(req!.options!.length).toBe(want.length);
    want.forEach((w, i) => {
      const o = req!.options![i];
      expect(o.id).toBe(w.id);
      expect(o.alias).toBe(w.alias);
      expect(o.label).toBe(w.label);
    });
    expect(req!.id).not.toBe("");

    // Auto-dismiss must select Skip (digit 2), never the highlighted "Update now".
    const [keys, ok] = codex.AutoDismissKeys(req);
    expect(ok).toBe(true);
    expect(dec.decode(keys!)).toBe("2\r");
  });

  test("model migration", () => {
    const req = codex.DetectInput(migrationScreen);
    expect(req).not.toBeNull();
    expect(req!.kind).toBe(codex.KindModelMigration);
    const [keys, ok] = codex.AutoDismissKeys(req);
    expect(ok).toBe(true);
    expect(dec.decode(keys!)).toBe("\r");
  });

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
`;
    const req = codex.DetectInput(noticeMenu);
    expect(req).not.toBeNull();
    expect(req!.kind).toBe(codex.KindNotice);
    expect(req!.options!.length).toBeGreaterThan(1);
    const [keys, ok] = codex.AutoDismissKeys(req);
    expect(ok).toBe(true);
    expect(dec.decode(keys!)).toBe("\r");
  });

  test("single-option notice auto-dismisses via bare Enter", () => {
    // The DetectInput fallback (no parsed menu rows → a lone "continue" option).
    const noticeOnly = `
  Heads up: something changed.

  Press enter to continue
`;
    const req = codex.DetectInput(noticeOnly);
    expect(req).not.toBeNull();
    expect(req!.kind).toBe(codex.KindNotice);
    const [keys, ok] = codex.AutoDismissKeys(req);
    expect(ok).toBe(true);
    expect(dec.decode(keys!)).toBe("\r");
  });

  test("update notice without a Skip row is NOT auto-dismissed", () => {
    // Safety guard for the sibling KindUpdateNotice case: it must never bare-Enter
    // (that would run the highlighted "Update now"); with no skip alias it refuses.
    const req: InputRequest = {
      id: "u1",
      kind: codex.KindUpdateNotice,
      prompt: "Update available!",
      options: [
        {
          id: "1",
          alias: "update",
          label: "Update now",
          keys: enc.encode("1\r"),
        },
      ],
    };
    const [keys, ok] = codex.AutoDismissKeys(req);
    expect(ok).toBe(false);
    expect(keys).toBeNull();
  });

  test("prompt-ready is not interstitial", () => {
    expect(codex.DetectInput(promptReadyScreen)).toBeNull();
    expect(codex.PromptReady(promptReadyScreen)).toBe(true);
  });

  test("PromptReady on codex 0.141 composer", () => {
    expect(codex.PromptReady(promptReady141Screen)).toBe(true);
    expect(codex.DetectInput(promptReady141Screen)).toBeNull();
  });

  test("adversarial reply mentioning update", () => {
    const reply = `
Here is what I found. There is an "Update available!" message you can ignore.
Steps to upgrade later:
  1. Run the installer
  2. Restart the app
  3. Verify the version

› Tell me what to do next
`;
    expect(codex.DetectInput(reply)).toBeNull();
  });

  test("PromptReady during interstitial still matches glyph", () => {
    if (!codex.PromptReady(updateNoticeScreen)) return; // skip: no leading '›' line
    expect(codex.DetectInput(updateNoticeScreen)).not.toBeNull();
  });
});

// ── Genuine approval prompts (META-HARNESS-46) ───────────────────────────────

// A hand-written approval screen in the live corpus shape (anchor, body, a
// "›"-highlighted menu, footer). Used for the gate/ordering pins that need to
// vary one element at a time; the corpus recordings pin the real thing.
function approvalScreen(opts: { body?: string; menu?: string[] } = {}): string {
  return [
    "• Running touch /tmp/probe",
    "",
    "  Would you like to run the following command?",
    "",
    ...(opts.body ? ["  " + opts.body, ""] : []),
    "  $ touch /tmp/probe",
    "",
    ...(opts.menu ?? [
      "› 1. Yes, proceed (y)",
      "  2. Yes, and don't ask again (p)",
      "  3. No, and tell Codex what to do differently (esc)",
    ]),
    "",
    "  Press enter to confirm or esc to cancel",
  ].join("\n");
}

describe("codex approval prompts", () => {
  test("corpus: shell-command approval dialog", async () => {
    const req = codex.DetectInput(await corpusScreen("approval-command"));
    expect(req).not.toBeNull();
    expect(req!.kind).toBe(codex.KindApproval);
    expect(req!.kind).toBe("approval_prompt"); // pinned by orche's handler contract
    expect(req!.prompt).toBe("Would you like to run the following command?");
    expect(req!.id).not.toBe("");

    const opts = req!.options!;
    expect(opts.map((o) => o.id)).toEqual(["1", "2", "3"]);
    expect(opts.map((o) => o.alias)).toEqual(["proceed", "proceed", "deny"]);
    expect(opts[0].label).toBe("Yes, proceed (y)");
    expect(opts[2].label).toBe(
      "No, and tell Codex what to do differently (esc)",
    );
    // Menu rows select by digit; the trailing CR is inert under codex's kitty
    // keyboard protocol.
    expect(opts.map((o) => dec.decode(o.keys))).toEqual(["1\r", "2\r", "3\r"]);
    // Only the live selector row carries the "›" highlight.
    expect(opts.map((o) => o.highlighted === true)).toEqual([
      true,
      false,
      false,
    ]);
  });

  test("corpus: apply-patch approval dialog", async () => {
    const req = codex.DetectInput(await corpusScreen("approval-patch"));
    expect(req).not.toBeNull();
    expect(req!.kind).toBe(codex.KindApproval);
    expect(req!.prompt).toBe("Would you like to make the following edits?");
    expect(req!.options!.map((o) => o.alias)).toEqual([
      "proceed",
      "proceed",
      "deny",
    ]);
    expect(req!.options!.some((o) => o.highlighted)).toBe(true);
    expect(req!.id).not.toBe("");
  });

  test("corpus: the two dialogs get distinct stable ids", async () => {
    const cmd = codex.DetectInput(await corpusScreen("approval-command"))!;
    const patch = codex.DetectInput(await corpusScreen("approval-patch"))!;
    expect(cmd.id).not.toBe(patch.id);
    // Stable across a redraw of the same screen (drives InputRequested/-Resolved
    // diffing in CodexAdapter.onScreen).
    expect(codex.DetectInput(await corpusScreen("approval-command"))!.id).toBe(
      cmd.id,
    );
  });

  test("is never auto-dismissed", async () => {
    // The chat-level half is pinned by test/chat/codex_dismiss.test.ts; this pins
    // the turns-level switch so a refactor of it cannot regress to auto-approval.
    const req = codex.DetectInput(await corpusScreen("approval-command"));
    const [keys, ok] = codex.AutoDismissKeys(req);
    expect(ok).toBe(false);
    expect(keys).toBeNull();
  });

  test("synthetic approval screen matches the corpus shape", () => {
    const req = codex.DetectInput(approvalScreen());
    expect(req).not.toBeNull();
    expect(req!.kind).toBe(codex.KindApproval);
  });

  // ── Ordering pins: KindApproval is checked before every interstitial ───────

  test("approval body quoting 'Press enter to continue' stays KindApproval", () => {
    // continueAnchor → KindNotice auto-dismisses with a bare "\r", which on an
    // approval dialog would press Enter on the highlighted "Yes" — auto-approve.
    const req = codex.DetectInput(
      approvalScreen({ body: "Press enter to continue" }),
    );
    expect(req).not.toBeNull();
    expect(req!.kind).toBe(codex.KindApproval);
    expect(codex.AutoDismissKeys(req)[1]).toBe(false);
  });

  test("approval body quoting 'Update available!' stays KindApproval", () => {
    // The updateAnchor branch return-nulls the whole function when its skip gate
    // fails, which would swallow this dialog and revive the false-TurnComplete.
    const req = codex.DetectInput(
      approvalScreen({ body: "Update available! 1.0 -> 2.0" }),
    );
    expect(req).not.toBeNull();
    expect(req!.kind).toBe(codex.KindApproval);
    expect(codex.AutoDismissKeys(req)[1]).toBe(false);
  });

  test("approval body quoting the migration anchor stays KindApproval", () => {
    const req = codex.DetectInput(
      approvalScreen({ body: "Choose how you'd like Codex to proceed" }),
    );
    expect(req).not.toBeNull();
    expect(req!.kind).toBe(codex.KindApproval);
  });

  // ── The mandatory-strict gate ─────────────────────────────────────────────

  test("requires a '›' highlight on a parsed menu row", () => {
    expect(
      codex.DetectInput(
        approvalScreen({
          menu: [
            "  1. Yes, proceed (y)",
            "  2. No, and tell Codex what to do (esc)",
          ],
        }),
      ),
    ).toBeNull();
  });

  test("requires a proceed-aliased row", () => {
    expect(
      codex.DetectInput(
        approvalScreen({ menu: ["› 1. Maybe later", "  2. No, cancel that"] }),
      ),
    ).toBeNull();
  });

  test("requires a deny-aliased row", () => {
    expect(
      codex.DetectInput(
        approvalScreen({
          menu: ["› 1. Yes, proceed (y)", "  2. Tell me more"],
        }),
      ),
    ).toBeNull();
  });

  test("requires the anchor", () => {
    expect(
      codex.DetectInput(
        approvalScreen().replace("Would you like to run", "Maybe run"),
      ),
    ).toBeNull();
  });

  // ── Adversarial: assistant prose that quotes the anchor ────────────────────

  // An assistant reply that quotes the approval anchor AND enumerates
  // proceed/deny-shaped rows, with NO "›" highlight on those rows — plus, higher
  // up the screen, a scrollback echo of a past prompt that itself began with a
  // number ("› N. …", codex renders past prompts as "›"-prefixed rows).
  //
  // This shape is the reason the gate must key on the highlight of a PARSED MENU
  // row taken from the anchor tail. A screen-wide highlight regex matches the
  // echo and false-positives; so does a whole-screen row parse when the echo's
  // digit does not collide with the enumerated ones. A false positive here is
  // worse than the false-complete this feature replaces: onWrapperStatus would
  // suppress TurnComplete and ready.ts would block sends — a silent deadlock.
  function proseSpoof(echo: string): string {
    return [
      echo,
      "",
      "• Codex asks for approval before running a command. It prints:",
      '    "Would you like to run the following command?"',
      "  and then offers you:",
      "    1. Yes, run it",
      "    2. No, cancel that",
      "",
      "› ",
    ].join("\n");
  }

  test("prose quoting the anchor with no highlighted menu row is not an approval", () => {
    expect(
      codex.DetectInput(proseSpoof("› Explain the approval flow")),
    ).toBeNull();
  });

  test("… even with a '› 1. …' scrollback echo colliding with the enumeration", () => {
    expect(
      codex.DetectInput(proseSpoof("› 1. Explain the approval flow")),
    ).toBeNull();
  });

  test("… even with a '› 4. …' scrollback echo NOT colliding with the enumeration", () => {
    // Regression: digit dedup does not cover this one — the echo is a parsed row
    // and lent its highlight to the gate until detectApproval was scoped to the
    // anchor tail.
    expect(
      codex.DetectInput(proseSpoof("› 4. Explain the approval flow")),
    ).toBeNull();
  });
});

describe("codex approval option aliases", () => {
  // aliasForLabel is module-private; drive it through DetectInput's parsed rows.
  function aliasesFor(menu: string[]): string[] {
    const req = codex.DetectInput(approvalScreen({ menu }));
    expect(
      req,
      "menu did not classify as an approval: " + menu.join(" | "),
    ).not.toBeNull();
    return req!.options!.map((o) => o.alias);
  }

  test("bare 'Yes' / 'No' labels alias proceed / deny", () => {
    // The pinned chat contract fixture (test/chat/codex_dismiss.test.ts) carries
    // exactly these labels. Bare "No" lowercases to "no", which the claude deny
    // vocabulary deliberately misses (its tokens are "no," / "no " so they cannot
    // match "now"/"notice") — codex adds an exact-match case. Without it the
    // deny-row gate would reject a real dialog rendering "2. No".
    expect(aliasesFor(["› 1. Yes", "  2. No"])).toEqual(["proceed", "deny"]);
  });

  test("longer yes/no phrasings alias proceed / deny", () => {
    expect(
      aliasesFor([
        "› 1. Yes, proceed (y)",
        "  2. No, and tell Codex what to do (esc)",
      ]),
    ).toEqual(["proceed", "deny"]);
    expect(aliasesFor(["› 1. Accept the change", "  2. Reject it"])).toEqual([
      "proceed",
      "deny",
    ]);
    expect(aliasesFor(["› 1. Continue", "  2. Cancel"])).toEqual([
      "proceed",
      "deny",
    ]);
  });

  test("interstitial tokens still win over the yes/no vocabulary", () => {
    // "Skip"/"Update" are matched first so update-notice classification and its
    // Skip-row auto-dismiss are unchanged by the approval vocabulary.
    const req = codex.DetectInput(updateNoticeScreen)!;
    expect(req.kind).toBe(codex.KindUpdateNotice);
    expect(req.options!.map((o) => o.alias)).toEqual([
      "update",
      "skip",
      "skip",
    ]);
  });
});
