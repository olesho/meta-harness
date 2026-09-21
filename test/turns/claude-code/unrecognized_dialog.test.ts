// The adapter half of PUPPET-296: an unreadable blocking dialog is reported
// loudly instead of silently read as "no dialog".
//
// Port of pkg/chat/unrecognized_dialog_test.go. The Go file lives in pkg/chat
// because its other half exercises ready.go's ErrUnrecognizedDialog; that half
// does NOT port (src/chat/ready.ts is anchor-only and already blocks — see
// DetectInputDetail's doc comment), so the assertions that do carry live here,
// with the adapter.

import { describe, expect, test } from "vitest";
import * as claudecode from "../../../src/turns/harness/claudecode.ts";
import type { Event } from "../../../src/turns/index.ts";
import {
  Errored,
  InputRequested,
  InputResolved,
} from "../../../src/turns/index.ts";
import { textSnap } from "../corpus.ts";

const trustAnchorAlt = "Is this a project you created or one you trust?";

// An anchor with a visible-but-unreadable choice block: the single "❯" row is
// below the minimum, so parseSelectorMenu rejects it — but the menu IS painted,
// which is what makes this unparseable rather than pending.
const unreadableFrame =
  "Quick safety check: Is this a project you created or one you trust? …\n" +
  "Security guide\n ❯ No, exit\nEnter to confirm · Esc to cancel\n";

// A DIFFERENT unreadable shape under the same anchor: the fingerprint covers the
// candidate lines, not just the anchor, so this must report again.
const otherUnreadableFrame =
  "Quick safety check: Is this a project you created or one you trust? …\n" +
  "Some other guide\n ❯ Nope, quit\nEnter to confirm · Esc to cancel\n";

const clearScreen = "Claude Code\n\n❯ \n";

// The readable 2.1.251 frame — a non-unparseable state, which must clear the
// dedup fingerprint.
const readableFrame =
  "Quick safety check: Is this a project you created or one you trust? …\n" +
  "Security guide\n" +
  " ❯ No, exit\n" +
  "   Yes, I trust this folder\n" +
  "Enter to confirm · Esc to cancel\n";

function ofKind(evs: Event[], k: string): Event[] {
  return evs.filter((e) => e.kind === k);
}

describe("claude-code unrecognized dialog", () => {
  test("emits exactly one Errored across identical redraws", () => {
    const a = claudecode.New();
    const errored: Event[] = [];
    const other: Event[] = [];
    for (let i = 0; i < 3; i++) {
      for (const ev of a.onScreen(textSnap(unreadableFrame))) {
        if (ev.kind === Errored) errored.push(ev);
        else other.push(ev);
      }
    }
    expect(errored.length).toBe(1);
    expect(errored[0].reason).toContain("unrecognized blocking dialog");
    expect(errored[0].reason).toContain(trustAnchorAlt);
    // The raw candidate lines are the evidence an operator reads.
    expect(errored[0].reason).toContain("No, exit");
    expect(errored[0].reason).toContain("Security guide");
    // Never fabricate a transition for a request that was never surfaced.
    expect(ofKind(other, InputRequested)).toEqual([]);
    expect(ofKind(other, InputResolved)).toEqual([]);
  });

  test("a different unreadable shape reports again", () => {
    const a = claudecode.New();
    expect(ofKind(a.onScreen(textSnap(unreadableFrame)), Errored).length).toBe(
      1,
    );
    expect(
      ofKind(a.onScreen(textSnap(otherUnreadableFrame)), Errored).length,
    ).toBe(1);
  });

  // The dedup fingerprint is per-occurrence, not per-process: a dialog that
  // clears and comes back must report again, or a second untrusted repo in one
  // session is silent.
  test("reports again after the dialog clears", () => {
    const a = claudecode.New();
    expect(ofKind(a.onScreen(textSnap(unreadableFrame)), Errored).length).toBe(
      1,
    );
    expect(ofKind(a.onScreen(textSnap(clearScreen)), Errored).length).toBe(0);
    expect(ofKind(a.onScreen(textSnap(unreadableFrame)), Errored).length).toBe(
      1,
    );
  });

  test("a parseable frame clears the fingerprint and surfaces the request", () => {
    const a = claudecode.New();
    expect(ofKind(a.onScreen(textSnap(unreadableFrame)), Errored).length).toBe(
      1,
    );

    const evs = a.onScreen(textSnap(readableFrame));
    expect(ofKind(evs, Errored).length).toBe(0);
    const req = ofKind(evs, InputRequested);
    expect(req.length).toBe(1);
    expect(req[0].input!.kind).toBe("trust_prompt");

    // Back to the unreadable shape: the fingerprint was cleared, so it reports.
    // The readable frame also emits an InputResolved for the request that just
    // vanished — that is the pre-existing transition, not a synthesized one.
    const back = a.onScreen(textSnap(unreadableFrame));
    expect(ofKind(back, Errored).length).toBe(1);
    expect(ofKind(back, InputRequested)).toEqual([]);
  });

  // A mid-render frame — anchor painted, nothing choice-shaped yet — stays
  // pending and silent. Unchanged behaviour, pinned so the new Errored path
  // cannot start firing on it.
  test("a mid-render frame is silent", () => {
    const a = claudecode.New();
    const evs = a.onScreen(textSnap(trustAnchorAlt + "\n"));
    expect(ofKind(evs, Errored)).toEqual([]);
    expect(ofKind(evs, InputRequested)).toEqual([]);
  });
});
