import { describe, expect, test, vi } from "vitest"
import { Fanout, type EventSource } from "../../src/gateway/fanout.ts"
import { streamSSE, type ServerResponseLike } from "../../src/gateway/sse.ts"
import { EventBus } from "../../src/chat/conversation.ts"
import type { ConversationEvent, Turn } from "../../src/chat/types.ts"

function turnEvent(id: string): ConversationEvent {
  return { type: "turn", turn: { id } as unknown as Turn }
}

/** A fake ServerResponse that records writes and its close listeners. */
class FakeRes implements ServerResponseLike {
  status = 0
  headers: Record<string, string> = {}
  writes: string[] = []
  ended = false
  private closeListeners: Array<() => void> = []

  writeHead(status: number, headers: Record<string, string>): void {
    this.status = status
    this.headers = headers
  }
  write(chunk: string): boolean {
    this.writes.push(chunk)
    return true
  }
  end(): void {
    this.ended = true
  }
  on(event: "close", listener: () => void): void {
    if (event === "close") this.closeListeners.push(listener)
  }
  /** Simulate the client/transport dropping the connection. */
  fireClose(): void {
    for (const l of this.closeListeners) l()
  }
}

/** Wait a macrotask so the pump/loop can advance. */
const tick = () => new Promise((r) => setImmediate(r))

describe("streamSSE", () => {
  test("writes SSE headers and well-formed data frames", async () => {
    const bus = new EventBus(32)
    const fan = new Fanout(bus as unknown as EventSource)
    const sub = fan.subscribe()
    const res = new FakeRes()

    const done = streamSSE(res, sub, { heartbeatMs: 10_000 })

    bus.emit(turnEvent("t1"))
    bus.emit(turnEvent("t2"))
    await tick()

    expect(res.status).toBe(200)
    expect(res.headers["Content-Type"]).toBe("text/event-stream")
    expect(res.headers["Cache-Control"]).toBe("no-cache")

    const frames = res.writes.filter((w) => w.startsWith("data: "))
    expect(frames).toEqual([
      `data: ${JSON.stringify(turnEvent("t1"))}\n\n`,
      `data: ${JSON.stringify(turnEvent("t2"))}\n\n`,
    ])
    // Every data frame terminates with the SSE double newline.
    for (const f of frames) expect(f.endsWith("\n\n")).toBe(true)

    res.fireClose()
    bus.close()
    await done
  })

  test("emits a : ping heartbeat on the injectable interval", async () => {
    vi.useFakeTimers()
    try {
      const bus = new EventBus(32)
      const fan = new Fanout(bus as unknown as EventSource)
      const sub = fan.subscribe()
      const res = new FakeRes()

      const done = streamSSE(res, sub, { heartbeatMs: 15_000 })

      expect(res.writes.filter((w) => w === ": ping\n\n")).toHaveLength(0)
      vi.advanceTimersByTime(15_000)
      expect(res.writes.filter((w) => w === ": ping\n\n")).toHaveLength(1)
      vi.advanceTimersByTime(15_000)
      expect(res.writes.filter((w) => w === ": ping\n\n")).toHaveLength(2)

      res.fireClose()
      bus.close()
      vi.runOnlyPendingTimers()
      await done
    } finally {
      vi.useRealTimers()
    }
  })

  test("res 'close' tears down: no further data or heartbeat writes", async () => {
    vi.useFakeTimers()
    try {
      const bus = new EventBus(32)
      const fan = new Fanout(bus as unknown as EventSource)
      const sub = fan.subscribe()
      const res = new FakeRes()

      const done = streamSSE(res, sub, { heartbeatMs: 15_000 })

      res.fireClose()
      const countAfterClose = res.writes.length

      // Post-close events and elapsed heartbeat intervals produce nothing.
      bus.emit(turnEvent("late"))
      vi.advanceTimersByTime(60_000)
      await Promise.resolve()

      expect(res.writes.length).toBe(countAfterClose)
      expect(res.writes.some((w) => w.includes("late"))).toBe(false)

      bus.close()
      await done
    } finally {
      vi.useRealTimers()
    }
  })

  test("req 'close' also tears down the stream", async () => {
    const bus = new EventBus(32)
    const fan = new Fanout(bus as unknown as EventSource)
    const sub = fan.subscribe()
    const res = new FakeRes()

    let reqClose: (() => void) | undefined
    const req = {
      on(event: "close", listener: () => void) {
        if (event === "close") reqClose = listener
      },
    }

    const done = streamSSE(res, sub, { heartbeatMs: 10_000, req })

    bus.emit(turnEvent("t1"))
    await tick()
    reqClose?.()

    bus.emit(turnEvent("t2"))
    await tick()

    expect(res.writes.some((w) => w.includes("t1"))).toBe(true)
    expect(res.writes.some((w) => w.includes("t2"))).toBe(false)

    bus.close()
    await done
  })

  test("AbortSignal stop signal tears down the stream", async () => {
    const bus = new EventBus(32)
    const fan = new Fanout(bus as unknown as EventSource)
    const sub = fan.subscribe()
    const res = new FakeRes()
    const ac = new AbortController()

    const done = streamSSE(res, sub, { heartbeatMs: 10_000, signal: ac.signal })

    bus.emit(turnEvent("t1"))
    await tick()
    ac.abort()

    bus.emit(turnEvent("t2"))
    await tick()

    expect(res.writes.some((w) => w.includes("t1"))).toBe(true)
    expect(res.writes.some((w) => w.includes("t2"))).toBe(false)

    bus.close()
    await done
  })

  test("custom encode callback controls the frame body", async () => {
    const bus = new EventBus(32)
    const fan = new Fanout(bus as unknown as EventSource)
    const sub = fan.subscribe()
    const res = new FakeRes()

    const done = streamSSE(res, sub, {
      heartbeatMs: 10_000,
      encode: (ev) => `type=${ev.type}`,
    })

    bus.emit(turnEvent("t1"))
    await tick()

    expect(res.writes).toContain("data: type=turn\n\n")

    res.fireClose()
    bus.close()
    await done
  })
})
