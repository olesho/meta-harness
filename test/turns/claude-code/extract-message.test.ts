// Port of pkg/turns/harness/claudecode/extract_message_test.go.

import { describe, expect, test } from "vitest";
import * as claudecode from "../../../src/turns/harness/claudecode.ts";
import { textSnap } from "../corpus.ts";

const oneShotScreen = `╭─── Claude Code v2.1.181 ───────────────────────────────────╮
│ Welcome back Oleh!                                         │
╰────────────────────────────────────────────────────────────╯

❯ Reply with exactly the word PONG and nothing else.

⏺ PONG

✻ Cooked for 4s

────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;

const toolThenReplyScreen = `❯ Create result.txt then say DONE.

⏺ Write(result.txt)
  ⎿  Wrote 1 line to result.txt

⏺ DONE

✻ Brewed for 6s

────────────────────────────────────────────────────────────
❯
`;

const multiLineScreen = `❯ summarize

⏺ Here is the summary:
  - point one
  - point two

✻ Pondered for 2s

────────────────────────────────────────────────────────────
❯
`;

const staleThenFreshScreen = `⏺ Old answer from a previous turn

✻ Cooked for 9s

❯ new question

⏺ Fresh answer

✻ Brewed for 1s

────────────────────────────────────────────────────────────
❯
`;

describe("claude-code extract message", () => {
  test("one-shot reply", () => {
    const [got, ok] = claudecode.New().extractMessage(textSnap(oneShotScreen));
    expect(ok).toBe(true);
    expect(got).toBe("PONG");
  });

  test("skips tool call, takes final message", () => {
    const [got, ok] = claudecode
      .New()
      .extractMessage(textSnap(toolThenReplyScreen));
    expect(ok).toBe(true);
    expect(got).toBe("DONE");
  });

  test("multi-line dedented", () => {
    const [got, ok] = claudecode
      .New()
      .extractMessage(textSnap(multiLineScreen));
    expect(ok).toBe(true);
    expect(got).toBe("Here is the summary:\n- point one\n- point two");
  });

  test("ignores stale prior turn", () => {
    const [got, ok] = claudecode
      .New()
      .extractMessage(textSnap(staleThenFreshScreen));
    expect(ok).toBe(true);
    expect(got).toBe("Fresh answer");
  });

  test("no bullet returns false", () => {
    const [, ok] = claudecode
      .New()
      .extractMessage(textSnap("just a banner\n❯\n"));
    expect(ok).toBe(false);
  });

  test("QuitSequence", () => {
    const q = claudecode.New().quitSequence();
    expect(new TextDecoder().decode(q)).toBe("/quit\x1b[13u");
  });

  test("ExtractSessionIDFromLine", () => {
    const a = claudecode.New();
    const id = "74ca2184-c064-492c-88dc-c79c128de13e";
    const cases: {
      name: string;
      line: string;
      want: string;
      wantOK: boolean;
    }[] = [
      { name: "plain", line: "claude --resume " + id, want: id, wantOK: true },
      {
        name: "ansi-and-cr",
        line: "  claude --resume " + id + "\x1b[22m\r",
        want: id,
        wantOK: true,
      },
      {
        name: "with-prose",
        line: "Resume this conversation with: claude --resume " + id + " later",
        want: id,
        wantOK: true,
      },
      { name: "no-hint", line: "✻ Baked for 5s", want: "", wantOK: false },
      { name: "empty", line: "", want: "", wantOK: false },
      {
        name: "bad-uuid",
        line: "claude --resume not-a-uuid",
        want: "",
        wantOK: false,
      },
    ];
    for (const tc of cases) {
      const [got, ok] = a.extractSessionIDFromLine(tc.line);
      expect(ok).toBe(tc.wantOK);
      expect(got).toBe(tc.want);
    }
  });
});
