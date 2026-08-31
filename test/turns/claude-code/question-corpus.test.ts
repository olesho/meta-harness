// Corpus replay for the AskUserQuestion dialogs — PUPPET-301.
//
// The fixtures under test/corpus/claude-code/question-{single,multi,review}
// are REAL claude 2.1.251 PTY recordings: bytes.raw is the captured byte
// stream and expected.txt is that stream replayed through src/screen's Screen
// at the recorded geometry. Nothing here is hand-typed, which is the whole
// point — DetectQuestion's option rows are matched by a NUMBER
// (questionOptionRE), and PUPPET-296 found the sibling folder-trust dialog
// rendering its rows unnumbered on this very build. This test is the standing
// evidence that AskUserQuestion has NOT drifted the same way; if a future
// claude drops the digits, these assertions fail loudly instead of the turn
// hanging silently with a dialog nobody detected.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import * as claudecode from "../../../src/turns/harness/claudecode.ts";

const dec = new TextDecoder();

const corpusRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../corpus/claude-code",
);
const frameOf = (dir: string, file = "expected.txt"): string =>
  readFileSync(join(corpusRoot, dir, file), "utf8");
const metaOf = (dir: string): { binary_version: string; cols: number } =>
  JSON.parse(readFileSync(join(corpusRoot, dir, "meta.json"), "utf8"));

/** The pattern claudecode.ts matches option rows with, mirrored verbatim. */
const optionRowRE = /^[^\S\r\n]*(?:❯[^\S\r\n]+)?(\d+)\.[^\S\n]+(\S[^\n]*)$/u;

const dirs = ["question-single", "question-multi", "question-review"] as const;

describe("AskUserQuestion corpus (claude 2.1.251)", () => {
  test.each(dirs)("%s was captured from 2.1.251", (dir) => {
    expect(metaOf(dir).binary_version).toBe("2.1.251");
    expect(frameOf(dir).trim()).not.toBe("");
  });

  test.each(dirs)("%s: option rows are still NUMBERED", (dir) => {
    const rows = frameOf(dir)
      .split("\n")
      .filter((ln) => optionRowRE.test(ln));
    // Every pane in the corpus carries at least a two-option menu.
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  test("single-select pane", () => {
    const req = claudecode.DetectInput(frameOf("question-single"));
    expect(req).not.toBeNull();
    expect(req!.kind).toBe("question");
    expect(req!.prompt).toBe("Which color should I use?");
    expect(req!.header).toBe("Color");
    expect(req!.multiSelect).toBeUndefined();
    expect(
      req!.options!.map((o) => [o.id, o.label, dec.decode(o.keys), o.alias]),
    ).toEqual([
      // A bare digit selects directly: in a multi-question dialog selection
      // advances to the next pane, where a trailing CR would mis-answer it.
      ["1", "Red", "1", ""],
      ["2", "Blue", "2", ""],
      // The injected affordances only take the highlight, so they need the CR.
      ["3", "Type something.", "3\r", "other"],
      ["4", "Chat about this", "4\r", ""],
    ]);
    expect(req!.options![0].description).toBe("Use red.");
    expect(req!.options![1].description).toBe("Use blue.");
  });

  test("multi-select pane", () => {
    const req = claudecode.DetectInput(frameOf("question-multi"));
    expect(req).not.toBeNull();
    expect(req!.kind).toBe("question");
    expect(req!.prompt).toBe("Which toppings do you want?");
    expect(req!.header).toBe("Toppings");
    expect(req!.multiSelect).toBe(true);
    // Tab jumps to the review pane; the digits only toggle checkboxes.
    expect(dec.decode(req!.submitKeys)).toBe("\t");
    expect(
      req!.options!.map((o) => [o.id, o.label, dec.decode(o.keys)]),
    ).toEqual([
      ["1", "Mushrooms", "1"],
      ["2", "Olives", "2"],
      ["3", "Peppers", "3"],
      ["4", "Onions", "4"],
      ["5", "Type something", "5"],
      ["6", "Chat about this", "6"],
    ]);
    // PUPPET-308: the keys above are UNCHANGED — whether a bare digit
    // activates the non-checkbox "Chat about this" row or merely moves the
    // highlight onto it is still an open live question. What the frame settles
    // is which rows are checkbox TOGGLES, and that is asserted structurally:
    // note that "Type something" DOES carry a marker here (unlike on the
    // single-select pane) while "Chat about this", below the rule, does not.
    expect(req!.options!.map((o) => o.toggle)).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
    // The "[✔]"/"[ ]" markers are stripped off the labels, and the widget's
    // bare "Submit" chrome row is not mistaken for an option or a description.
    expect(frameOf("question-multi")).toContain("[✔] Mushrooms");
    expect(req!.options!.some((o) => o.label === "Submit")).toBe(false);
    expect(req!.options!.some((o) => o.description === "Submit")).toBe(false);
  });

  test("multi-select pane, before the checkbox was toggled", () => {
    // Same recording, replayed to the byte offset before the "1" keystroke:
    // all four boxes empty. Detection must be identical either way.
    const untoggled = frameOf("question-multi", "expected-untoggled.txt");
    expect(untoggled).not.toContain("[✔]");
    const req = claudecode.DetectInput(untoggled);
    expect(req).not.toBeNull();
    expect(req!.multiSelect).toBe(true);
    expect(req!.options!.map((o) => o.label)).toEqual([
      "Mushrooms",
      "Olives",
      "Peppers",
      "Onions",
      "Type something",
      "Chat about this",
    ]);
    // "[ ]" marks a toggle exactly as "[✔]" does, and the pane's request id is
    // unaffected by either (inputID hashes kind/prompt/labels only).
    expect(req!.options!.map((o) => o.toggle)).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
    expect(req!.id).toBe(claudecode.DetectInput(frameOf("question-multi"))!.id);
  });

  test("single-select and review panes never set toggle", () => {
    // The flag exists only to tell a multi-select checkbox row from an injected
    // affordance. Every other pane must leave it undefined so the chat layer's
    // `toggle === false` test keeps them on the pre-existing submit path.
    for (const dir of ["question-single", "question-review"] as const) {
      const req = claudecode.DetectInput(frameOf(dir));
      expect(req!.options!.every((o) => o.toggle === undefined)).toBe(true);
    }
  });

  test("review pane", () => {
    const req = claudecode.DetectInput(frameOf("question-review"));
    expect(req).not.toBeNull();
    expect(req!.kind).toBe("question_review");
    expect(req!.prompt).toContain("Ready to submit your answers?");
    expect(req!.prompt).toContain("→ Red");
    expect(req!.prompt).toContain("→ Small");
    expect(
      req!.options!.map((o) => [o.id, o.label, dec.decode(o.keys), o.alias]),
    ).toEqual([
      ["1", "Submit answers", "1\r", "proceed"],
      ["2", "Cancel", "2\r", "deny"],
    ]);
  });

  test("each captured pane gets its own request id", () => {
    const ids = dirs.map((d) => claudecode.DetectInput(frameOf(d))!.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
