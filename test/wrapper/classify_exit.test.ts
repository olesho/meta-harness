// Reviewer finding #5: a context DEADLINE must be distinguishable from an
// explicit/abort CANCEL so the orche side can synthesize exit-124 only for a
// real timeout. classifyExit carries that distinction in the reason string via
// the context's cancellation cause.

import { describe, expect, test } from "bun:test"
import { classifyExit, StatusInterrupted, StatusIdle } from "../../src/wrapper/index.ts"
import { ctxCanceled, ctxDeadlineExceeded } from "../../src/async/index.ts"

describe("classifyExit — deadline vs cancel", () => {
  const exit = { exitCode: -1, signal: 15 }

  test("a deadline cause yields reason 'context deadline exceeded'", () => {
    const ce = classifyExit(exit, true, ctxDeadlineExceeded)
    expect(ce.status).toBe(StatusInterrupted)
    expect(ce.reason).toBe("context deadline exceeded")
  })

  test("an explicit cancel cause yields reason 'context cancelled'", () => {
    const ce = classifyExit(exit, true, ctxCanceled)
    expect(ce.status).toBe(StatusInterrupted)
    expect(ce.reason).toBe("context cancelled")
  })

  test("no cause (back-compat) defaults to 'context cancelled'", () => {
    const ce = classifyExit(exit, true)
    expect(ce.reason).toBe("context cancelled")
  })

  test("an unrelated cause is treated as a plain cancel", () => {
    const ce = classifyExit(exit, true, new Error("something else"))
    expect(ce.reason).toBe("context cancelled")
  })

  test("a clean, non-cancelled exit is idle with no reason", () => {
    const ce = classifyExit({ exitCode: 0, signal: 0 }, false)
    expect(ce.status).toBe(StatusIdle)
    expect(ce.reason).toBe("")
  })
})
