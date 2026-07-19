// Feature 3: the run-level observation surfaced from Conversation. Verifies the
// READ-TIMING contract — the observation is captured at the CORRECT post-terminal
// seam (after consumeWatcher's event loop drains the terminal event), NOT at
// watcher.close() (which only joins the screen pump, never pump 1).

import { describe, expect, test } from "vitest";
import { Conversation, EventBus } from "../../src/chat/conversation.ts";
import { newMemStore } from "../../src/chat/memstore.ts";
import { Watch } from "../../src/turns/index.ts";
import type {
  Adapter,
  Event,
  SessionEvent,
  SessionLike,
} from "../../src/turns/index.ts";
import {
  StatusAPIError,
  StatusWaitingForInput,
} from "../../src/turns/index.ts";
import type { Snapshot } from "../../src/screen/index.ts";
import type { Session } from "../../src/chat/types.ts";

// Builds a concrete turns.Watcher over a fake session whose FINAL (terminal)
// event carries the largest retryAfter and an api_error, mapping every raw event
// to ZERO turn events so nothing but the roll-up observes them.
function watcherWithTerminalSignal(sessEvents: SessionEvent[]) {
  const sess: SessionLike = {
    async *events() {
      for (const e of sessEvents) yield e;
    },
  };
  const adapter: Adapter = {
    name: () => "recording",
    onScreen: (_snap: Snapshot): Event[] => [],
    onWrapperStatus: (): Event[] => [],
  };
  return Watch(sess, null, adapter);
}

function mkSession(): Session {
  return {
    id: "obs-session",
    harness: "",
    workingDir: "",
    createdAt: new Date(),
    harnessSessionID: "obs-harness", // non-empty: skip session-id extraction paths
  };
}

// Reach the private consumeWatcher pump the way the chat tests read private state.
function consume(c: Conversation): Promise<void> {
  return (c as unknown as { consumeWatcher(): Promise<void> }).consumeWatcher();
}

describe("Conversation.observation", () => {
  test("captured AFTER the consumeWatcher loop — NOT at watcher.close()", async () => {
    const watcher = watcherWithTerminalSignal([
      // api_error + largest retryAfter carried on the FINAL, terminal event.
      {
        status: StatusAPIError,
        reason: "overloaded",
        terminated: true,
        retryAfter: 42000,
      },
    ]);
    const c = new Conversation({
      store: newMemStore(),
      session: mkSession(),
      eventCh: new EventBus(4),
      watcher: watcher as unknown as NonNullable<
        ConstructorParameters<typeof Conversation>[0]
      >["watcher"],
    });

    // watcher.close() is the WRONG barrier: it only fires the screen pump's
    // onClose and returns synchronously — it never joins pump 1, so the
    // Conversation has captured nothing yet.
    watcher.close();
    expect(c.observation()).toEqual({ retryAfter: 0, sawAPIError: false });

    // The CORRECT seam: drain the event loop to completion, which returns done
    // only after pump 1 processed the terminal event.
    await consume(c);
    expect(c.observation()).toEqual({ retryAfter: 42000, sawAPIError: true });
  });

  test("sawAPIError survives a later non-error terminal (no turn transition)", async () => {
    const watcher = watcherWithTerminalSignal([
      {
        status: StatusAPIError,
        reason: "transient",
        terminated: false,
        retryAfter: 3000,
      },
      { status: StatusWaitingForInput, reason: "done", terminated: true },
    ]);
    const c = new Conversation({
      store: newMemStore(),
      session: mkSession(),
      eventCh: new EventBus(4),
      watcher: watcher as unknown as NonNullable<
        ConstructorParameters<typeof Conversation>[0]
      >["watcher"],
    });

    await consume(c);
    expect(c.observation()).toEqual({ retryAfter: 3000, sawAPIError: true });
  });
});
