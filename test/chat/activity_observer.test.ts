// Port of pkg/harness/run.go's startActivityObserver / OnActivity /
// ActivityInterval (run.go:65-78,229,238-250; DefaultActivityInterval = 10s):
// the persistent Conversation's periodic wrapper-session liveness ticker. It
// samples the WRAPPER-SESSION snapshot (carrying lastOutputAt) every
// activityInterval ms and hands it to onActivity, plus one FINAL sample at
// close() taken BEFORE sess.stop(). It is harness-INDEPENDENT (fires regardless
// of prompt-readiness) and inert when onActivity is unset.
import { describe, expect, test } from "vitest";
import {
  Conversation,
  DefaultActivityInterval,
  EventBus,
} from "../../src/chat/conversation.ts";
import { newMemStore } from "../../src/chat/memstore.ts";
import type { Session as WrapperSession } from "../../src/wrapper/index.ts";
import {
  StatusIdle,
  type Snapshot as SessionSnapshot,
} from "../../src/wrapper/index.ts";
import type { Context } from "../../src/internal/async/index.ts";
import type { Session } from "../../src/chat/types.ts";

/**
 * A fake wrapper session exposing only the surface the activity observer needs.
 * snapshot() returns a live SessionSnapshot whose lastOutputAt is observable;
 * after stop() it THROWS, so a post-mortem sample (one taken after sess.stop())
 * is detectable — close() must sample before stopping.
 */
class FakeSession {
  stopped = false;
  stopCount = 0;
  constructor(private lastOutput: Date | null) {}
  writeStdin(_p: Uint8Array): number {
    return 0;
  }
  acquireWriter(): [() => void, boolean] {
    return [() => {}, true];
  }
  resize(_cols: number, _rows: number): void {}
  async stop(_ctx?: Context): Promise<void> {
    this.stopped = true;
    this.stopCount++;
  }
  snapshot(): SessionSnapshot {
    if (this.stopped) throw new Error("snapshot after stop (post-mortem)");
    return { status: StatusIdle, reason: "", lastOutputAt: this.lastOutput };
  }
}

function newActivityConv(
  harness: string,
  opts: {
    onActivity?: (snap: SessionSnapshot) => void;
    activityInterval?: number;
  },
  sess: FakeSession,
): Conversation {
  const store = newMemStore();
  const session: Session = {
    id: "activity-session",
    harness,
    workingDir: "",
    createdAt: new Date(),
    harnessSessionID: "",
  };
  void store.createSession(session);
  return new Conversation({
    opts: { harness, ...opts },
    store,
    session,
    sess: sess as unknown as WrapperSession,
    eventCh: new EventBus(8),
  });
}

/** Starts the private activity-observer loop (the startPumps() entry point). */
function startObserver(c: Conversation): Promise<void> {
  return (
    c as unknown as { activityObserver(): Promise<void> }
  ).activityObserver();
}

const wait = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

describe("activity observer", () => {
  test("DefaultActivityInterval mirrors Go's 10s", () => {
    expect(DefaultActivityInterval).toBe(10_000);
  });

  test("fires at the configured activityInterval carrying the wrapper snapshot", async () => {
    const out: SessionSnapshot[] = [];
    const lastOutput = new Date(1_700_000_000_000);
    const sess = new FakeSession(lastOutput);
    const c = newActivityConv(
      "claude-code",
      { onActivity: (s) => out.push(s), activityInterval: 20 },
      sess,
    );
    void startObserver(c);
    await wait(130);
    await c.close();

    // ~6 ticks in 130ms at a 20ms cadence; allow slack for timer jitter.
    expect(out.length).toBeGreaterThanOrEqual(4);
    // The delivered payload is the WRAPPER-SESSION snapshot: lastOutputAt is
    // present and populated (proves sess.snapshot() was sampled, not the screen
    // snapshot, which has no liveness field).
    expect(out[0].lastOutputAt).toBeInstanceOf(Date);
    expect(out[0].lastOutputAt?.getTime()).toBe(lastOutput.getTime());
    expect(out[0].status).toBe(StatusIdle);
  });

  test("ticker stops on close()", async () => {
    const out: SessionSnapshot[] = [];
    const sess = new FakeSession(new Date(1_700_000_000_000));
    const c = newActivityConv(
      "claude-code",
      { onActivity: (s) => out.push(s), activityInterval: 20 },
      sess,
    );
    void startObserver(c);
    await wait(70);
    await c.close();
    const afterClose = out.length;
    await wait(120);
    // No further ticks after close: the count is frozen (close's final sample is
    // already included in afterClose).
    expect(out.length).toBe(afterClose);
  });

  test("takes a FINAL sample BEFORE sess.stop()", async () => {
    const out: SessionSnapshot[] = [];
    const lastOutput = new Date(1_700_000_000_000);
    const sess = new FakeSession(lastOutput);
    // A long interval so the periodic tick never fires during the test — the
    // only sample must be close()'s final one.
    const c = newActivityConv(
      "claude-code",
      { onActivity: (s) => out.push(s), activityInterval: 100_000 },
      sess,
    );
    void startObserver(c);
    // close() must not throw: if it sampled AFTER stop(), FakeSession.snapshot()
    // would throw a post-mortem error.
    await expect(c.close()).resolves.toBeUndefined();
    expect(sess.stopped).toBe(true);
    // Exactly one (final) sample, and it reflects PRE-stop liveness state.
    expect(out.length).toBe(1);
    expect(out[0].lastOutputAt?.getTime()).toBe(lastOutput.getTime());
  });

  test("fires on a harness where requiresPromptReadiness is FALSE", async () => {
    // "generic" → requiresPromptReadiness === false. If the observer had
    // inherited idleCompletionWatcher's `!requiresPromptReadiness` early-return,
    // it would never fire here.
    const out: SessionSnapshot[] = [];
    const sess = new FakeSession(new Date(1_700_000_000_000));
    const c = newActivityConv(
      "generic",
      { onActivity: (s) => out.push(s), activityInterval: 20 },
      sess,
    );
    void startObserver(c);
    await wait(80);
    await c.close();
    expect(out.length).toBeGreaterThanOrEqual(2);
  });

  test("does NOT fire when onActivity is undefined", async () => {
    const sess = new FakeSession(new Date(1_700_000_000_000));
    const c = newActivityConv("claude-code", { activityInterval: 20 }, sess);
    // activityObserver returns immediately (sole gate: onActivity set).
    await startObserver(c);
    await wait(80);
    await c.close();
    // No snapshot() calls were made by the observer, and close() delivers no
    // final sample either (onActivity is nil) — the session was still stopped.
    expect(sess.stopped).toBe(true);
  });
});
