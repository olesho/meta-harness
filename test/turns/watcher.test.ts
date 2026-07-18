// Port of pkg/turns/watcher_test.go, plus a Watcher smoke test that exercises
// the actual session + screen pumps (the Go version relied on goroutines).

import { describe, expect, test } from "vitest";
import { newScreen } from "../../src/screen/index.ts";
import type { Adapter, Event } from "../../src/turns/index.ts";
import { TurnComplete, Watch } from "../../src/turns/index.ts";
import type { SessionEvent, SessionLike } from "../../src/turns/index.ts";
import { StatusWaitingForInput } from "../../src/turns/index.ts";
import type { Snapshot } from "../../src/screen/index.ts";

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
});
