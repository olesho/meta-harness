// Port of pkg/turns/harness/claudecode/menu_selector_test.go.

import { describe, expect, test } from "vitest";
import * as claudecode from "../../../src/turns/harness/claudecode.ts";
import { parseSelectorMenu } from "../../../src/turns/harness/menuSelector.ts";
import type { InputOption } from "../../../src/turns/index.ts";

const dec = new TextDecoder();

// claudecode.ts keeps these anchors module-private; mirror the literals here.
const trustAnchorAlt = "Is this a project you created or one you trust?";

// selectorTrustFrame is claude 2.1.251's folder-trust dialog as captured live
// (tmux, 2026-08-29 — see PUPPET-236). Every line matters: the workspace path
// and "Security guide" sit at column 0 and must NOT become options, the footer
// hint must terminate the block, and the default highlight is on "No, exit" —
// so the affirmative row is reached with a DOWN arrow, never a bare CR.
export const selectorTrustFrame =
  "Accessing workspace:\n" +
  "/private/tmp/trustrepo\n" +
  "Quick safety check: Is this a project you created or one you trust? …\n" +
  "Claude Code'll be able to read, edit, and execute files here.\n" +
  "Security guide\n" +
  " ❯ No, exit\n" +
  "   Yes, I trust this folder\n" +
  "Enter to confirm · Esc to cancel\n";

// selectorTrustFrameSecondRow is the same dialog with the highlight moved down
// one row (what the screen looks like after the user, or a previous keypress,
// has navigated). The affirmative row is now the highlighted one and the DENY
// row is reached with an UP arrow.
export const selectorTrustFrameSecondRow =
  "Accessing workspace:\n" +
  "/private/tmp/trustrepo\n" +
  "Quick safety check: Is this a project you created or one you trust? …\n" +
  "Security guide\n" +
  "   No, exit\n" +
  " ❯ Yes, I trust this folder\n" +
  "Enter to confirm · Esc to cancel\n";

// selectorTrustFrameBoxed is the same shape inside the bordered box the vt100
// emulator renders for some builds: the left edge shifts every line, so the
// label column is only stable once the border is stripped.
export const selectorTrustFrameBoxed =
  "╭──────────────────────────────────────────────╮\n" +
  "│ Do you trust the files in this folder?       │\n" +
  "│                                              │\n" +
  "│ /Users/oleh/Work/aether/harness-wrapper      │\n" +
  "│                                              │\n" +
  "│ ❯ No, exit                                   │\n" +
  "│   Yes, I trust this folder                   │\n" +
  "│                                              │\n" +
  "│ Enter to confirm · Esc to cancel             │\n" +
  "╰──────────────────────────────────────────────╯\n";

// selectorTrustFrameAstral pins the code-point indexing of the label column: a
// folder name carrying an astral codepoint (U+1F4C1, two UTF-16 units) shifts
// every column after it. A UTF-16-indexed port measures the wrong label column
// and drops the row.
const selectorTrustFrameAstral =
  "Quick safety check: Is this a project you created or one you trust? …\n" +
  "Security guide\n" +
  " ❯ No, exit\n" +
  "   Yes, I trust 📁repo\n" +
  "Enter to confirm · Esc to cancel\n";

/**
 * afterAnchor slices a frame the way DetectInputDetail does, so the parser tests
 * see exactly the scope production gives it.
 */
export function afterAnchor(frame: string): string {
  for (const anchor of [
    "Do you trust the files in this folder?",
    trustAnchorAlt,
    "Bypass Permissions mode",
  ]) {
    const i = frame.indexOf(anchor);
    if (i >= 0) return frame.slice(i + anchor.length);
  }
  throw new Error("fixture carries no known dialog anchor:\n" + frame);
}

interface WantOption {
  id: string;
  alias: string;
  label: string;
  keys: string;
  highlighted: boolean;
}

