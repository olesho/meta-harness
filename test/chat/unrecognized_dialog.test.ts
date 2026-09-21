// Fast-fail on a blocking dialog this build cannot parse — the TS mirror of Go's
// pkg/chat/unrecognized_dialog_test.go (harness-wrapper loom/PUPPET-247).
//
// After PUPPET-296 claudecode.DetectInputDetail reports DetectUnparseable for "the
// anchor is up, choice-shaped lines are painted, and no answerable option set could
// be built". Nothing consumed it, so the send path failed SAFELY (ready.ts is
// anchor-only, so the screen is never ready) but SLOWLY: an unreadable dialog can
// never be answered, never clears, and send() burned the whole deadline with nothing
// naming the cause. Now awaitPromptReady arms a second stabilizer beside the auth
// one and throws ErrUnrecognizedDialog once the state survives a re-check of the
// live screen.
//
// Reproduction status of each test, as of the fix (PUPPET-302):
//   1, 2, 4  FAIL before the fix (1 and 4 hang to the context deadline — that hang
//            IS the bug; 2 asserts the dwell bound that did not exist).
//   3, 5, 6  are PINS: they pass both before and after, and say so inline.

import { afterEach, describe, expect, test } from "vitest";

import { Context, isSentinel } from "../../src/internal/async/index.ts";
import {
  ErrUnrecognizedDialog,
  TurnStateComplete,
  type Conversation,
} from "../../src/chat/index.ts";
import { claudecode } from "../../src/turns/index.ts";
import {
  New,
  openFake,
  sendOneTurn,
  waitForTerminalTurn,
} from "./fakeharness.ts";
import type { Script, Step } from "./fakeharness.ts";

// The dwell before an unparseable dialog is believed. It mirrors
// `unrecognizedDialogStabilizeGap` in src/chat/conversation.ts, which aliases
// `authGateStabilizeGap` — both are module-private with no test-visibility
// precedent in this codebase, so the literal is repeated here rather than widening
// the public barrel for a test. If that constant changes, change this too.
const dwellMs = 2000;

const open = new Set<Conversation>();
async function openTracked(
  script: Script,
  overrides: Parameters<typeof openFake>[1] = {},
): Promise<Conversation> {
  const conv = await openFake(script, overrides);
  open.add(conv);
  return conv;
}
afterEach(async () => {
  for (const conv of open) {
    const { ctx } = Context.withDeadline(Context.background(), 2000);
    await conv.close(ctx);
  }
  open.clear();
});

/** Steps of a throwaway builder, so scripts can splice frames with custom delays. */
function stepsOf(build: (b: ReturnType<typeof New>) => unknown): Step[] {
  const b = New("claude-code");
  build(b);
  return b.Build().steps;
}

