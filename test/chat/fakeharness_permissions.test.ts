// Self-verification for the META-HARNESS-126 fake-harness scaffolding: the
// /permissions steps and painters added to fakeharness.ts have no consuming
// driver yet (that lands in a sibling subtask), so this file proves each piece
// parses/matches the way the real adapter and ready-gate would, independently
// of that driver.
import { describe, expect, test } from "vitest";
import { codex } from "../../src/turns/index.ts";
import { readyForInput } from "../../src/chat/ready.ts";
import {
  New,
  SubmitCSI13u,
  BackoutESC,
  ComposerClearCtrlU,
} from "./fakeharness.ts";

// Pulls a wait_input step's compiled regex straight out of the assembled
// Script — the exact string fakeharness.mjs itself passes to `new RegExp(...)`
// (readUntil, fakeharness.mjs:23) — so this tests the real matcher, not a
// paraphrase of it.
function waitRegex(idx: number): RegExp {
  const script = New("codex")
    .Idle()
    .AwaitPermissionsOpen()
    .AwaitBackout()
    .AwaitComposerClear()
    .Build();
  const step = script.steps[idx];
  if (!step.wait_input) throw new Error(`step ${idx} is not a wait_input`);
  return new RegExp(step.wait_input.until_regex);
}

describe("AwaitPermissionsOpen", () => {
  test("matches the probed /permissions + CSI 13u submit burst", () => {
    const re = waitRegex(1);
    expect(re.test("/permissions" + SubmitCSI13u)).toBe(true);
  });

  test("does not match the bare command without a submit", () => {
    const re = waitRegex(1);
    expect(re.test("/permissions")).toBe(false);
  });
});

describe("AwaitBackout", () => {
  test("matches a bare ESC", () => {
    const re = waitRegex(2);
    expect(re.test(BackoutESC)).toBe(true);
  });

  // The critical property: a matcher built on a naive /\x1b/ would also fire
  // here, since both CSI encodings start with the exact same 0x1b byte a bare
  // ESC is — which would make every backout assertion pass on a submit it was
  // supposed to be distinguishing from.
  test("does NOT match CSI 13u (the submit key)", () => {
    const re = waitRegex(2);
    expect(re.test("\x1b[13u")).toBe(false);
    expect(re.test(SubmitCSI13u)).toBe(false);
  });

  test("does NOT match CSI 27u (the alternate backout encoding)", () => {
    const re = waitRegex(2);
    expect(re.test("\x1b[27u")).toBe(false);
  });
});

describe("AwaitComposerClear", () => {
  test("matches the probed Ctrl-U composer-clear byte", () => {
    const re = waitRegex(3);
    expect(re.test(ComposerClearCtrlU)).toBe(true);
  });
});

// codexPermissionsRows()'s parsed shape, from a script assembled purely to
// extract the painted screen text (frame steps stash the literal `screen`
// string on the step — no PTY/process involved).
function paintedScreen(build: (b: ReturnType<typeof New>) => void): string {
  const b = New("codex");
  build(b);
  const script = b.Build();
  const frame = script.steps.find((s) => s.frame)?.frame;
  if (!frame) throw new Error("no frame step painted");
  return frame.screen;
}

describe("CodexPermissionsDialog", () => {
  test("current=1 parses to the permissions-dialog corpus shape", () => {
    const text = paintedScreen((b) => b.CodexPermissionsDialog(0, 1));
    const req = codex.DetectInput(text);
    expect(req).not.toBeNull();
    expect(req!.kind).toBe(codex.KindPermissions);
    expect(req!.prompt).toBe("Update Model Permissions");

    const opts = req!.options!;
    expect(opts.map((o) => o.label)).toEqual([
      "Ask for approval (current)",
      "Approve for me",
      "Full Access",
    ]);
    expect(opts.map((o) => o.highlighted === true)).toEqual([
      true,
      false,
      false,
    ]);

    const [keys, autoDismissable] = codex.AutoDismissKeys(req);
    expect(autoDismissable).toBe(false);
    expect(keys).toBeNull();

    expect(readyForInput("codex", text)).toBe(false);
  });

  test("current=2 parses to the permissions-approve-current corpus shape", () => {
    const text = paintedScreen((b) => b.CodexPermissionsDialog(0, 2));
    const req = codex.DetectInput(text);
    expect(req).not.toBeNull();
    expect(req!.kind).toBe(codex.KindPermissions);

    const opts = req!.options!;
    expect(opts.map((o) => o.label)).toEqual([
      "Ask for approval",
      "Approve for me (current)",
      "Full Access",
    ]);
    // The highlight rides with the CURRENT preset here, not row 1 — proving a
    // scenario can paint "the target preset is already current" for the
    // driver's no-op backout path.
    expect(opts.map((o) => o.highlighted === true)).toEqual([
      false,
      true,
      false,
    ]);

    expect(readyForInput("codex", text)).toBe(false);
  });
});

describe("CodexPermissionsDialogFlagOff", () => {
  test("parses to a live permissions dialog with no Approve-for-me row", () => {
    const text = paintedScreen((b) => b.CodexPermissionsDialogFlagOff(0));
    const req = codex.DetectInput(text);
    expect(req).not.toBeNull();
    expect(req!.kind).toBe(codex.KindPermissions);

    const opts = req!.options!;
    expect(opts.map((o) => o.label)).toEqual([
      "Read Only (current)",
      "Default",
      "Custom permissions",
    ]);
    // The row a preset-selection driver looks for is genuinely absent — this is
    // the screen shape ErrPermissionPresetUnavailable's rows list would be
    // built from.
    expect(
      opts.some((o) => o.label.toLowerCase().includes("approve for me")),
    ).toBe(false);
    expect(opts.some((o) => o.highlighted === true)).toBe(true);

    expect(readyForInput("codex", text)).toBe(false);
  });
});

// composerRowRE mirror (src/turns/harness/codex.ts:396, private — not exported
// for reuse). Kept in one place, tested against the module's own public
// behaviour (readyForInput) alongside the direct capture check, so a
// discrepancy between the two would fail loudly rather than silently pass a
// paraphrase of the real regex.
const composerRowRE = /^[^\S\r\n]*›(.*)$/m;

describe("CodexDirtyComposer", () => {
  test("a composer still holding the swallowed /permissions text has a non-empty capture", () => {
    const text = paintedScreen((b) => b.CodexDirtyComposer(0, "/permissions"));
    const m = composerRowRE.exec(text);
    expect(m).not.toBeNull();
    expect(m![1].trim().length).toBeGreaterThan(0);
    expect(m![1].trim()).toBe("/permissions");

    // The trap the driver has to work around: codexPromptRE (ready.ts:58)
    // matches a composer holding literal text just as happily as an empty one,
    // so the screen reports ready even though the write was never submitted.
    expect(readyForInput("codex", text)).toBe(true);
  });

  test("an empty composer row has an empty capture", () => {
    const text = paintedScreen((b) => b.CodexDirtyComposer(0, ""));
    const m = composerRowRE.exec(text);
    expect(m).not.toBeNull();
    expect(m![1].trim().length).toBe(0);

    expect(readyForInput("codex", text)).toBe(true);
  });
});
