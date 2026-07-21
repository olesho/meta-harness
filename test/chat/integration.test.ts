// Port of pkg/chat/integration_test.go. These tests drive a REAL fake-harness
// process over a REAL pty through the public Open/Send/Events API. They assert
// the version-independent contract — turns complete, the submitted prompt
// round-trips into the reply verbatim, and a mid-turn marker on a non-busy frame
// does not truncate — rather than any specific glyph.

import { afterEach, describe, expect, test } from "vitest";

import { Context } from "../../src/internal/async/index.ts";
import { TurnStateComplete, type Conversation } from "../../src/chat/index.ts";
import {
  New,
  PromptRef,
  openFake,
  sendOneTurn,
  waitForTerminalTurn,
} from "./fakeharness.ts";

const open = new Set<Conversation>();

async function openTracked(
  script: Parameters<typeof openFake>[0],
): Promise<Conversation> {
  const conv = await openFake(script);
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

describe("chat integration (real pty + fake harness)", () => {
  // Regression-locks 3eda8a8 + dfc5aae end to end: an end-of-turn marker fires
  // on a frame where the busy signal has flickered off (a sub-agent redraw),
  // MID-turn, then more work follows before settling. The fix must wait for the
  // settled prompt and return the real reply with the submitted sentinel intact.
  test("SubAgentFlicker does not truncate", async () => {
    const sentinel = "READY-7Q3X9";
    const script = New("claude-code")
      .Idle()
      .AwaitSubmit()
      .Working(30, "Cerebrating")
      .MarkerFlicker(30, "Pondered", "3s", "drafting")
      .Working(30, "Exploring")
      .Reply(40, "Final answer: " + PromptRef(), "Synthesized", "12s")
      .Build();

    const conv = await openTracked(script);
    await sendOneTurn(conv, "Reply with exactly: " + sentinel);

    const turn = await waitForTerminalTurn(conv, 8000);
    expect(turn.state).toBe(TurnStateComplete);
    expect(turn.text).toContain(sentinel);
    expect(turn.text).not.toContain("Pondered");
    expect(turn.text).not.toContain("drafting");
    expect(turn.reason).toContain("marker confirmed");
  });

  // Each Send yields exactly one completed assistant turn whose reply carries
  // that turn's own sentinel; the previous turn's sentinel must not leak.
  test("MultiTurn recognizes independent turn boundaries", async () => {
    const sentinels = ["ALPHA-111", "BRAVO-222"];
    let b = New("claude-code").Idle();
    for (const _ of sentinels) {
      b = b
        .AwaitSubmit()
        .Working(30, "Working")
        .Reply(40, "Echo: " + PromptRef(), "Synthesized", "5s");
    }
    const conv = await openTracked(b.Build());

    for (let i = 0; i < sentinels.length; i++) {
      await sendOneTurn(conv, "Say " + sentinels[i]);
      const turn = await waitForTerminalTurn(conv, 8000);
      expect(turn.state).toBe(TurnStateComplete);
      expect(turn.text).toContain(sentinels[i]);
      if (i > 0) expect(turn.text).not.toContain(sentinels[i - 1]);
    }
  });

  // A turn that NEVER prints an end-of-turn marker completes via the idle
  // fallback, which requires prompt-readiness — proving the safety net works.
  test("NoMarkerFallback completes via idle path", async () => {
    const sentinel = "FALLBACK-42";
    const script = New("claude-code")
      .Idle()
      .AwaitSubmit()
      .Working(30, "Thinking")
      .Working(30, "Thinking")
      .SettleIdle(40, "Done: " + PromptRef())
      .Build();

    const conv = await openTracked(script);
    await sendOneTurn(conv, "Answer with " + sentinel);

    const turn = await waitForTerminalTurn(conv, 8000);
    expect(turn.state).toBe(TurnStateComplete);
    expect(turn.text).toContain(sentinel);
    expect(turn.reason).toContain("fallback");
  });

  // pi has no end-of-turn marker and no kitty protocol: submitted with a bare CR,
  // defers while the "Working..." spinner is up, completes via the busy-aware
  // idle fallback once the settled status line returns.
  test("pi idle fallback", async () => {
    const sentinel = "PI-OK-88";
    const script = New("pi")
      .PiIdle()
      .AwaitSubmitCR()
      .PiWorking(30)
      .PiWorking(30)
      .PiReply(40, "pi reply: " + PromptRef())
      .Build();

    const conv = await openTracked(script);
    await sendOneTurn(conv, "Reply with " + sentinel);

    const turn = await waitForTerminalTurn(conv, 8000);
    expect(turn.state).toBe(TurnStateComplete);
    expect(turn.text).toContain(sentinel);
    expect(turn.reason).toContain("fallback");
    expect(turn.reason).toContain("pi:");
  });

  test("pi multi-turn", async () => {
    const sentinels = ["PI-AA", "PI-BB"];
    let b = New("pi").PiIdle();
    for (const _ of sentinels) {
      b = b
        .AwaitSubmitCR()
        .PiWorking(20)
        .PiReply(30, "echo: " + PromptRef());
    }
    const conv = await openTracked(b.Build());

    for (let i = 0; i < sentinels.length; i++) {
      await sendOneTurn(conv, "Say " + sentinels[i]);
      const turn = await waitForTerminalTurn(conv, 8000);
      expect(turn.state).toBe(TurnStateComplete);
      expect(turn.text).toContain(sentinels[i]);
      if (i > 0) expect(turn.text).not.toContain(sentinels[i - 1]);
    }
  });

  // codex completes the instant a fresh "Token usage: …" footer appears (no
  // quiescence dance); the submitted prompt round-trips into the reply.
  test("codex Token-usage completes turn", async () => {
    const sessionID = "abcdef01-2345-6789-abcd-ef0123456789";
    const sentinel = "CODEX-OK-55";
    const script = New("codex")
      .Session(sessionID)
      .Idle()
      // Absorb the startup /status prime (Open writes it before returning), then
      // return to idle so the real turn drives the assertions below.
      .AwaitSubmit()
      .Idle()
      .AwaitSubmit()
      .CodexWorking(30, "Thinking")
      .CodexReply(40, "codex reply: " + PromptRef())
      .Build();

    const conv = await openTracked(script);
    await sendOneTurn(conv, "Reply with " + sentinel);

    const turn = await waitForTerminalTurn(conv, 8000);
    expect(turn.state).toBe(TurnStateComplete);
    expect(turn.text).toContain(sentinel);
    expect(turn.reason).toContain("Token usage");
    expect(conv.sessionID()).not.toBe("");
  });

  test("codex multi-turn completes on each Token-usage footer", async () => {
    const sentinels = ["CDX-AA", "CDX-BB"];
    // Absorb the startup /status prime, then drive the real turns.
    let b = New("codex").Idle().AwaitSubmit().Idle();
    for (const _ of sentinels) {
      b = b
        .AwaitSubmit()
        .CodexWorking(20, "Thinking")
        .CodexReply(30, "echo: " + PromptRef());
    }
    const conv = await openTracked(b.Build());

    for (let i = 0; i < sentinels.length; i++) {
      await sendOneTurn(conv, "Say " + sentinels[i]);
      const turn = await waitForTerminalTurn(conv, 8000);
      expect(turn.state).toBe(TurnStateComplete);
      expect(turn.text).toContain(sentinels[i]);
    }
  });
});
