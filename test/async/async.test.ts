// Behavioral tests for the public `meta-harness/async` seam: the Context
// re-export and the fromAbortSignal adapter the orchestrator uses to drive cancellation.

import { describe, expect, test } from "bun:test"
import {
  Context,
  ctxCanceled,
  ctxDeadlineExceeded,
  fromAbortSignal,
} from "../../src/async/index.ts"

describe("meta-harness/async — Context re-export", () => {
  test("background() is never cancelled", () => {
    const ctx = Context.background()
    expect(ctx.isDone()).toBe(false)
    expect(ctx.err()).toBeUndefined()
  })

  test("withCancel cause is ctxCanceled", async () => {
    const { ctx, cancel } = Context.withCancel(Context.background())
    cancel()
    await ctx.done()
    expect(ctx.err()).toBe(ctxCanceled)
  })

  test("withDeadline cause is ctxDeadlineExceeded", async () => {
    const { ctx } = Context.withDeadline(Context.background(), 5)
    await ctx.done()
    expect(ctx.err()).toBe(ctxDeadlineExceeded)
  })

  test("the two cause sentinels are distinct", () => {
    expect(ctxCanceled).not.toBe(ctxDeadlineExceeded)
  })
})

describe("fromAbortSignal", () => {
  test("returns a real Context (usable by send/acquireControl)", () => {
    const ctx = fromAbortSignal(new AbortController().signal)
    expect(ctx).toBeInstanceOf(Context)
  })

  test("aborting the signal cancels with ctxCanceled", async () => {
    const ac = new AbortController()
    const ctx = fromAbortSignal(ac.signal)
    expect(ctx.isDone()).toBe(false)
    ac.abort()
    await ctx.done()
    expect(ctx.err()).toBe(ctxCanceled)
  })

  test("an already-aborted signal yields an already-cancelled Context", async () => {
    const ac = new AbortController()
    ac.abort()
    const ctx = fromAbortSignal(ac.signal)
    expect(ctx.isDone()).toBe(true)
    await ctx.done()
    expect(ctx.err()).toBe(ctxCanceled)
  })

  test("a positive deadline expires with ctxDeadlineExceeded", async () => {
    const ctx = fromAbortSignal(new AbortController().signal, 5)
    await ctx.done()
    expect(ctx.err()).toBe(ctxDeadlineExceeded)
  })

  test("abort beats a not-yet-elapsed deadline (cause = ctxCanceled)", async () => {
    const ac = new AbortController()
    const ctx = fromAbortSignal(ac.signal, 10_000)
    ac.abort()
    await ctx.done()
    expect(ctx.err()).toBe(ctxCanceled)
  })

  test("omitting the deadline leaves the Context open until abort", () => {
    const ctx = fromAbortSignal(new AbortController().signal)
    expect(ctx.isDone()).toBe(false)
  })
})
