import { describe, expect, test } from "vitest"
import { Fanout, type EventSource } from "../../src/gateway/fanout.ts"
import { EventBus } from "../../src/chat/conversation.ts"
import type { ConversationEvent, Turn } from "../../src/chat/types.ts"

/** A ConversationEvent carrying an identifiable turn (only `id` matters here). */
function turnEvent(id: string): ConversationEvent {
  return { type: "turn", turn: { id } as unknown as Turn }
}

function inputEvent(id: string): ConversationEvent {
  return { type: "input_request", input: { id, kind: "question", prompt: id } }
}

/** Drain up to `n` events (or until close) from a subscription. */
async function take(
  sub: { receive(): Promise<{ value?: ConversationEvent; ok: boolean }> },
  n: number,
): Promise<ConversationEvent[]> {
  const out: ConversationEvent[] = []
  for (let i = 0; i < n; i++) {
    const { value, ok } = await sub.receive()
    if (!ok) break
    out.push(value!)
  }
  return out
}

describe("Fanout", () => {
  test("multi-subscriber: two subscribers each receive every event", async () => {
    const bus = new EventBus(32)
    const fan = new Fanout(bus as unknown as EventSource)

    const a = fan.subscribe()
    const b = fan.subscribe()

    bus.emit(turnEvent("t1"))
    bus.emit(inputEvent("i1"))
    bus.emit(turnEvent("t2"))

    const [ra, rb] = await Promise.all([take(a, 3), take(b, 3)])
    expect(ra.map((e) => e.turn?.id ?? e.input?.id)).toEqual(["t1", "i1", "t2"])
    expect(rb.map((e) => e.turn?.id ?? e.input?.id)).toEqual(["t1", "i1", "t2"])

    a.unsubscribe()
    b.unsubscribe()
    bus.close()
    await fan.done()
  })

  test("no-lost-events: events emitted before first subscribe are replayed", async () => {
    const bus = new EventBus(32)
    const fan = new Fanout(bus as unknown as EventSource)

    // Emit BEFORE anyone subscribes — the eager drain must buffer these.
    bus.emit(turnEvent("pre1"))
    bus.emit(inputEvent("pre2"))
    // Yield so the background pump drains them into the pending buffer.
    await new Promise((r) => setImmediate(r))

    const sub = fan.subscribe()
    // A post-subscribe event too, to prove ordering across the boundary.
    bus.emit(turnEvent("post1"))

    const got = await take(sub, 3)
    expect(got.map((e) => e.turn?.id ?? e.input?.id)).toEqual(["pre1", "pre2", "post1"])

    sub.unsubscribe()
    bus.close()
    await fan.done()
  })

  test("later subscribers do not replay the pre-first-attach buffer", async () => {
    const bus = new EventBus(32)
    const fan = new Fanout(bus as unknown as EventSource)

    bus.emit(turnEvent("pre1"))
    await new Promise((r) => setImmediate(r))

    const first = fan.subscribe()
    expect((await take(first, 1)).map((e) => e.turn?.id)).toEqual(["pre1"])

    // Second subscriber attaches after the buffer was already flushed.
    const second = fan.subscribe()
    bus.emit(turnEvent("after"))

    const [rf, rs] = await Promise.all([take(first, 1), take(second, 1)])
    expect(rf.map((e) => e.turn?.id)).toEqual(["after"])
    expect(rs.map((e) => e.turn?.id)).toEqual(["after"])

    first.unsubscribe()
    second.unsubscribe()
    bus.close()
    await fan.done()
  })

  test("unsubscribe stops delivery and does not affect siblings", async () => {
    const bus = new EventBus(32)
    const fan = new Fanout(bus as unknown as EventSource)

    const a = fan.subscribe()
    const b = fan.subscribe()
    a.unsubscribe()

    bus.emit(turnEvent("t1"))
    const rb = await take(b, 1)
    expect(rb.map((e) => e.turn?.id)).toEqual(["t1"])

    // The unsubscribed subscription is closed: receive resolves not-ok.
    expect((await a.receive()).ok).toBe(false)

    b.unsubscribe()
    bus.close()
    await fan.done()
  })

  test("subscribing after the source closes yields an already-ended subscription", async () => {
    const bus = new EventBus(32)
    const fan = new Fanout(bus as unknown as EventSource)
    bus.close()
    await fan.done()

    const sub = fan.subscribe()
    expect((await sub.receive()).ok).toBe(false)
    expect(fan.closed).toBe(true)
  })

  test("closing the source ends live subscribers", async () => {
    const bus = new EventBus(32)
    const fan = new Fanout(bus as unknown as EventSource)
    const sub = fan.subscribe()

    bus.close()
    await fan.done()

    expect((await sub.receive()).ok).toBe(false)
  })
})
