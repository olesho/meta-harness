import { describe, expect, test } from "vitest"
import {
  CausedError,
  Channel,
  chanClosed,
  Context,
  ControlQueue,
  ctxCanceled,
  ctxDeadlineExceeded,
  defineSentinel,
  isSentinel,
  Mutex,
  queueClosed,
  wrap,
} from "../../src/internal/async/index.ts"

describe("Channel", () => {
  test("buffered send/receive preserves FIFO order", async () => {
    const ch = new Channel<number>(2)
    await ch.send(1)
    await ch.send(2)
    expect(await ch.receive()).toEqual({ value: 1, ok: true })
    expect(await ch.receive()).toEqual({ value: 2, ok: true })
  })

  test("receiver blocked then unblocked by a send", async () => {
    const ch = new Channel<string>(0)
    const got = ch.receive()
    await ch.send("hi")
    expect(await got).toEqual({ value: "hi", ok: true })
  })

  test("full buffer blocks the sender until a receive frees a slot", async () => {
    const ch = new Channel<number>(1)
    await ch.send(1)
    let sent = false
    const p = ch.send(2).then(() => {
      sent = true
    })
    await Promise.resolve()
    expect(sent).toBe(false)
    expect(await ch.receive()).toEqual({ value: 1, ok: true })
    await p
    expect(sent).toBe(true)
    expect(await ch.receive()).toEqual({ value: 2, ok: true })
  })

  test("close drains receivers with ok:false and rejects send", async () => {
    const ch = new Channel<number>(0)
    ch.close()
    expect(await ch.receive()).toEqual({ value: undefined, ok: false })
    await expect(ch.send(1)).rejects.toBe(chanClosed)
    expect(ch.closed).toBe(true)
  })

  test("async iteration yields buffered values until closed", async () => {
    const ch = new Channel<number>(3)
    await ch.send(10)
    await ch.send(20)
    ch.close()
    const out: number[] = []
    for await (const v of ch) out.push(v)
    expect(out).toEqual([10, 20])
  })
})

describe("Context", () => {
  test("withCancel resolves done() and sets err()", async () => {
    const { ctx, cancel } = Context.withCancel(Context.background())
    expect(ctx.isDone()).toBe(false)
    cancel()
    await ctx.done()
    expect(ctx.err()).toBe(ctxCanceled)
  })

  test("withDeadline expires with ctxDeadlineExceeded", async () => {
    const { ctx } = Context.withDeadline(Context.background(), 5)
    await ctx.done()
    expect(ctx.err()).toBe(ctxDeadlineExceeded)
  })

  test("cancellation propagates to children", async () => {
    const { ctx: parent, cancel } = Context.withCancel(Context.background())
    const { ctx: child } = Context.withCancel(parent)
    cancel()
    await child.done()
    expect(child.err()).toBe(ctxCanceled)
  })
})

describe("Mutex", () => {
  test("serializes concurrent withLock sections", async () => {
    const m = new Mutex()
    const log: string[] = []
    const a = m.withLock(async () => {
      log.push("a-start")
      await Promise.resolve()
      log.push("a-end")
    })
    const b = m.withLock(async () => {
      log.push("b-start")
      log.push("b-end")
    })
    await Promise.all([a, b])
    expect(log).toEqual(["a-start", "a-end", "b-start", "b-end"])
  })

  test("unlock releases lock to next waiter", async () => {
    const m = new Mutex()
    await m.lock()
    let acquired = false
    const p = m.lock().then(() => {
      acquired = true
    })
    expect(acquired).toBe(false)
    m.unlock()
    await p
    expect(acquired).toBe(true)
  })
})

describe("ControlQueue", () => {
  test("FIFO acquire/release order", async () => {
    const q = new ControlQueue()
    const ctx = Context.background()
    const order: number[] = []
    await q.acquire(ctx) // holder
    const second = q.acquire(ctx).then(() => order.push(2))
    const third = q.acquire(ctx).then(() => order.push(3))
    q.release()
    await second
    q.release()
    await third
    expect(order).toEqual([2, 3])
  })

  test("ctx-cancel while waiting removes waiter and rejects", async () => {
    const q = new ControlQueue()
    await q.acquire(Context.background())
    const { ctx, cancel } = Context.withCancel(Context.background())
    const waiting = q.acquire(ctx)
    cancel()
    await expect(waiting).rejects.toBe(ctxCanceled)
    // Releasing the held turn does not error after the waiter left.
    q.release()
  })

  test("double-release is a no-op", async () => {
    const q = new ControlQueue()
    await q.acquire(Context.background())
    q.release()
    expect(() => q.release()).not.toThrow()
    // Queue is free again and re-acquirable.
    await q.acquire(Context.background())
  })

  test("closed queue rejects acquire", async () => {
    const q = new ControlQueue()
    q.close()
    await expect(q.acquire(Context.background())).rejects.toBe(queueClosed)
    expect(q.closed).toBe(true)
  })

  test("close rejects pending waiters", async () => {
    const q = new ControlQueue()
    await q.acquire(Context.background())
    const waiting = q.acquire(Context.background())
    q.close()
    await expect(waiting).rejects.toBe(queueClosed)
  })
})

describe("error-cause toolkit", () => {
  const sentA = defineSentinel("layer-a/boom")
  const sentB = defineSentinel("layer-b/bang")

  test("each sentinel has a unique stable code", () => {
    expect(sentA.code).toBe("layer-a/boom")
    expect(sentB.code).toBe("layer-b/bang")
    expect(sentA.code).not.toBe(sentB.code)
  })

  test("isSentinel matches by identity", () => {
    expect(isSentinel(sentA, sentA)).toBe(true)
    expect(isSentinel(sentA, sentB)).toBe(false)
  })

  test("isSentinel walks the cause chain (errors.Is analogue)", () => {
    const wrapped = wrap("outer", wrap("inner", sentA))
    expect(wrapped).toBeInstanceOf(CausedError)
    expect(isSentinel(wrapped, sentA)).toBe(true)
    expect(isSentinel(wrapped, sentB)).toBe(false)
  })

  test("isSentinel matches an equal code on a non-identical object", () => {
    const lookalike = { code: "layer-a/boom" }
    expect(isSentinel(wrap("ctx", lookalike), sentA)).toBe(true)
  })

  test("isSentinel tolerates cyclic chains without hanging", () => {
    const a = new CausedError("a")
    const b = new CausedError("b", a)
    ;(a as { cause?: unknown }).cause = b
    expect(isSentinel(a, sentA)).toBe(false)
  })
})