/** Resolves once the live screen satisfies `pred`, or rejects on timeout. */
async function waitForScreen(
  conv: Conversation,
  pred: (text: string) => boolean,
  timeoutMs = 5000,
): Promise<string> {
  const started = Date.now();
  for (;;) {
    const txt = conv.screenSnapshot().text;
    if (pred(txt)) return txt;
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for the expected screen");
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

const trustAnchorAlt = "Is this a project you created or one you trust?";

async function sendErr(conv: Conversation, ctx: Context, text: string) {
  const release = await conv.acquireControl(Context.background());
  try {
    await conv.send(ctx, text);
    return null;
  } catch (e) {
    return e;
  } finally {
    release();
  }
}

describe("unrecognized dialog on the send path (real pty + fake harness)", () => {
  // (1) The reproduction. Before the fix this hangs to the context deadline.
  test("send() on an unparseable dialog throws ErrUnrecognizedDialog", async () => {
    const conv = await openTracked(
      New("claude-code")
        .TrustPromptUnparseable(0)
        .StayAliveUntilStopped()
        .Build(),
    );

    // Precondition: the fixture really is DetectUnparseable. Dropping a sibling row
    // is the INTENDED way to reach that state, but it is menuSelector's
    // 2..8-row-block rule that decides — the test proves nothing if this fixture
    // merely reads as DetectPending or DetectNone.
    const painted = await waitForScreen(conv, (t) =>
      t.includes(trustAnchorAlt),
    );
    const [, det] = claudecode.DetectInputDetail(painted);
    expect(det).toBe(claudecode.DetectUnparseable);

    const { ctx, cancel } = Context.withDeadline(Context.background(), 15000);
    try {
      const err = await sendErr(conv, ctx, "hello");
      expect(err).not.toBeNull();
      expect(isSentinel(err as Error, ErrUnrecognizedDialog)).toBe(true);
    } finally {
      cancel();
    }
  });

  // (2) It fires on the DWELL, not the deadline. Both bounds matter: firing sooner
  // than the gap would mean a half-painted frame could trip it, and firing much
  // later would mean it is really the deadline doing the work.
  test("…and it fires on the dwell, not the send deadline", async () => {
    const conv = await openTracked(
      New("claude-code")
        .TrustPromptUnparseable(0)
        .StayAliveUntilStopped()
        .Build(),
    );
    await waitForScreen(conv, (t) => t.includes(trustAnchorAlt));

    const { ctx, cancel } = Context.withDeadline(Context.background(), 15000);
    try {
      const started = Date.now();
      const err = await sendErr(conv, ctx, "hello");
      const elapsed = Date.now() - started;
      expect(isSentinel(err as Error, ErrUnrecognizedDialog)).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(dwellMs);
      expect(elapsed).toBeLessThan(dwellMs + 4000);
    } finally {
      cancel();
    }
  });

  // (3) PIN — passes before and after. A PARSEABLE dialog is answerable, so the
  // pre-existing behaviour stands: keep waiting, never throw the new sentinel. The
  // deadline is deliberately LONGER than the dwell, so a stabilizer that wrongly
  // armed on DetectOK would be caught here rather than hidden by a short deadline.
  test("a parseable dialog keeps waiting (never ErrUnrecognizedDialog)", async () => {
    const conv = await openTracked(
      New("claude-code")
        .TrustPromptUnnumbered(0)
        .StayAliveUntilStopped()
        .Build(),
      // No inputPolicy: nothing answers the dialog.
    );
    const painted = await waitForScreen(conv, (t) =>
      t.includes(trustAnchorAlt),
    );
    const [, det] = claudecode.DetectInputDetail(painted);
    expect(det).toBe(claudecode.DetectOK);

    const { ctx, cancel } = Context.withDeadline(
      Context.background(),
      dwellMs + 1500,
    );
    try {
      const err = await sendErr(conv, ctx, "hello");
      // Either the ctx deadline or ErrInputPending (the prompt was surfaced to the
      // client, since no policy answered it) — both are correct. The load-bearing
      // claim is that it is NOT the new sentinel.
      expect(err).not.toBeNull();
      expect(isSentinel(err as Error, ErrUnrecognizedDialog)).toBe(false);
    } finally {
      cancel();
    }
  });

  // (4) The safety invariant: NOTHING is written to a dialog we cannot read. The
  // scenario's next step is an AwaitSubmit that must never match — if the send path
  // ever typed the prompt into the menu, the fake would advance to the Idle frame
  // and send() would succeed instead of throwing.
  test("nothing is written to the unparseable dialog", async () => {
    const script = New("claude-code").TrustPromptUnparseable(0).Build();
    script.steps.push(...stepsOf((b) => b.AwaitSubmit().Idle()));
    const conv = await openTracked(script);
    await waitForScreen(conv, (t) => t.includes(trustAnchorAlt));

    const { ctx, cancel } = Context.withDeadline(Context.background(), 15000);
    try {
      const err = await sendErr(conv, ctx, "SENTINELPROMPT");
      expect(isSentinel(err as Error, ErrUnrecognizedDialog)).toBe(true);
    } finally {
      cancel();
    }
    // The fake never got past AwaitSubmit, so the dialog is still on screen and the
    // prompt text never reached the harness.
    const txt = conv.screenSnapshot().text;
    expect(txt).toContain(trustAnchorAlt);
    expect(txt).not.toContain("SENTINELPROMPT");
  });

  // (5) The anti-false-positive test, and the one most likely to catch a missing
  // disarmDialog(): the dialog CLEARS during the dwell, so the send must succeed.
  test("a dialog that clears during the dwell does not throw", async () => {
    const script = New("claude-code").TrustPromptUnparseable(0).Build();
    // The ready composer, repainted well inside the dwell.
    const idle = stepsOf((b) => b.Idle())[0];
    script.steps.push({ frame: { ...idle.frame!, delay_ms: 800 } });
    script.steps.push(
      ...stepsOf((b) =>
        b
          .AwaitSubmit()
          .Working(30, "Thinking")
          .Reply(40, "CLEARED", "Synthesized", "5s"),
      ),
    );

    const conv = await openTracked(script);
    await sendOneTurn(conv, "hello");
    const turn = await waitForTerminalTurn(conv, 10000);
    expect(turn.state).toBe(TurnStateComplete);
    expect(turn.text).toContain("CLEARED");
  });

  // (6) PIN — passes before and after. claudeDialogState short-circuits on the
  // harness name, so a non-claude conversation is inert even with the literal trust
  // anchor sitting in its scrollback as ordinary prose.
  test("non-claude harness is inert on a screen carrying the trust anchor", async () => {
    const script: Script = {
      harness: "codex",
      session_id: "11111111-2222-3333-4444-555555555555",
      steps: [
        {
          frame: {
            delay_ms: 0,
            screen:
              "Codex\n\n" +
              "⏺ The claude trust dialog asks: " +
              trustAnchorAlt +
              "\n ❯ No, exit\n\n› \n\n  codex resume 11111111-2222-3333-4444-555555555555\n",
            echo: false,
          },
        },
        {
          wait_input: { until_regex: "\\r", capture: true, label: "submit-cr" },
        },
        { hold: {} },
      ],
    };
    const conv = await openTracked(script);

    const { ctx, cancel } = Context.withDeadline(
      Context.background(),
      dwellMs + 3000,
    );
    try {
      const err = await sendErr(conv, ctx, "hello");
      expect(err).toBeNull();
    } finally {
      cancel();
    }
  });
});

// (7) The claudeDialogState matrix. The method is private, so the four states are
// pinned at the source it delegates to (claudecode.DetectInputDetail) plus the
// behavioural tests above; the harness short-circuit is covered by (6).
describe("claudecode detection states the send-path gate keys off", () => {
  const anchor = " Is this a project you created or one you trust?";
  const state = (text: string): claudecode.Detection =>
    claudecode.DetectInputDetail(text)[1];

  test("no anchor → DetectNone", () => {
    expect(state("Claude Code\n\n❯ \n")).toBe(claudecode.DetectNone);
  });
  test("anchor, nothing choice-shaped yet → DetectPending", () => {
    expect(state("Claude Code\n\n" + anchor + "\n\n Loading…\n")).toBe(
      claudecode.DetectPending,
    );
  });
  test("anchor + a lone selector row → DetectUnparseable", () => {
    expect(
      state("Claude Code\n\n" + anchor + "\n\n ❯ No, exit\nEnter to confirm\n"),
    ).toBe(claudecode.DetectUnparseable);
  });
  test("anchor + a readable option set → DetectOK", () => {
    expect(
      state(
        "Claude Code\n\n" +
          anchor +
          "\n\n ❯ No, exit\n   Yes, I trust this folder\nEnter to confirm · Esc to cancel\n",
      ),
    ).toBe(claudecode.DetectOK);
  });
});
