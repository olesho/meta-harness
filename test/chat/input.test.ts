// Port of pkg/chat/input_test.go — policy/handler resolution, surfacing, Answer.
import { describe, expect, test } from "vitest"
import { Context } from "../../src/internal/async/index.ts"
import {
  ErrNoControl,
  ErrNoInputPending,
  ErrStaleInputRequest,
  ErrUnknownOption,
  isSentinel,
} from "../../src/chat/errors.ts"
import {
  EventInputRequest,
  EventInputResolved,
  DispositionAnswer,
  DispositionDeny,
} from "../../src/chat/types.ts"
import { KeyRecorder, trustRequest, newTestConv } from "./helpers.ts"

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
    return undefined
  } catch (e) {
    return e
  }
}

describe("handleInputRequested", () => {
  test("policy answer auto-resolves server-side, nothing surfaced", () => {
    const rec = new KeyRecorder()
    const c = newTestConv(
      {
        harness: "claude-code",
        inputPolicy: { byKind: { trust_prompt: { kind: DispositionAnswer, optionID: "proceed" } } },
      },
      rec,
    )
    c.handleInputRequested(trustRequest())
    expect(rec.text()).toBe("1\r")
    expect(c.inputSurfaced).toBe(false)
    expect(c.currentInput).not.toBeNull()
    expect(c.eventCh.tryReceive().ok).toBe(false)
  })

  test("policy deny picks the deny-aliased option", () => {
    const rec = new KeyRecorder()
    const c = newTestConv(
      { harness: "claude-code", inputPolicy: { default: DispositionDeny } },
      rec,
    )
    c.handleInputRequested(trustRequest())
    expect(rec.text()).toBe("2\r")
  })

  test("in-process handler resolves when policy says ask", () => {
    const rec = new KeyRecorder()
    const c = newTestConv(
      {
        harness: "claude-code",
        onInputRequest: (r) =>
          r.kind === "trust_prompt" ? [{ optionID: "deny" }, true] : [{}, false],
      },
      rec,
    )
    c.handleInputRequested(trustRequest())
    expect(rec.text()).toBe("2\r")
    expect(c.inputSurfaced).toBe(false)
  })

  test("no policy/handler surfaces to client and marks awaiting", () => {
    const rec = new KeyRecorder()
    const c = newTestConv({ harness: "claude-code" }, rec)
    c.handleInputRequested(trustRequest())
    expect(rec.data.length).toBe(0)
    expect(c.inputAwaitingClient()).toBe(true)
    const { value, ok } = c.eventCh.tryReceive()
    expect(ok).toBe(true)
    expect(value!.type).toBe(EventInputRequest)
    expect(value!.input!.id).toBe("req-1")
    expect(value!.input!.options!.length).toBe(2)
    expect(value!.input!.options![0]!.label).toBe("Yes, proceed")
  })
})

describe("Answer", () => {
  test("precondition + resolution flow", async () => {
    const rec = new KeyRecorder()
    const c = newTestConv({ harness: "claude-code" }, rec)

    expect(isSentinel(await caught(c.answer(Context.background(), "req-1", { optionID: "proceed" })), ErrNoControl)).toBe(true)

    const release = await c.queue.acquire(Context.background())
    try {
      expect(isSentinel(await caught(c.answer(Context.background(), "", { optionID: "proceed" })), ErrNoInputPending)).toBe(true)

      c.handleInputRequested(trustRequest())

      expect(isSentinel(await caught(c.answer(Context.background(), "wrong-id", { optionID: "proceed" })), ErrStaleInputRequest)).toBe(true)
      expect(isSentinel(await caught(c.answer(Context.background(), "req-1", { optionID: "nope" })), ErrUnknownOption)).toBe(true)
      await c.answer(Context.background(), "req-1", { optionID: "proceed" })
      expect(rec.text()).toBe("1\r")
    } finally {
      release()
    }
  })
})

describe("handleInputResolved", () => {
  test("clears pending and notifies", () => {
    const rec = new KeyRecorder()
    const c = newTestConv({ harness: "claude-code" }, rec)
    c.handleInputRequested(trustRequest())
    expect(c.eventCh.tryReceive().ok).toBe(true) // drain the surfaced request

    c.handleInputResolved({ id: "req-1", kind: "", prompt: "" })
    expect(c.currentInput).toBeNull()
    expect(c.inputAwaitingClient()).toBe(false)
    const { value, ok } = c.eventCh.tryReceive()
    expect(ok).toBe(true)
    expect(value!.type).toBe(EventInputResolved)
  })
})
