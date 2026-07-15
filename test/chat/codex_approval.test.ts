// Chat-layer handling of a genuine Codex approval prompt (META-HARNESS-46).
//
// The never-auto-dismiss half is pinned by codex_dismiss.test.ts ("never touches
// real approval prompts in either mode"). This covers the rest of the round trip:
// the prompt surfaces to the client, blocks idle turn completion while it is up,
// and Conversation.answer resolves it by alias.

import { describe, expect, test } from "vitest"
import { Context } from "../../src/internal/async/index.ts"
import { EventInputRequest } from "../../src/chat/types.ts"
import { DispositionDeny, RoleAssistant, TurnStatePending } from "../../src/chat/types.ts"
import type { Turn } from "../../src/chat/types.ts"
import { newScreen, type Screen } from "../../src/screen/index.ts"
import { codex } from "../../src/turns/index.ts"
import type { InputRequest as TurnsInputRequest } from "../../src/turns/index.ts"
import { KeyRecorder, newIdleTestConv, newTestConv, enc } from "./helpers.ts"

/**
 * The request DetectInput builds from the live 0.144.4 shell-command dialog
 * (test/corpus/codex/approval-command) — the turns-level tests pin that this is
 * the real parsed shape.
 */
function approvalRequest(): TurnsInputRequest {
  return {
    id: "ap-cmd-1",
    kind: codex.KindApproval,
    prompt: "Would you like to run the following command?",
    options: [
      { id: "1", alias: "proceed", label: "Yes, proceed (y)", keys: enc.encode("1\r"), highlighted: true },
      { id: "2", alias: "proceed", label: "Yes, and don't ask again (p)", keys: enc.encode("2\r") },
      { id: "3", alias: "deny", label: "No, and tell Codex what to do differently (esc)", keys: enc.encode("3\r") },
    ],
  }
}

/** The bare Yes/No shape the pinned contract fixture uses. */
function bareYesNoRequest(): TurnsInputRequest {
  return {
    id: "ap-bare-1",
    kind: codex.KindApproval,
    prompt: "Would you like to make the following edits?",
    options: [
      { id: "1", alias: "proceed", label: "Yes", keys: enc.encode("1\r"), highlighted: true },
      { id: "2", alias: "deny", label: "No", keys: enc.encode("2\r") },
    ],
  }
}

describe("codex approval prompt surfacing", () => {
  test("surfaces to the client with selectable options and awaits an answer", () => {
    const rec = new KeyRecorder()
    const c = newTestConv({ harness: "codex" }, rec)
    c.handleInputRequested(approvalRequest())

    expect(rec.data.length, "an approval prompt must never be auto-answered").toBe(0)
    expect(c.inputAwaitingClient()).toBe(true)

    const { value, ok } = c.eventCh.tryReceive()
    expect(ok).toBe(true)
    expect(value!.type).toBe(EventInputRequest)
    expect(value!.input!.kind).toBe("approval_prompt")
    expect(value!.input!.prompt).toBe("Would you like to run the following command?")
    expect(value!.input!.options!.map((o) => o.alias)).toEqual(["proceed", "proceed", "deny"])
    expect(value!.input!.options![0]!.label).toBe("Yes, proceed (y)")
  })

  test("the client-facing request carries no server-side keys or highlight flag", () => {
    const rec = new KeyRecorder()
    const c = newTestConv({ harness: "codex" }, rec)
    c.handleInputRequested(approvalRequest())
    const opt = c.eventCh.tryReceive().value!.input!.options![0]! as unknown as Record<
      string,
      unknown
    >
    expect(Object.keys(opt).sort()).toEqual(["alias", "id", "label"])
  })

  test("a deny policy resolves via the deny-aliased option", () => {
    // findOptionByAlias(req, "deny") — this is why aliasForLabel must map the
    // dialog's "No, …" row to deny rather than leaving it "".
    const rec = new KeyRecorder()
    const c = newTestConv({ harness: "codex", inputPolicy: { default: DispositionDeny } }, rec)
    c.handleInputRequested(approvalRequest())
    expect(rec.text()).toBe("3\r")
  })

  test("a deny policy works on a bare 'No' label", () => {
    const rec = new KeyRecorder()
    const c = newTestConv({ harness: "codex", inputPolicy: { default: DispositionDeny } }, rec)
    c.handleInputRequested(bareYesNoRequest())
    expect(rec.text()).toBe("2\r")
  })
})

