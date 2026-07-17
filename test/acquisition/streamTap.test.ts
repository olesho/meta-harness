// StreamTap unit tests — the per-run consumer of chat's durable PTY line tap.
//
// Covers: arrival-order seq stamping, the admitParent gate, live-emit gating by
// mode, best-effort display fan-out, the delivery-failure inert latch, and the
// session-id ownership boundary (no double-write of the chat record + correct
// after-the-fact backfill of pre-capture cross-line events).

import { describe, expect, test } from "vitest"

import { StreamTap, adapterStreamParser } from "../../src/acquisition/internal/streamTap.ts"
import { newDisplaySink } from "../../src/acquisition/internal/display.ts"
import {
  AcquisitionModeHooks,
  AcquisitionModeOff,
  AcquisitionModeStream,
} from "../../src/turns/index.ts"
import {
  EventText,
  EventToolUse,
  SchemaVersion,
  SourceLive,
  type EventEnvelope,
  type ParsedEvent,
} from "../../src/transcript/index.ts"

// A tiny fake StreamParser: lines shaped `id|type|text` become one ParsedEvent;
// a line with a leading `SUB:` prefix marks a subagent (parentSessionID set);
// anything else yields [] (the "tolerate non-event lines" contract).
function parse(line: string): ParsedEvent[] {
  if (!line.includes("|")) return []
  let l = line
  let parentSessionID = ""
  if (l.startsWith("SUB:")) {
    parentSessionID = "parent-xyz"
    l = l.slice(4)
  }
  const [hsid, type, text] = l.split("|")
  return [
    {
      harnessSessionID: hsid ?? "",
      parentSessionID: parentSessionID || undefined,
      event: { type: type ?? EventText, text: text ?? "", source: SourceLive },
    },
  ]
}

function collectTap(
  over: Partial<ConstructorParameters<typeof StreamTap>[0]> = {},
): { tap: StreamTap; events: EventEnvelope[] } {
  const events: EventEnvelope[] = []
  const tap = new StreamTap({
    harness: "fake",
    runID: "run-1",
    mode: AcquisitionModeStream,
    parser: parse,
    onEvent: (env) => events.push(env),
    sessionID: () => "sess-known",
    ...over,
  })
  return { tap, events }
}

describe("StreamTap.installs", () => {
  test("true when a StreamParser + sink are present", () => {
    const { tap } = collectTap()
    expect(tap.installs()).toBe(true)
  })
  test("true when only a display sink is present (no parser/sink)", () => {
    const tap = new StreamTap({
      harness: "fake",
      runID: "r",
      mode: AcquisitionModeOff,
      display: newDisplaySink(() => {}),
      sessionID: () => "",
    })
    expect(tap.installs()).toBe(true)
  })
  test("false with neither a live consumer nor a display sink", () => {
    const tap = new StreamTap({
      harness: "fake",
      runID: "r",
      mode: AcquisitionModeStream,
      parser: parse,
      sessionID: () => "",
    })
    expect(tap.installs()).toBe(false) // parser present but no onEvent sink
  })
})

describe("StreamTap live emit", () => {
  test("Stream mode parses lines and emits stamped envelopes in arrival order", () => {
    const { tap, events } = collectTap()
    tap.onLine("|text|hello")
    tap.onLine("not-an-event-line")
    tap.onLine("|tool_use|run")
    expect(events).toHaveLength(2)
    expect(events[0]!.event.seq).toBe(0)
    expect(events[1]!.event.seq).toBe(1)
    expect(events[0]!.event.type).toBe(EventText)
    expect(events[1]!.event.type).toBe(EventToolUse)
    expect(events[0]!.runID).toBe("run-1")
    expect(events[0]!.harness).toBe("fake")
    expect(events[0]!.event.schemaVersion).toBe(SchemaVersion)
  })

  test("Hooks mode does NOT emit live events (inert fan-off)", () => {
    const { tap, events } = collectTap({ mode: AcquisitionModeHooks })
    tap.onLine("|text|hi")
    expect(events).toHaveLength(0)
  })

  test("Off mode does NOT emit live events", () => {
    const { tap, events } = collectTap({ mode: AcquisitionModeOff })
    tap.onLine("|text|hi")
    expect(events).toHaveLength(0)
  })

  test("a parser-supplied harnessSessionID is stamped verbatim", () => {
    const { tap, events } = collectTap()
    tap.onLine("native-abc|text|hi")
    expect(events[0]!.harnessSessionID).toBe("native-abc")
  })

  test("subagent events are admitted even for a file source (via admitParent)", () => {
    const { tap, events } = collectTap()
    tap.onLine("SUB:sub-1|text|from subagent")
    expect(events).toHaveLength(1)
    expect(events[0]!.parentSessionID).toBe("parent-xyz")
  })
})

