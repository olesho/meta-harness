// Corpus replay for the claude-code `trust-dialog` cell: claude 2.1.251's
// UNNUMBERED folder-trust dialog, recorded live and left unanswered.
//
// The recording is taken by `screenbench-record --scenario trust-dialog`
// (PUPPET-304); the live run that produces the checked-in triple is its sibling
// ticket, PUPPET-303 piece C. Until those bytes land this file SKIPS CLEANLY —
// corpusBytes returns null for an absent recording, which is the same contract
// the Go harness tests express with t.Skip.
//
// What the cell pins, once present: a blocking dialog whose options the
// digit-requiring menu parser CANNOT read. `readyForInput` must still report
// not-ready (it is anchor-only, so it never depended on the parse), while
// `DetectInput` returns null — the silent-hang half of the bug PUPPET-296 fixes.

import { describe, expect, test } from "vitest";

import { readyForInput } from "../../../src/chat/ready.ts";
import { newScreen } from "../../../src/screen/index.ts";
import {
  DetectInput,
  New as newClaudeAdapter,
} from "../../../src/turns/harness/claudecode.ts";
import { InputRequested } from "../../../src/turns/index.ts";
import { corpusBytes } from "../corpus.ts";

const bytes = corpusBytes("claude-code", "trust-dialog");

/** Replays the recorded stream into a 120x40 Screen and returns its text. */
async function replay(): Promise<string> {
  const scr = newScreen(120, 40);
  await scr.write(bytes!);
  return scr.snapshot().text;
}

describe("claude-code trust-dialog corpus", () => {
  // Skip cleanly until the live recording lands (PUPPET-303 piece C).
  test.skipIf(bytes === null)(
    "the recorded frame is a blocking dialog, not a ready composer",
    async () => {
      const text = await replay();
      // This holds via the anchor-only `claudeBlockingDialog` in
      // src/chat/ready.ts and must stay INDEPENDENT of the menu parser: the
      // whole point of this cell is a dialog whose options do not parse.
      expect(readyForInput("claude-code", text)).toBe(false);
    },
  );

  test.skipIf(bytes === null)(
    "the frame carries the 2.1.251 anchor and both unnumbered choices",
    async () => {
      const text = await replay();
      expect(text).toContain("Is this a project you created or one you trust?");
      expect(text).toContain("No, exit");
      expect(text).toContain("Yes, I trust this folder");
    },
  );

  // ---- PUPPET-296 (unnumbered selector parser) ------------------------------
  //
  // These are the assertions the ported parser must satisfy. They are SKIPPED
  // until PUPPET-296 lands in this repo — today `DetectInput` returns null on
  // exactly this frame, which is the bug. Flip these on (drop the `.skip`) with
  // that ticket; they also need the recording, hence the double gate.
  test.skip("DetectInput parses the unnumbered trust dialog", async () => {
    const text = await replay();
    const req = DetectInput(text);
    expect(req).not.toBeNull();
    expect(req!.kind).toBe("trust_prompt");
    expect(req!.options).toHaveLength(2);
    const [proceed, deny] = [
      req!.options!.find((o) => o.alias === "proceed")!,
      req!.options!.find((o) => o.alias === "deny")!,
    ];
    expect(proceed).toBeDefined();
    expect(deny).toBeDefined();
    // The highlight defaults to "No, exit" — reaching "Yes, I trust this
    // folder" is one Down then Enter, which is what `proceed.keys` must encode.
    expect(deny.highlighted).toBe(true);
    expect(proceed.keys).toBe("\x1b[B\r");
  });

  test.skip("the adapter emits exactly one InputRequested for the frame", async () => {
    const text = await replay();
    const evs = newClaudeAdapter().onScreen({
      text,
      cols: 120,
      rows: 40,
      cursorCol: 0,
      cursorRow: 0,
      generation: 1,
    });
    expect(evs.filter((e) => e.kind === InputRequested)).toHaveLength(1);
  });
});