describe("parseSelectorMenu", () => {
  const cases: { name: string; frame: string; want: WantOption[] }[] = [
    {
      name: "live 2.1.251 capture, highlight on the deny row",
      frame: selectorTrustFrame,
      want: [
        {
          id: "0",
          alias: "deny",
          label: "No, exit",
          keys: "\r",
          highlighted: true,
        },
        {
          id: "1",
          alias: "proceed",
          label: "Yes, I trust this folder",
          keys: "\x1b[B\r",
          highlighted: false,
        },
      ],
    },
    {
      name: "highlight on the second row: the other choice needs an UP arrow",
      frame: selectorTrustFrameSecondRow,
      want: [
        {
          id: "0",
          alias: "deny",
          label: "No, exit",
          keys: "\x1b[A\r",
          highlighted: false,
        },
        {
          id: "1",
          alias: "proceed",
          label: "Yes, I trust this folder",
          keys: "\r",
          highlighted: true,
        },
      ],
    },
    {
      name: "bordered box: the left edge must not shift the label column",
      frame: selectorTrustFrameBoxed,
      want: [
        {
          id: "0",
          alias: "deny",
          label: "No, exit",
          keys: "\r",
          highlighted: true,
        },
        {
          id: "1",
          alias: "proceed",
          label: "Yes, I trust this folder",
          keys: "\x1b[B\r",
          highlighted: false,
        },
      ],
    },
    {
      name: "astral codepoint in a label: columns are code points, not UTF-16 units",
      frame: selectorTrustFrameAstral,
      want: [
        {
          id: "0",
          alias: "deny",
          label: "No, exit",
          keys: "\r",
          highlighted: true,
        },
        {
          id: "1",
          alias: "proceed",
          label: "Yes, I trust 📁repo",
          keys: "\x1b[B\r",
          highlighted: false,
        },
      ],
    },
  ];

  for (const tc of cases) {
    test(tc.name, () => {
      const opts = parseSelectorMenu(afterAnchor(tc.frame));
      expect(opts.length).toBe(tc.want.length);
      tc.want.forEach((w, i) => {
        const o = opts[i];
        expect(o.id).toBe(w.id);
        expect(o.alias).toBe(w.alias);
        expect(o.label).toBe(w.label);
        expect(dec.decode(o.keys)).toBe(w.keys);
        expect(o.highlighted === true).toBe(w.highlighted);
      });
    });
  }

  // The property the whole positional-keys design exists for: claude highlights
  // "No, exit", so a bare CR on the affirmative row would QUIT the CLI at
  // startup. Asserted separately from the table so it cannot be lost in a
  // fixture edit.
  test("never a bare CR for a non-highlighted row", () => {
    for (const frame of [
      selectorTrustFrame,
      selectorTrustFrameSecondRow,
      selectorTrustFrameBoxed,
    ]) {
      for (const o of parseSelectorMenu(afterAnchor(frame))) {
        const keys = dec.decode(o.keys);
        if (!o.highlighted) {
          expect(
            keys,
            `option ${o.label} is not highlighted but its keys are a bare CR — ` +
              `answering it would confirm whatever row claude has highlighted instead`,
          ).not.toBe("\r");
        } else {
          expect(keys).toBe("\r");
        }
      }
    }
  });

  // A row's keys must be a single contiguous sequence ending in CR.
  // Conversation.writeKeys passes the whole opt.keys to one writeStdin: "ESC [ B"
  // in one write parses as Down, but split across writes it is a lone Esc, which
  // CANCELS the dialog.
  test("arrows are one write: a pure arrow run plus CR", () => {
    for (const o of parseSelectorMenu(afterAnchor(selectorTrustFrame))) {
      const keys = dec.decode(o.keys);
      expect(keys.endsWith("\r")).toBe(true);
      const body = keys.slice(0, -1);
      expect(/^(?:\x1b\[B)*$|^(?:\x1b\[A)*$/.test(body)).toBe(true);
    }
  });

  const rejects: { name: string; after: string }[] = [
    {
      name: "no selector glyph at all",
      after: "\nSecurity guide\n  No, exit\n  Yes, I trust this folder\n",
    },
    {
      name: "a single row is not a choice (a stray composer glyph)",
      after:
        "\nSecurity guide\n ❯ No, exit\nEnter to confirm · Esc to cancel\n",
    },
    {
      name: "more rows than the cap: prose that happens to align",
      after: "\n ❯ row one\n" + "   filler row\n".repeat(9),
    },
    {
      name: "glyph with nothing after it",
      after: "\n ❯ \n   Yes, I trust this folder\n",
    },
  ];

  for (const tc of rejects) {
    test(`rejects: ${tc.name}`, () => {
      expect(parseSelectorMenu(tc.after)).toEqual([]);
    });
  }

  // The over-matching guard called out in the design: "Security guide" and the
  // workspace path sit next to the choice rows and would become spurious options
  // — with an empty alias, and worse, shifting the arrow offsets of every real
  // row below them.
  test("prose is not an option", () => {
    const opts = parseSelectorMenu(afterAnchor(selectorTrustFrame));
    for (const o of opts) {
      for (const prose of [
        "Security guide",
        "/private/tmp/trustrepo",
        "Enter to confirm",
        "Claude Code'll",
      ]) {
        expect(o.label).not.toContain(prose);
      }
      expect(o.alias).not.toBe("");
    }
  });
});

describe("DetectInputDetail states", () => {
  // The numbered frame, mirrored from input.test.ts, proving the numbered branch
  // still wins whenever it parses.
  const trustScreen = [
    "╭─────────────────────────────────────────────────╮",
    "│ Do you trust the files in this folder?            │",
    "│                                                   │",
    "│ /Users/oleh/Work/aether/harness-wrapper           │",
    "│                                                   │",
    "│ ❯ 1. Yes, proceed                                 │",
    "│   2. No, exit                                     │",
    "│                                                   │",
    "│ Enter to confirm · Esc to exit                    │",
    "╰─────────────────────────────────────────────────╯",
  ].join("\n");

  const cases: {
    name: string;
    text: string;
    want: claudecode.Detection;
    wantN?: number;
  }[] = [
    {
      name: "no anchor",
      text: "Claude Code\n\n❯ \n",
      want: claudecode.DetectNone,
    },
    {
      name: "anchor only, menu not painted yet",
      text: "Quick safety check: Is this a project you created or one you trust? …\n",
      want: claudecode.DetectPending,
    },
    {
      name: "anchor plus a choice-shaped line the block rules reject",
      text:
        "Quick safety check: Is this a project you created or one you trust? …\n" +
        "Security guide\n ❯ No, exit\nEnter to confirm · Esc to cancel\n",
      want: claudecode.DetectUnparseable,
    },
    {
      name: "the real 2.1.251 frame",
      text: selectorTrustFrame,
      want: claudecode.DetectOK,
      wantN: 2,
    },
    {
      name: "the numbered frame still parses as before",
      text: trustScreen,
      want: claudecode.DetectOK,
      wantN: 2,
    },
  ];

  for (const tc of cases) {
    test(tc.name, () => {
      const [req, det] = claudecode.DetectInputDetail(tc.text);
      expect(det).toBe(tc.want);
      if (tc.want !== claudecode.DetectOK) {
        expect(req).toBeNull();
        // DetectInput must map every non-ok state to null — that is the contract
        // src/oneshot and the InputRequested path rely on.
        expect(claudecode.DetectInput(tc.text)).toBeNull();
        return;
      }
      expect(req!.options!.length).toBe(tc.wantN);
    });
  }

  // A question dialog with no startup anchor must still route to DetectQuestion
  // and report ok — the fall-through this refactor must not regress.
  test("no startup anchor falls through to DetectQuestion", () => {
    const questionScreen = [
      "☐ Color",
      "",
      "What color should the button be?",
      "",
      "❯ 1. Red",
      "  2. Blue",
      "",
      "Enter to select · Esc to cancel",
    ].join("\n");
    const [req, det] = claudecode.DetectInputDetail(questionScreen);
    expect(det).toBe(claudecode.DetectOK);
    expect(req).not.toBeNull();
    expect(req!.kind).toBe("question");
  });

  // Moving the highlight must NOT mint a new request id. inputID hashes
  // kind + prompt + option LABELS only; if the highlight leaked into it, every
  // arrow keypress would look like a fresh dialog the policy answers all over
  // again. The KEYS must differ, though — that is the whole point.
  test("id is stable across highlight moves, keys are not", () => {
    const [a, detA] = claudecode.DetectInputDetail(selectorTrustFrame);
    const [b, detB] = claudecode.DetectInputDetail(selectorTrustFrameSecondRow);
    expect(detA).toBe(claudecode.DetectOK);
    expect(detB).toBe(claudecode.DetectOK);
    expect(a!.id).toBe(b!.id);
    const key = (r: InputOption[]) => dec.decode(r[1].keys);
    expect(key(a!.options!)).not.toBe(key(b!.options!));
  });
});
