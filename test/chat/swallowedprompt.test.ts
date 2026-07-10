// META-HARNESS-24 regression: on live Claude Code 2.1.201 a submitted prompt
// was silently dropped — the TUI just repainted its untouched ready screen —
// yet the turn completed as a success whose "reply" was the raw ready screen.
// A swallowed prompt must end the turn errored, never completed, and the raw
// ready screen must never be persisted as assistant text.

import { afterEach, describe, expect, test } from "vitest"

import { Context } from "../../src/internal/async/index.ts"
import { TurnStateErrored, type Conversation } from "../../src/chat/index.ts"
import { New, openFake, sendOneTurn, waitForTerminalTurn } from "./fakeharness.ts"

const open = new Set<Conversation>()

async function openTracked(script: Parameters<typeof openFake>[0]): Promise<Conversation> {
  const conv = await openFake(script)
  open.add(conv)
  return conv
}

afterEach(async () => {
  for (const conv of open) {
    const { ctx } = Context.withDeadline(Context.background(), 2000)
    await conv.close(ctx)
  }
  open.clear()
})

describe("swallowed prompt (real pty + fake harness)", () => {
  // The fake accepts the submit bytes but produces no turn: no busy frame, no
  // "⏺" reply, no end-of-turn marker — it repaints the ready screen and holds.
  // The idle-completion fallback must refuse to call this a successful reply.
  test("unchanged ready screen after send errors the turn", async () => {
    const script = New("claude-code")
      .Idle()
      .AwaitSubmit()
      .Idle() // the swallow: repaint the untouched ready screen
      .StayAliveUntilStopped()
      .Build()

    const conv = await openTracked(script)
    await sendOneTurn(conv, "This prompt will be swallowed")

    const turn = await waitForTerminalTurn(conv, 4000)
    expect(turn.state).toBe(TurnStateErrored)
    expect(turn.reason).toContain("prompt not accepted")
    // The raw ready screen must not leak into the persisted reply text.
    expect(turn.text).toBe("")
  })

  // META-HARNESS-21, the codex 0.142.5 shape: the submit is consumed as part of
  // a paste and the prompt stays sitting in the composer ("› <text>"). Codex
  // writes its rollout lazily at first submitted message, so a false-success
  // here surfaces later as a confusing transcript-read miss — the turn must
  // error instead. The first AwaitSubmit absorbs the startup /status prime.
  test("codex: prompt left sitting in the composer errors the turn", async () => {
    const script = New("codex")
      .Idle()
      .AwaitSubmit() // the session-id primer's "/status" + CSI 13 u
      .Idle()
      .AwaitSubmit() // the real send
      .CodexSwallowed(0)
      .StayAliveUntilStopped()
      .Build()

    const conv = await openTracked(script)
    await sendOneTurn(conv, "reply with just: ok")

    // 8000 (not 4000): a genuine codex swallow now pays the transcript
    // override's one-shot ~500ms flush-lag retry before erroring.
    const turn = await waitForTerminalTurn(conv, 8000)
    expect(turn.state).toBe(TurnStateErrored)
    expect(turn.reason).toContain("prompt not accepted")
    expect(turn.text).toBe("")
  })
})
