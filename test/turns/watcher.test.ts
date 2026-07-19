// Port of pkg/turns/watcher_test.go, plus a Watcher smoke test that exercises
// the actual session + screen pumps (the Go version relied on goroutines).

import { describe, expect, test } from "vitest";
import { newScreen } from "../../src/screen/index.ts";
import type { Adapter, Event } from "../../src/turns/index.ts";
import { TurnComplete, Watch } from "../../src/turns/index.ts";
import type { SessionEvent, SessionLike } from "../../src/turns/index.ts";
import {
  StatusAPIError,
  StatusIdle,
  StatusWaitingForInput,
} from "../../src/turns/index.ts";
import type { Snapshot } from "../../src/screen/index.ts";

// Drives a SessionLike + Adapter through a Watcher, fully draining the event
// stream, and returns the collected turn events plus the final observation.
async function runWatcher(
  sessEvents: SessionEvent[],
  onWrapperStatus: Adapter["onWrapperStatus"],
): Promise<{
  got: Event[];
  obs: { retryAfter: number; sawAPIError: boolean };
}> {
  const sess: SessionLike = {
    async *events() {
      for (const e of sessEvents) yield e;
    },
  };
  const adapter: Adapter = {
    name: () => "recording",
    onScreen: (_snap: Snapshot): Event[] => [],
    onWrapperStatus,
  };
  const w = Watch(sess, null, adapter);
  const got: Event[] = [];
  for await (const ev of w.events()) got.push(ev);
  return { got, obs: w.observation() };
}

describe("watcher", () => {
  // Mirrors TestScreenWriteSnapshotPath: the screen subscription wiring fires
  // on Write and Snapshot reflects the write.
  test("screen write → subscription fires → snapshot advances", async () => {
    const scr = newScreen(40, 10);
    const [ch, unsub] = scr.subscribe();
    try {
      await scr.write("\x1b[2J\x1b[Hready");
      const r = await Promise.race([
        ch.receive(),
        new Promise<{ ok: false; timeout: true }>((resolve) =>
          setTimeout(() => {
            resolve({ ok: false, timeout: true });
          }, 100),
        ),
      ]);
      expect("timeout" in r).toBe(false);
      const snap = scr.snapshot();
      expect(snap.generation).toBeGreaterThan(0);
    } finally {
      unsub();
    }
  });

  // The Watcher composes a session stream and an adapter into one Event stream.
  test("Watch pumps wrapper status events through the adapter", async () => {
    const sessEvents: SessionEvent[] = [
      { status: StatusWaitingForInput, reason: "done", terminated: true },
    ];
    const sess: SessionLike = {
      async *events() {
        for (const e of sessEvents) yield e;
      },
    };
    const adapter: Adapter = {
      name: () => "recording",
      onScreen: (_snap: Snapshot): Event[] => [],
      onWrapperStatus: (_status, reason): Event[] => [
        { kind: TurnComplete, reason },
      ],
    };
    const w = Watch(sess, null, adapter);
    const got: Event[] = [];
    for await (const ev of w.events()) got.push(ev);
    expect(got.length).toBe(1);
    expect(got[0].kind).toBe(TurnComplete);
    expect(got[0].reason).toBe("done");
  });

  // Feature 3: run-level observation roll-up. Ports pkg/harness/run.go's
  // observation — the LARGEST retryAfter across EVERY raw event and whether ANY
  // event reported an api_error.
  test("observation reports max(retryAfter) and sawAPIError across all events", async () => {
    const { obs } = await runWatcher(
      [
        {
          status: StatusAPIError,
          reason: "rate limited",
          terminated: false,
          retryAfter: 1000,
        },
        {
          status: StatusIdle,
          reason: "recovered",
          terminated: false,
          retryAfter: 5000,
        },
        {
          status: StatusWaitingForInput,
          reason: "done",
          terminated: true,
          retryAfter: 2000,
        },
      ],
      // Emit one turn event per status so the pump keeps flowing.
      (_status, reason): Event[] => [{ kind: TurnComplete, reason }],
    );
    expect(obs.retryAfter).toBe(5000); // largest, not last
    expect(obs.sawAPIError).toBe(true);
  });

  test("observation.sawAPIError stays false when no event is an api_error", async () => {
    const { obs } = await runWatcher(
      [
        {
          status: StatusIdle,
          reason: "working",
          terminated: false,
          retryAfter: 250,
        },
        { status: StatusWaitingForInput, reason: "done", terminated: true },
      ],
      (_status, reason): Event[] => [{ kind: TurnComplete, reason }],
    );
    expect(obs.retryAfter).toBe(250);
    expect(obs.sawAPIError).toBe(false);
  });

  // The exact signal turn-level aggregation (conversation.ts:912) misses: an
  // api_error / retryAfter carried on an event the adapter maps to ZERO turn
  // events, whose run later exits with a DIFFERENT, non-error terminal status.
  test("observation captures an api_error that produced NO turn transition and survives a later non-error terminal", async () => {
    const { got, obs } = await runWatcher(
      [
        // api_error mid-run bearing a retryAfter — adapter drops it (no turn event).
        {
          status: StatusAPIError,
          reason: "transient",
          terminated: false,
          retryAfter: 3000,
        },
        // Recovered and finished with a NON-error terminal status.
        { status: StatusWaitingForInput, reason: "done", terminated: true },
      ],
      (status, reason): Event[] =>
        status === StatusWaitingForInput
          ? [{ kind: TurnComplete, reason }]
          : [],
    );
    // The api_error produced no TurnEvent — only the terminal completion did.
    expect(got.length).toBe(1);
    expect(got[0].kind).toBe(TurnComplete);
    // …yet the raw-event roll-up still captured both signals.
    expect(obs.sawAPIError).toBe(true);
    expect(obs.retryAfter).toBe(3000);
  });
});
