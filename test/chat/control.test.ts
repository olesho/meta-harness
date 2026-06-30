// Port of pkg/chat/control_test.go — the FIFO control-token turnstile.
import { describe, expect, test } from "bun:test"
import { newControlQueue } from "../../src/chat/control.ts"
import { ErrClosed } from "../../src/chat/errors.ts"
import { isSentinel } from "../../src/internal/async/index.ts"
import { Context, ctxDeadlineExceeded } from "../../src/internal/async/context.ts"

describe("controlQueue", () => {
  test("immediate acquire + release toggles Held", async () => {
    const q = newControlQueue()
    const release = await q.acquire(Context.background())
    expect(q.held()).toBe(true)
    release()
    expect(q.held()).toBe(false)
  })

  test("FIFO ordering", async () => {
    const q = newControlQueue()
    const release = await q.acquire(Context.background())

    const order: number[] = []
    const waiters: Promise<void>[] = []
    // acquire pushes its waiter synchronously, so calling in a loop preserves
    // queue order; do NOT await each (they block until the token frees).
    for (let i = 0; i < 5; i++) {
      waiters.push(
        q.acquire(Context.background()).then((rel) => {
          order.push(i)
          rel()
        }),
      )
    }
    // Release the initial holder; waiters drain FIFO.
    release()
    await Promise.all(waiters)
    expect(order).toEqual([0, 1, 2, 3, 4])
  })

  test("ctx cancel while waiting rejects; original holder unchanged", async () => {
    const q = newControlQueue()
    const release = await q.acquire(Context.background())

    const { ctx } = Context.withDeadline(Context.background(), 30)
    let err: unknown
    try {
      await q.acquire(ctx)
    } catch (e) {
      err = e
    }
    expect(isSentinel(err, ctxDeadlineExceeded)).toBe(true)
    expect(q.held()).toBe(true)
    release()
  })

  test("double release is safe", async () => {
    const q = newControlQueue()
    const release = await q.acquire(Context.background())
    release()
    release()
    expect(q.held()).toBe(false)
  })

  test("closed queue rejects acquire with ErrClosed", async () => {
    const q = newControlQueue()
    q.close()
    let err: unknown
    try {
      await q.acquire(Context.background())
    } catch (e) {
      err = e
    }
    expect(isSentinel(err, ErrClosed)).toBe(true)
  })
})
