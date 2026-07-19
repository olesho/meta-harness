// Oneshot inherits acquisition from the SINGLE chat Open/Watch seam (META-HARNESS-58).
//
// runOneShotDetailed is a thin client over one chat Conversation: Open → send →
// waitForTerminalTurn. Acquisition attaches exactly once inside that chat Open
// machinery, so oneshot must get it FOR FREE by forwarding the opt-in config —
// and must NEVER instantiate a second StreamTap (a double-attach would fan every
// PTY line to two taps → duplicated events, double session-id write).
//
// This reuses the fake Stream-eligible adapter + interleaving script shape from
// test/chat/stream_acquisition.test.ts, but drives it THROUGH oneshot. It asserts:
//   - with the acquisition flag set, the SAME single seam is driven: exactly the
//     three interleaved events arrive (seq 0,1,2 — a double-attach would double
//     them), and the chat-captured session id is written once and backfilled onto
//     every event (never dropped, never left blank);
//   - with the flag unset, behaviour is unchanged: no acquisition fan-off (the
//     sink stays empty) while raw session-id capture still works.

import { afterEach, describe, expect, test } from "vitest";

import { Context } from "../../src/internal/async/index.ts";
import { runOneShotDetailed } from "../../src/oneshot/index.ts";
import type {
  Adapter,
  Event as TurnEvent,
  Status,
} from "../../src/turns/index.ts";
import type { Snapshot } from "../../src/screen/index.ts";
import {
  SourceLive,
  type EventEnvelope,
  type ParsedEvent,
} from "../../src/transcript/index.ts";
import { AcquisitionModeStream } from "../../src/turns/index.ts";
import { New, fakeHarnessBin, fakeLaunchEnv } from "../chat/fakeharness.ts";

const cancels: (() => void)[] = [];
afterEach(() => {
  for (const c of cancels.splice(0)) c();
});
// Returns the deadline context AND its cancel. The deadline is kept generous
// (a pure safety net) so it never sits on the happy path: each test drives the
// run to its observable outcome, then calls `cancel()` to make runOneShotDetailed
// return promptly instead of burning the full deadline (15 s → <1 s per test).
function deadlineCtx(ms: number): { ctx: Context; cancel: () => void } {
  const { ctx, cancel } = Context.withDeadline(Context.background(), ms);
  cancels.push(cancel);
  return { ctx, cancel };
}

// A minimal turns.Adapter that carries a StreamParser but derives NO turn events
// from the screen (onScreen/onWrapperStatus return []), so the turn never settles
// and the run is driven purely by its deadline — the acquisition fan-off is thus
// orthogonal to the turn-state path. parseStreamLine recognizes `EVT|<id>|<type>|
// <text>` lines and extractSessionIDFromLine recognizes `SESSIONID:<id>`.
function makeStreamAdapter(): Adapter {
  const a: Record<string, unknown> = {
    name: () => "fake-stream",
    onScreen: (_snap: Snapshot): TurnEvent[] => [],
    onWrapperStatus: (_status: Status, _reason: string): TurnEvent[] => [],
    parseStreamLine(rawLine: string): ParsedEvent[] {
      const line = rawLine.replace(/[\r\n]+$/, "");
      if (!line.startsWith("EVT|")) return [];
      const [, id, type, text] = line.split("|");
      return [
        {
          harnessSessionID: id ?? "",
          event: { type: type ?? "text", text: text ?? "", source: SourceLive },
        },
      ];
    },
    streamInterleaved: () => true,
    extractSessionIDFromLine(line: string): [string, boolean] {
      const m = /^SESSIONID:(\S+)/.exec(line);
      return m ? [m[1], true] : ["", false];
    },
  };
  return a as unknown as Adapter;
}

// Interleave two EARLY stream events, THEN the session-id line, THEN a late one —
// so early events emit before capture completes (exercises cross-line backfill).
// No turn ever settles, so the run ends on its deadline.
function streamScript() {
  return New("generic")
    .Idle()
    .Raw(10, "EVT||text|early-1")
    .Raw(10, "EVT||text|early-2")
    .Raw(10, "SESSIONID:abc-123")
    .Raw(10, "EVT||tool_use|late-1")
    .StayAliveUntilStopped()
    .Build();
}

async function waitFor(
  cond: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs)
      throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("oneshot inherits acquisition from the single chat seam", () => {
  test("flag set: the SAME single tap fans out the run (3 events, id written once)", async () => {
    const events: EventEnvelope[] = [];
    const script = streamScript();

    // Start the run WITHOUT awaiting: the turn never settles, so its only exit is
    // the deadline. Poll the observation sink until the three events are in, then
    // cancel the context to force a prompt return — the deadline stays a safety net.
    const { ctx, cancel } = deadlineCtx(15000);
    const p = runOneShotDetailed(ctx, {
      harness: "generic",
      binaryPath: fakeHarnessBin,
      prompt: "drive the acquisition seam",
      env: fakeLaunchEnv(script),
      adapter: makeStreamAdapter(),
      // The acquisition opt-in — forwarded verbatim into the single chat Open.
      acquisitionMode: AcquisitionModeStream,
      onAcquisitionEvent: (env) => events.push(env),
      streamVersionPredicate: () => true,
      // Keep idle-completion from settling the turn early, so all events flow.
      idleGap: 5000,
    });
    await waitFor(() => events.length >= 3, 10000, "3 acquisition events");
    cancel();
    const out = await p;

    // Exactly the three interleaved events arrive, in arrival order, off ONE tap.
    // A second StreamTap (double-attach) would deliver each line twice.
    const texts = events.map((e) => e.event.text);
    expect(texts).toContain("early-1");
    expect(texts).toContain("early-2");
    expect(texts).toContain("late-1");
    expect(events.length).toBe(3);
    expect(events.map((e) => e.event.seq)).toEqual([0, 1, 2]);

    // The chat-captured id is written once and backfilled onto every event —
    // including the two emitted before capture completed.
    for (const e of events) {
      expect(e.harnessSessionID).toBe("abc-123");
      expect(e.harness).toBe("generic");
    }
    // The oneshot outcome carries that same single captured id.
    expect(out.harnessSessionID).toBe("abc-123");
  });

  test("flag unset: no acquisition fan-off, raw session-id capture unchanged", async () => {
    const events: EventEnvelope[] = [];
    const lines: string[] = [];
    const script = streamScript();

    // Sink stays empty (mode unset), so observe progress via onDisplayLine. The
    // `late-1` line arrives AFTER `SESSIONID:abc-123`, so once we see it the raw
    // capture has completed — then cancel to return promptly off the safety-net
    // deadline instead of blocking on it.
    const { ctx, cancel } = deadlineCtx(15000);
    const p = runOneShotDetailed(ctx, {
      harness: "generic",
      binaryPath: fakeHarnessBin,
      prompt: "no acquisition this time",
      env: fakeLaunchEnv(script),
      adapter: makeStreamAdapter(),
      // A sink is present but the mode is NOT set — the plan latches Off, so the
      // tap never fans acquisition events out (behaviour unchanged).
      onAcquisitionEvent: (env) => events.push(env),
      onDisplayLine: (l) => lines.push(l),
      idleGap: 5000,
    });
    await waitFor(
      () => lines.some((l) => l.includes("late-1")),
      10000,
      "late-1 display line (session id already captured)",
    );
    cancel();
    const out = await p;

    // Raw session-id capture still runs (the record is written), proving the
    // seam is intact — only the acquisition fan-off is dormant.
    expect(out.harnessSessionID).toBe("abc-123");
    // No live acquisition events without the mode flag.
    expect(events.length).toBe(0);
  });
});