describe("Conversation.answer on a codex approval prompt", () => {
  test("{optionID:'proceed'} resolves by alias and writes that option's keys", async () => {
    const rec = new KeyRecorder()
    const c = newTestConv({ harness: "codex" }, rec)
    const release = await c.queue.acquire(Context.background())
    try {
      c.handleInputRequested(approvalRequest())
      expect(c.inputAwaitingClient()).toBe(true)

      await c.answer(Context.background(), "ap-cmd-1", { optionID: "proceed" })
      // Alias resolution picks the first proceed-aliased row — the highlighted
      // "Yes, proceed (y)", not the "don't ask again" variant.
      expect(rec.text()).toBe("1\r")
    } finally {
      release()
    }
  })

  test("{optionID:'deny'} writes the deny option's keys", async () => {
    const rec = new KeyRecorder()
    const c = newTestConv({ harness: "codex" }, rec)
    const release = await c.queue.acquire(Context.background())
    try {
      c.handleInputRequested(approvalRequest())
      await c.answer(Context.background(), "ap-cmd-1", { optionID: "deny" })
      expect(rec.text()).toBe("3\r")
    } finally {
      release()
    }
  })

  test("answering a bare Yes/No dialog by alias", async () => {
    const rec = new KeyRecorder()
    const c = newTestConv({ harness: "codex" }, rec)
    const release = await c.queue.acquire(Context.background())
    try {
      c.handleInputRequested(bareYesNoRequest())
      await c.answer(Context.background(), "ap-bare-1", { optionID: "proceed" })
      expect(rec.text()).toBe("1\r")
    } finally {
      release()
    }
  })
})

describe("codex approval prompt blocks turn completion", () => {
  // An assistant turn that started long enough ago that the idle gap has elapsed,
  // so maybeIdleComplete is otherwise free to complete it.
  function inFlightTurn(): Turn {
    return {
      id: "turn-1",
      sessionID: "sess-1",
      role: RoleAssistant,
      state: TurnStatePending,
      text: "",
      reason: "",
      startedAt: new Date(Date.now() - 60_000),
      completedAt: new Date(0),
      httpCode: 0,
      retryAfter: 0,
    }
  }

  /** A screen sitting at the idle codex composer — otherwise idle-completable. */
  async function readyScreen(): Promise<Screen> {
    const scr = newScreen(80, 24)
    await scr.write(new TextEncoder().encode("\x1b[H\x1b[2J• Ran it\r\n\r\n› \r\n"))
    return scr
  }

  test("maybeIdleComplete does not complete the turn while the prompt is up", async () => {
    const rec = new KeyRecorder()
    const c = newIdleTestConv({ harness: "codex" }, rec, await readyScreen())
    c.currentTurn = inFlightTurn()

    c.handleInputRequested(approvalRequest())
    expect(c.inputAwaitingClient()).toBe(true)

    await c.maybeIdleComplete()
    expect(c.currentTurn, "the turn completed while the approval dialog was up").not.toBeNull()
    expect(c.currentTurn!.id).toBe("turn-1")
  })

  test("the same turn idle-completes once the prompt is resolved", async () => {
    // The control: same turn, same ready screen, only the pending input differs.
    // Without this, the test above could be passing on some unrelated bail-out.
    const rec = new KeyRecorder()
    const c = newIdleTestConv({ harness: "codex" }, rec, await readyScreen())
    c.currentTurn = inFlightTurn()

    c.handleInputRequested(approvalRequest())
    c.handleInputResolved(approvalRequest())
    expect(c.inputAwaitingClient()).toBe(false)

    await c.maybeIdleComplete()
    expect(c.currentTurn, "turn should have idle-completed once resolved").toBeNull()
  })
})
