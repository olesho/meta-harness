// PUPPET-307: DetectInputDetail's four states, extended to the AskUserQuestion
// path. Before this, an unmistakable question pane whose rows could not be
// parsed was reported as "no dialog at all" — permanent, silent, and fatal to
// the turn. Modelled on unrecognized_dialog.test.ts, which is the same set of
// assertions for the startup path.
//
// The frames below are transcribed from the live 2.1.251 capture in
// test/corpus/claude-code/question-single/expected.txt on loom/PUPPET-301
// @ 30cf388 (and question-review/expected.txt for the review pane). The
// corpus is NOT merged here — none of its frames exercises these states, since
// on 2.1.251 every option row is still numbered and parses cleanly. Right-hand
// padding is irrelevant to every parser on this path and is dropped for
// readability; nothing else is altered.

import { describe, expect, test } from "vitest";
import * as claudecode from "../../../src/turns/harness/claudecode.ts";
import type { Event } from "../../../src/turns/index.ts";
import {
  Errored,
  InputRequested,
  InputResolved,
} from "../../../src/turns/index.ts";
import { textSnap } from "../corpus.ts";

const footerAnchor = "Enter to select ·";
const reviewAnchor = "Ready to submit your answers?";

// The composer line sits ABOVE the tab strip — that "❯" is exactly what a
// region starting at line 0 would misread as a choice row.
const composer =
  "❯ Use the AskUserQuestion tool to ask me exactly one question…\n" +
  "────────────────────────────────────────────\n";

// 1. The live single-select pane: numbered rows, footer, question text.
const okFrame =
  composer +
  " ☐ Color\n" +
  "\n" +
  "Which color should I use?\n" +
  "\n" +
  "❯ 1. Red\n" +
  "     Use red.\n" +
  "  2. Blue\n" +
  "     Use blue.\n" +
  "Enter to select · ↑/↓ to navigate · Esc to cancel\n";

// 2. The headline case: the same pane with the digits gone. The rows are
// painted and choice-shaped, so this is unreadable, not absent.
const unnumberedFrame =
  composer +
  " ☐ Color\n" +
  "\n" +
  "Which color should I use?\n" +
  "\n" +
  "❯ Red\n" +
  "     Use red.\n" +
  "  Blue\n" +
  "     Use blue.\n" +
  "Enter to select · ↑/↓ to navigate · Esc to cancel\n";

// 3. Mid-render: footer up, nothing below the tab line yet.
const pendingFrame = composer + " ☐ Color\n" + "\n" + "Enter to select ·\n";

// 4. Tab line and rows but NO footer — not yet provably a dialog.
const noFooterFrame =
  composer + " ☐ Color\n" + "\nWhich color should I use?\n" + "\n❯ 1. Red\n";

// 5. A reply containing a rendered to-do list, plus a bare composer. The
// checkbox glyphs are real; the anchor threshold is what keeps this "none".
const todoFrame =
  "⏺ Here is the plan:\n" +
  "  ☐ write the parser\n" +
  "  ☒ read the frame\n" +
  "\n" +
  "❯ \n";

// 11. Review pane with the rows stripped of their digits.
const reviewUnnumbered =
  composer +
  "←  ☒ Color  ☒ Size  ✔ Submit  →\n" +
  "\n" +
  "Review your answers\n" +
  "\n" +
  " ● Which color should I use?\n" +
  "   → Red\n" +
  "\n" +
  "Ready to submit your answers?\n" +
  "\n" +
  "❯ Submit answers\n" +
  "  Cancel\n";

// 12. The review anchor with nothing painted below it.
const reviewPending =
  composer +
  "←  ☒ Color  ☒ Size  ✔ Submit  →\n" +
  "\n" +
  "Review your answers\n" +
  "\n" +
  "Ready to submit your answers?\n";

// 13. A multi-select pane: the Submit tab is on the tab line but there is no
// review anchor, so it must fall through to the QUESTION branch.
const multiUnnumbered =
  composer +
  "←  ☐ Toppings  ✔ Submit  →\n" +
  "\n" +
  "Which toppings?\n" +
  "\n" +
  "❯ [ ] Mushrooms\n" +
  "  [ ] Olives\n" +
  "Enter to select · Tab to submit · Esc to cancel\n";

// 14. Rows that parse, but no question text above them.
const noPreambleFrame =
  composer +
  " ☐ Color\n" +
  "\n" +
  "❯ 1. Red\n" +
  "  2. Blue\n" +
  "Enter to select · ↑/↓ to navigate · Esc to cancel\n";

// 15. A folder-trust dialog and a full question pane in one frame.
const trustPlusQuestion =
  "Quick safety check: Is this a project you created or one you trust? …\n" +
  "Security guide\n" +
  " ❯ 1. No, exit\n" +
  "   2. Yes, I trust this folder\n" +
  "Enter to confirm · Esc to cancel\n" +
  okFrame;

function ofKind(evs: Event[], k: string): Event[] {
  return evs.filter((e) => e.kind === k);
}

function stateOf(text: string): string {
  return claudecode.DetectQuestionDetail(text)[1];
}