describe("StreamTap display fan-out", () => {
  test("every raw line is pushed to the display sink, independent of parse", async () => {
    const seen: string[] = []
    const { tap } = collectTap({ display: newDisplaySink((l) => seen.push(l)) })
    tap.onLine("|text|a")
    tap.onLine("plain line")
    // display drains asynchronously (queueMicrotask); let it settle.
    await new Promise((r) => setTimeout(r, 0))
    expect(seen).toEqual(["|text|a", "plain line"])
  })

  test("display runs even in Off mode (only live emit is gated)", async () => {
    const seen: string[] = []
    const tap = new StreamTap({
      harness: "fake",
      runID: "r",
      mode: AcquisitionModeOff,
      parser: parse,
      display: newDisplaySink((l) => seen.push(l)),
      sessionID: () => "",
    })
    tap.onLine("|text|a")
    await new Promise((r) => setTimeout(r, 0))
    expect(seen).toEqual(["|text|a"])
  })
})

describe("StreamTap delivery failure", () => {
  test("goes inert after the first throwing onEvent and reports the error", () => {
    let errCount = 0
    const tap = new StreamTap({
      harness: "fake",
      runID: "r",
      mode: AcquisitionModeStream,
      parser: parse,
      onEvent: () => {
        throw new Error("sink down")
      },
      onDeliverError: () => errCount++,
      sessionID: () => "s",
    })
    tap.onLine("|text|a")
    tap.onLine("|text|b") // ignored — tap is inert
    expect(errCount).toBe(1)
  })
})

describe("StreamTap session-id ownership boundary", () => {
  test("NEVER writes the session record — only reads via the getter", () => {
    let reads = 0
    const { tap, events } = collectTap({
      sessionID: () => {
        reads++
        return "read-only-id"
      },
    })
    tap.onLine("|text|a") // parser gives no id → falls back to the getter
    expect(reads).toBeGreaterThan(0)
    expect(events[0]!.harnessSessionID).toBe("read-only-id")
    // The getter is the ONLY session-id touchpoint; StreamTap exposes no writer.
    expect((tap as unknown as Record<string, unknown>).updateSession).toBeUndefined()
  })

  test("backfills pre-capture (cross-line) events once the id is known", () => {
    let captured = "" // starts empty: capture has not completed yet
    const { tap, events } = collectTap({ sessionID: () => captured })

    // Early stream events arrive BEFORE the session-id-bearing line.
    tap.onLine("|text|early-1")
    tap.onLine("|text|early-2")
    expect(events).toHaveLength(2)
    // Emitted with an EMPTY id (not dropped, not fabricated) and retained.
    expect(events[0]!.harnessSessionID).toBe("")
    expect(events[1]!.harnessSessionID).toBe("")
    expect(tap.pendingCount()).toBe(2)

    // Capture completes (the chat-owned path sets the id), then backfill fires.
    captured = "sess-late"
    tap.backfill()

    // The SAME envelope objects the sink already holds are backfilled in place.
    expect(events[0]!.harnessSessionID).toBe("sess-late")
    expect(events[1]!.harnessSessionID).toBe("sess-late")
    expect(tap.pendingCount()).toBe(0)
  })

  test("backfill is a no-op while the id is still empty", () => {
    let captured = ""
    const { tap, events } = collectTap({ sessionID: () => captured })
    tap.onLine("|text|early")
    tap.backfill() // id still empty
    expect(events[0]!.harnessSessionID).toBe("")
    expect(tap.pendingCount()).toBe(1)
    captured = "later"
    tap.backfill()
    expect(events[0]!.harnessSessionID).toBe("later")
  })

  test("post-capture events take the id directly and are never pending", () => {
    const { tap, events } = collectTap({ sessionID: () => "already-known" })
    tap.onLine("|text|a")
    expect(events[0]!.harnessSessionID).toBe("already-known")
    expect(tap.pendingCount()).toBe(0)
  })
})

describe("adapterStreamParser", () => {
  test("binds parseStreamLine off an adapter that implements StreamParser", () => {
    const adapter = {
      name: () => "x",
      parseStreamLine(line: string): ParsedEvent[] {
        return parse(line)
      },
    }
    const p = adapterStreamParser(adapter)
    expect(p).not.toBeNull()
    expect(p!("|text|hi")).toHaveLength(1)
  })

  test("returns null when the adapter has no parseStreamLine", () => {
    expect(adapterStreamParser({ name: () => "x" })).toBeNull()
    expect(adapterStreamParser(null)).toBeNull()
  })
})
