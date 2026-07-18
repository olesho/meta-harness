// Port of pkg/harness/run_turn_test.go. Drives runTurn over a REAL fake-harness
// process on a REAL pty (via the existing test/chat/fakeharness.ts runnable),
// the same way the Go suite drives its compiled cmd/fakeharness binary.
//
// runTurn has no TurnConfig knobs for idleGap/markerGap/echoBound (Go's
// RunTurn doesn't expose them either), so these tests pay the real production
// timing defaults — generous per-test timeouts absorb that, mirroring the Go
// suite's own 15s context budgets.

import { afterEach, describe, expect, test } from "vitest";

import { Context, isSentinel } from "../../src/internal/async/index.ts";
import {
  TurnStateComplete,
  TurnStateErrored,
  type Conversation,
} from "../../src/chat/index.ts";
import {
  fakeHarnessBin,
  fakeLaunchEnv,
  New,
  PromptRef,
  sendOneTurn,
  waitForTerminalTurn,
} from "../chat/fakeharness.ts";
import {
  runTurn,
  ErrTurnErrored,
  RunTurnError,
  type TurnResult,
} from "../../src/harness/internal/runTurn.ts";

const open = new Set<Conversation>();

afterEach(async () => {
  for (const conv of open) {
    const { ctx } = Context.withDeadline(Context.background(), 2000);
    await conv.close(ctx);
  }
  open.clear();
});

describe("runTurn (real pty + fake harness)", () => {
  test("claude-style turn stops after completion", async () => {
    // The fake paints this as its "claude --resume <id>" hint, but the
    // claude-code adapter mints its OWN `--session-id` uuid at launch
    // (SessionInitializer) and that is authoritative — the resume hint is a
    // losing backstop. See test/chat/claudecode_session.test.ts ("the fake's
    // resume hint does not clobber the seeded id"). This is an intentional
    // divergence from the Go reference, which had no session initializer and so
    // adopted the hint verbatim.
    const resumeHintID = "123e4567-e89b-12d3-a456-426614174000";
    const script = New("claude-code")
      .Session(resumeHintID)
      .Idle()
      .AwaitSubmit()
      .Working(30, "Working")
      .Reply(40, "assistant reply: " + PromptRef(), "Baked", "1s")
      .StayAliveUntilStopped()
      .Build();

    const result = await runTurn(undefined, {
      harness: "claude",
      binaryPath: fakeHarnessBin,
      env: fakeLaunchEnv(script),
      prompt: "ship the turn API",
      exitAfterTurn: true,
    });

    expect(result.turn.state).toBe(TurnStateComplete);
    // A freshly-minted --session-id uuid, NOT the scripted resume hint.
    expect(result.session.harnessSessionID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result.session.harnessSessionID).not.toBe(resumeHintID);
    expect(result.history.length).toBeGreaterThanOrEqual(2);
    expect(result.conversation).toBeUndefined();
    expect(result.processStoppedAfterTurn).toBe(true);
  }, 20000);

  test("keeps the conversation alive when exitAfterTurn is false", async () => {
    const script = New("claude-code")
      .Idle()
      .AwaitSubmit()
      .Working(30, "Working")
      .Reply(40, "assistant reply one", "Baked", "1s")
      .AwaitSubmit()
      .Working(30, "Working")
      .Reply(40, "assistant reply two", "Baked", "2s")
      .StayAliveUntilStopped()
      .Build();

    const result = await runTurn(undefined, {
      harness: "claude",
      binaryPath: fakeHarnessBin,
      env: fakeLaunchEnv(script),
      prompt: "first turn",
      exitAfterTurn: false,
    });

    expect(result.conversation).toBeDefined();
    expect(result.processStoppedAfterTurn).toBe(false);
    const conv = result.conversation;
    if (!conv) throw new Error("expected conversation to be defined");
    open.add(conv);

    await sendOneTurn(conv, "second turn");
    const turn = await waitForTerminalTurn(conv, 8000);
    expect(turn.state).toBe(TurnStateComplete);
  }, 20000);

  test("throws ErrTurnErrored when the harness exits mid-turn", async () => {
    const script = New("claude-code").Idle().AwaitSubmit().Exit(2).Build();

    let caught: unknown;
    try {
      await runTurn(undefined, {
        harness: "claude",
        binaryPath: fakeHarnessBin,
        env: fakeLaunchEnv(script),
        prompt: "fail this turn",
      });
      expect.fail("expected runTurn to throw ErrTurnErrored");
    } catch (err) {
      caught = err;
    }

    expect(isSentinel(caught, ErrTurnErrored)).toBe(true);
    expect(caught).toBeInstanceOf(RunTurnError);
    const result: TurnResult = (caught as RunTurnError).result;
    expect(result.turn.state).toBe(TurnStateErrored);
  }, 15000);
});