describe("claude-code question dialog detail", () => {
  test("a fully rendered pane is ok and still parses", () => {
    const [req, det] = claudecode.DetectQuestionDetail(okFrame);
    expect(det).toBe(claudecode.DetectOK);
    expect(req!.kind).toBe("question");
    expect(req!.prompt).toBe("Which color should I use?");
    // The nullable wrapper and the startup entry point agree.
    expect(claudecode.DetectInput(okFrame)!.kind).toBe("question");
    expect(claudecode.DetectInputDetail(okFrame)[1]).toBe(claudecode.DetectOK);
  });

  test("unnumbered rows under the footer are unparseable, not none", () => {
    expect(stateOf(unnumberedFrame)).toBe(claudecode.DetectUnparseable);
    expect(claudecode.DetectInputDetail(unnumberedFrame)[1]).toBe(
      claudecode.DetectUnparseable,
    );
    // The nullable wrappers still map every non-ok state to null.
    expect(claudecode.DetectInput(unnumberedFrame)).toBeNull();
    expect(claudecode.DetectQuestion(unnumberedFrame)).toBeNull();
  });

  test("a mid-render pane is pending and emits nothing at all", () => {
    expect(stateOf(pendingFrame)).toBe(claudecode.DetectPending);
    const a = claudecode.New();
    expect(a.onScreen(textSnap(pendingFrame)).length).toBe(0);
  });

  test("a pane without its footer is none", () => {
    expect(stateOf(noFooterFrame)).toBe(claudecode.DetectNone);
    const a = claudecode.New();
    expect(a.onScreen(textSnap(noFooterFrame)).length).toBe(0);
  });

  test("a rendered to-do list is none, composer glyph and all", () => {
    expect(stateOf(todoFrame)).toBe(claudecode.DetectNone);
    expect(claudecode.DetectInputDetail(todoFrame)[1]).toBe(
      claudecode.DetectNone,
    );
  });

  test("emits exactly one Errored across identical redraws", () => {
    const a = claudecode.New();
    const errored: Event[] = [];
    for (let i = 0; i < 2; i++) {
      errored.push(...ofKind(a.onScreen(textSnap(unnumberedFrame)), Errored));
    }
    expect(errored.length).toBe(1);
  });

  test("the fingerprint clears when the screen leaves the state", () => {
    const a = claudecode.New();
    expect(ofKind(a.onScreen(textSnap(unnumberedFrame)), Errored).length).toBe(
      1,
    );
    a.onScreen(textSnap(okFrame));
    expect(ofKind(a.onScreen(textSnap(unnumberedFrame)), Errored).length).toBe(
      1,
    );
  });

  test("nothing is synthesized for a pane that never parsed", () => {
    const a = claudecode.New();
    const out = a.onScreen(textSnap(unnumberedFrame));
    expect(ofKind(out, InputRequested)).toEqual([]);
    expect(ofKind(out, InputResolved)).toEqual([]);
  });

  // §2.5: a surfaced request must not be resolved just because the dialog went
  // momentarily unreadable — the dialog is still up.
  test("an unparseable frame does not resolve a live request", () => {
    const a = claudecode.New();
    expect(ofKind(a.onScreen(textSnap(okFrame)), InputRequested).length).toBe(
      1,
    );
    const out = a.onScreen(textSnap(unnumberedFrame));
    expect(ofKind(out, InputResolved)).toEqual([]);
    expect(ofKind(out, Errored).length).toBe(1);

    // …and the hold cannot wedge: once the dialog is genuinely gone the
    // request resolves on the next frame.
    expect(ofKind(a.onScreen(textSnap(todoFrame)), InputResolved).length).toBe(
      1,
    );
  });

  test("the review pane carries its own states and its own anchor", () => {
    expect(stateOf(reviewUnnumbered)).toBe(claudecode.DetectUnparseable);
    const a = claudecode.New();
    const errs = ofKind(a.onScreen(textSnap(reviewUnnumbered)), Errored);
    expect(errs.length).toBe(1);
    expect(errs[0].reason).toContain(reviewAnchor);
    expect(errs[0].reason).toContain("Submit answers");
  });

  test("a review anchor with no menu below it is pending", () => {
    expect(stateOf(reviewPending)).toBe(claudecode.DetectPending);
  });

  test("the Submit-tab fall-through reaches the question branch", () => {
    expect(stateOf(multiUnnumbered)).toBe(claudecode.DetectUnparseable);
    const a = claudecode.New();
    const errs = ofKind(a.onScreen(textSnap(multiUnnumbered)), Errored);
    expect(errs.length).toBe(1);
    expect(errs[0].reason).toContain(footerAnchor);
    expect(errs[0].reason).toContain("Mushrooms");
  });

  // Uniformity: parsed rows plus a missing question text is a fully painted
  // menu we are refusing to use — loud, not transient. Pinned so a later
  // reader does not "fix" it to pending.
  test("parsed rows with no question text are unparseable", () => {
    expect(stateOf(noPreambleFrame)).toBe(claudecode.DetectUnparseable);
  });

  test("a startup anchor still wins over a question pane", () => {
    const [req, det] = claudecode.DetectInputDetail(trustPlusQuestion);
    expect(det).toBe(claudecode.DetectOK);
    expect(req!.kind).toBe("trust_prompt");
  });

  test("the report names the anchor, the question and the raw rows", () => {
    const a = claudecode.New();
    const errs = ofKind(a.onScreen(textSnap(unnumberedFrame)), Errored);
    expect(errs.length).toBe(1);
    expect(errs[0].reason).toContain("unrecognized blocking dialog");
    expect(errs[0].reason).toContain(footerAnchor);
    expect(errs[0].reason).toContain("☐ Color");
    expect(errs[0].reason).toContain("Red");
    expect(errs[0].reason).toContain("Blue");
  });
});
