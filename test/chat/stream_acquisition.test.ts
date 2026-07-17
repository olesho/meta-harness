// The only LIVE exercise of Stream-mode acquisition in A1 (META-HARNESS-57).
//
// A FAKE adapter that (i) implements parseStreamLine/StreamParser + marks itself
// interleaved, and (ii) whose fake harness INTERLEAVES stream-json into ordinary
// PTY output, driven over the REAL pty by chat.Open. It asserts:
//
//   - the widened tap gate instantiates the durable LineSplitter tap even for a
//     Stream-eligible adapter that does NOT implement extractSessionIDFromLine;
//   - StreamTap receives parsed events off the SAME shared onLine/LineSplitter
//     tap (no second launch, no second PTY reader);
//   - the Screen + turn watcher (c.watcher) remain the sole turn-state authority —
//     Stream only ADDS a consumer;
//   - the session-id ownership boundary: the chat record is written once (by the
//     raw-capture path), and pre-capture (cross-line) stream events are backfilled
//     after the fact — never dropped, never left blank.

import { afterEach, describe, expect, test } from "vitest"

import { Context } from "../../src/internal/async/index.ts"
import { Open, newMemStore, type Conversation } from "../../src/chat/index.ts"
import type { Adapter, Event as TurnEvent, Status } from "../../src/turns/index.ts"
import type { Snapshot } from "../../src/screen/index.ts"
import { SourceLive, type EventEnvelope, type ParsedEvent } from "../../src/transcript/index.ts"
import { AcquisitionModeStream } from "../../src/turns/index.ts"
import { New, fakeHarnessBin, fakeLaunchEnv } from "./fakeharness.ts"

const open = new Set<Conversation>()
afterEach(async () => {
  for (const conv of open) {
    const { ctx } = Context.withDeadline(Context.background(), 2000)
    await conv.close(ctx)
  }
  open.clear()
})
function track(conv: Conversation): Conversation {
  open.add(conv)
  return conv
}

// A minimal turns.Adapter that also carries a StreamParser. It never derives
// turn events from the screen (onScreen/onWrapperStatus return []), so it proves
// the turn-state path is orthogonal to the stream fan-off. parseStreamLine
// recognizes only `EVT|<id>|<type>|<text>` lines (tolerating everything else),
// and — for the non-regression variant — extractSessionIDFromLine recognizes
// `SESSIONID:<id>`.
function makeStreamAdapter(opts: { rawSessionID: boolean }): Adapter {
  const a: Record<string, unknown> = {
    name: () => "fake-stream",
    onScreen: (_snap: Snapshot): TurnEvent[] => [],
    onWrapperStatus: (_status: Status, _reason: string): TurnEvent[] => [],
    // StreamParser: interleaved stream-json.
    parseStreamLine(rawLine: string): ParsedEvent[] {
      const line = rawLine.replace(/[\r\n]+$/, "") // tolerate PTY CRLF framing
      if (!line.startsWith("EVT|")) return []
      const [, id, type, text] = line.split("|")
      return [
        {
          harnessSessionID: id ?? "",
          event: { type: type ?? "text", text: text ?? "", source: SourceLive },
        },
      ]
    },
    // StreamInterleaved: Stream-eligible.
    streamInterleaved: () => true,
  }
  if (opts.rawSessionID) {
    a.extractSessionIDFromLine = (line: string): [string, boolean] => {
      const m = /^SESSIONID:(\S+)/.exec(line)
      return m ? [m[1]!, true] : ["", false]
    }
  }
  return a as unknown as Adapter
}

async function openStream(
  script: ReturnType<ReturnType<typeof New>["Build"]>,
  adapter: Adapter,
  sink: (env: EventEnvelope) => void,
): Promise<Conversation> {
  return Open(undefined, {
    harness: "generic",
    binaryPath: fakeHarnessBin,
    env: fakeLaunchEnv(script),
    store: newMemStore(),
    cols: 120,
    rows: 40,
    adapter,
    acquisitionMode: AcquisitionModeStream,
    onAcquisitionEvent: sink,
    // Force the fact-3 version gate so the fake harness is Stream-eligible.
    streamVersionPredicate: () => true,
  })
}

async function waitFor(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe("Stream-mode acquisition over the real pty", () => {
  test("StreamTap receives interleaved events; watcher stays the turn authority; id backfilled once", async () => {
    const events: EventEnvelope[] = []
    // Interleave: two EARLY stream events, THEN the session-id line, THEN a late
    // one — so early events emit before capture completes (cross-line backfill).
    const script = New("generic")
      .Idle()
      .Raw(10, "EVT||text|early-1")
      .Raw(10, "EVT||text|early-2")
      .Raw(10, "SESSIONID:abc-123")
      .Raw(10, "EVT||tool_use|late-1")
      .StayAliveUntilStopped()
      .Build()

    const store = newMemStore()
    const conv = track(
      await Open(undefined, {
        harness: "generic",
        binaryPath: fakeHarnessBin,
        env: fakeLaunchEnv(script),
        store,
        cols: 120,
        rows: 40,
        adapter: makeStreamAdapter({ rawSessionID: true }),
        acquisitionMode: AcquisitionModeStream,
        onAcquisitionEvent: (env) => events.push(env),
        streamVersionPredicate: () => true,
      }),
    )

    // The turn-state authority (Screen + watcher) is present and separate from
    // the acquisition tap — Stream ADDED a consumer, it did not replace the path.
    expect(conv.watcher).toBeDefined()
    expect(conv.streamTap).toBeDefined()

    // All three interleaved stream events arrive off the shared onLine tap.
    await waitFor(() => events.length >= 3, 4000, "3 stream events")
    const texts = events.map((e) => e.event.text)
    expect(texts).toContain("early-1")
    expect(texts).toContain("early-2")
    expect(texts).toContain("late-1")

    // Arrival-order seq is monotonic from 0.
    expect(events.map((e) => e.event.seq)).toEqual([0, 1, 2])

    // The chat record is written exactly once by the raw-capture path.
    await waitFor(
      () => conv.session.harnessSessionID === "abc-123",
      4000,
      "session id captured",
    )
    const stored = await store.getSession(conv.sessionID())
    expect(stored.harnessSessionID).toBe("abc-123")

    // Cross-line backfill: the pre-capture events, emitted with an empty id, are
    // backfilled in place — never dropped, never left blank.
    await waitFor(
      () => events.filter((e) => e.event.text?.startsWith("early")).every((e) => e.harnessSessionID === "abc-123"),
      4000,
      "early events backfilled",
    )
    for (const e of events) {
      expect(e.harnessSessionID).toBe("abc-123")
      expect(e.runID).toBe(conv.sessionID())
      expect(e.harness).toBe("generic")
    }
  })

  test("regression (critique a): a Stream-eligible adapter with NO extractSessionIDFromLine still gets a tap", async () => {
    const events: EventEnvelope[] = []
    const script = New("generic")
      .Idle()
      .Raw(10, "EVT|native-1|text|hello")
      .StayAliveUntilStopped()
      .Build()

    const conv = track(
      await openStream(script, makeStreamAdapter({ rawSessionID: false }), (env) =>
        events.push(env),
      ),
    )

    // The tap was instantiated purely on the StreamParser need (the old
    // adapterRawSessionID()-only gate would have left onLine undefined, and this
    // event would never arrive).
    await waitFor(() => events.length >= 1, 4000, "1 stream event")
    expect(events[0]!.event.text).toBe("hello")
    // The parser supplied the id, so no chat-capture was needed.
    expect(events[0]!.harnessSessionID).toBe("native-1")
    expect(conv.streamTap).toBeDefined()
  })
})
