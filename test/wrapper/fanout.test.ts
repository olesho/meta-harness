// Tests for the wrapper output fan-out (src/wrapper/internal/fanout.ts) and its
// wiring into Session.onOutput / attachOutput / close.
//
// The fanout unit is driven directly with in-memory fake OutputSinks (no real
// PTY) — both to sidestep the node-pty/Bun data-stream flake and because the
// drop test needs the async-pump back-pressure to be directly simulable (a fake
// whose write returns a promise the test controls). Session-level behavior
// (durable-tap ordering, the traced stdout throw) is driven with a fake PtyProcess
// so onOutput runs without spawning the bridge.

import { describe, expect, test, vi } from "vitest";

import {
  OutputFanout,
  SINK_CAP_BYTES,
  type OutputSink,
} from "../../src/wrapper/internal/fanout.ts";
import {
  applyDefaults,
  ClassifierFunc,
  Session,
  type StdoutSink,
} from "../../src/wrapper/internal/session.ts";
import { type Config } from "../../src/wrapper/internal/config.ts";
import {
  type PtyProcess,
  type PtyExit,
} from "../../src/wrapper/internal/pty.ts";
import { type Classification } from "../../src/wrapper/internal/classification.ts";
import { type Event, type Emitter } from "../../src/wrapper/trace.ts";

// Await enough microtask turns for every deferred pump to drain (delivery is
// always on a later microtask, never inline).
async function drainMicrotasks(turns = 50): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const decode = (u: Uint8Array): string => new TextDecoder().decode(u);

/** A fake OutputSink recording every delivered chunk (as text). */
class RecordingSink implements OutputSink {
  readonly got: string[] = [];
  closes = 0;
  write(data: Uint8Array): void {
    this.got.push(decode(data));
  }
  close(): void {
    this.closes++;
  }
}

describe("OutputFanout", () => {
  test("multi-sink delivery in order + isolated detach", async () => {
    const f = new OutputFanout();
    const a = new RecordingSink();
    const b = new RecordingSink();
    const detachA = f.attach(a);
    f.attach(b);

    f.push(bytes("one"));
    f.push(bytes("two"));
    // Deferred: nothing delivered on the synchronous tick.
    expect(a.got).toEqual([]);
    expect(b.got).toEqual([]);

    await drainMicrotasks();
    expect(a.got).toEqual(["one", "two"]);
    expect(b.got).toEqual(["one", "two"]);

    // Detaching a stops delivery to it only; b keeps receiving.
    detachA.detach();
    f.push(bytes("three"));
    await drainMicrotasks();
    expect(a.got).toEqual(["one", "two"]);
    expect(b.got).toEqual(["one", "two", "three"]);
  });

  test("detach handle is idempotent", async () => {
    const f = new OutputFanout();
    const a = new RecordingSink();
    const h = f.attach(a);
    h.detach();
    h.detach(); // no throw, no effect
    f.push(bytes("x"));
    await drainMicrotasks();
    expect(a.got).toEqual([]);
  });

  test("slow sink drops the OLDEST chunks with an exact count", () => {
    const f = new OutputFanout();
    // A sink whose write never resolves — but since no microtask boundary is
    // crossed the pump never runs, so every chunk stays queued and pushes beyond
    // the byte cap evict the oldest (byte-bounded analogue of the display drop test).
    const slow: OutputSink = {
      write: () => new Promise(() => {}),
    };
    const h = f.attach(slow);

    const chunk = new Uint8Array(1024); // 64 chunks == SINK_CAP_BYTES exactly
    const capChunks = SINK_CAP_BYTES / 1024;
    const extra = 7;
    for (let i = 0; i < capChunks + extra; i++) f.push(chunk);

    expect(h.dropped()).toBe(extra);
  });

  test("a slow sink never blocks or drops for a fast sibling", async () => {
    const f = new OutputFanout();
    const slowWrites: string[] = [];
    const slow: OutputSink = {
      write: (d) => {
        slowWrites.push(decode(d));
        return new Promise(() => {}); // pending forever
      },
    };
    const fast = new RecordingSink();
    const hSlow = f.attach(slow);
    f.attach(fast);

    f.push(bytes("a"));
    f.push(bytes("b"));
    f.push(bytes("c"));
    await drainMicrotasks();

    // Fast sibling received everything in order, dropped nothing.
    expect(fast.got).toEqual(["a", "b", "c"]);
    // Slow sink's pump stalled on the first (pending) write; the rest sit in its
    // ring, undropped (well under the byte cap).
    expect(slowWrites).toEqual(["a"]);
    expect(hSlow.dropped()).toBe(0);
  });

  test("a throwing or rejecting sink does not break siblings", async () => {
    const f = new OutputFanout();
    const thrower: OutputSink = {
      write: () => {
        throw new Error("boom");
      },
    };
    const rejecter: OutputSink = {
      write: () => Promise.reject(new Error("nope")),
    };
    const good = new RecordingSink();
    f.attach(thrower);
    f.attach(rejecter);
    f.attach(good);

    expect(() => {
      f.push(bytes("one"));
      f.push(bytes("two"));
    }).not.toThrow();
    await drainMicrotasks();

    // The good sink is unaffected by its misbehaving siblings.
    expect(good.got).toEqual(["one", "two"]);
  });

  test("copy-on-enqueue: mutating the caller's buffer after push is not observed", async () => {
    const f = new OutputFanout();
    const sink = new RecordingSink();
    f.attach(sink);

    const buf = bytes("hello");
    f.push(buf);
    buf.fill(0); // mutate the caller's backing buffer after enqueue
    await drainMicrotasks();

    expect(sink.got).toEqual(["hello"]);
  });

  test("zero-observer fast path: no copy/allocation when nobody is attached", async () => {
    const f = new OutputFanout();
    const data = bytes("payload");
    const sliceSpy = vi.spyOn(data, "slice");

    f.push(data); // no sinks: must not slice
    expect(sliceSpy).not.toHaveBeenCalled();
    expect(f.hasSinks()).toBe(false);

    // With a sink attached, the chunk IS copied.
    const sink = new RecordingSink();
    f.attach(sink);
    expect(f.hasSinks()).toBe(true);
    f.push(data);
    expect(sliceSpy).toHaveBeenCalledTimes(1);
    await drainMicrotasks();
    expect(sink.got).toEqual(["payload"]);
  });

  test("close discards buffered chunks and fires close?() exactly once", async () => {
    const f = new OutputFanout();
    const writes: string[] = [];
    let closes = 0;
    const slow: OutputSink = {
      write: (d) => {
        writes.push(decode(d));
        return new Promise(() => {}); // stall after the first chunk
      },
      close: () => {
        closes++;
      },
    };
    f.attach(slow);

    f.push(bytes("a"));
    f.push(bytes("b"));
    f.push(bytes("c"));
    await drainMicrotasks();
    // Pump stalled mid-write on "a"; "b"/"c" are buffered but undelivered.
    expect(writes).toEqual(["a"]);

    f.close();
    f.close(); // idempotent
    await drainMicrotasks();

    // Buffered chunks are DISCARDED, not flushed; close?() fired once.
    expect(writes).toEqual(["a"]);
    expect(closes).toBe(1);
  });

  test("attach after close yields a no-op handle delivering nothing", async () => {
    const f = new OutputFanout();
    f.close();
    const sink = new RecordingSink();
    const h = f.attach(sink);

    f.push(bytes("late"));
    await drainMicrotasks();
    expect(sink.got).toEqual([]);
    expect(sink.closes).toBe(0);
    expect(h.dropped()).toBe(0);
    expect(() => {
      h.detach();
    }).not.toThrow();
  });
});

// ---- Session-level wiring (fake PtyProcess, no bridge) ---------------------

const emptyClassification: Classification = {
  status: "",
  class: 0,
  reason: "",
  terminal: false,
  httpCode: 0,
  retryAfter: 0,
  resumeAt: null,
};

/** A minimal PtyProcess stand-in that lets a test drive onData/onExit directly. */
class FakePty {
  pid = 4242;
  private dataCb: ((d: Uint8Array) => void) | null = null;
  private exitCb: ((e: PtyExit) => void) | null = null;
  onData(cb: (d: Uint8Array) => void): void {
    this.dataCb = cb;
  }
  onExit(cb: (e: PtyExit) => void): void {
    this.exitCb = cb;
  }
  write(): void {}
  resize(): void {}
  kill(): void {}
  closeStdin(): void {}
  emit(d: Uint8Array): void {
    this.dataCb?.(d);
  }
  exit(e: PtyExit): void {
    this.exitCb?.(e);
  }
}

class RecordingEmitter implements Emitter {
  readonly events: Event[] = [];
  emit(e: Event): void {
    this.events.push(e);
  }
  kinds(): string[] {
    return this.events.map((e) => e.kind);
  }
}

function makeSession(opts: {
  stdout: StdoutSink;
  onLine?: (line: string) => void;
  trace: Emitter;
}): { sess: Session; pty: FakePty } {
  const cfg: Config = {
    binaryPath: "fake",
    stdout: opts.stdout,
    onLine: opts.onLine ?? null,
    idleQuiet: 10_000,
    idleClassify: 30_000,
    staleThreshold: 60_000,
  };
  applyDefaults(cfg);
  const pty = new FakePty();
  const sess = new Session({
    cfg,
    pty: pty as unknown as PtyProcess,
    trace: opts.trace,
    classifier: ClassifierFunc(() => emptyClassification),
    startedAt: new Date(),
  });
  return { sess, pty };
}

describe("Session output fanout wiring", () => {
  test("durable taps stay non-lossy with a slow/dropping observer attached", async () => {
    const lines: string[] = [];
    const stdout: StdoutSink = { write: () => {} };
    const trace = new RecordingEmitter();
    const { sess, pty } = makeSession({
      stdout,
      onLine: (l) => lines.push(l),
      trace,
    });
    sess.start();

    // A slow observer that stalls immediately and would drop under pressure.
    sess.attachOutput({ write: () => new Promise(() => {}) });

    pty.emit(bytes("alpha\nbeta\n"));
    pty.emit(bytes("gamma\n"));
    await drainMicrotasks();

    // The line tap and recent-output ring received every byte in order,
    // regardless of the observer.
    expect(lines).toEqual(["alpha", "beta", "gamma"]);
    expect(sess.recentOutput()).toBe("alpha\nbeta\ngamma\n");

    pty.exit({ exitCode: 0, signal: 0 });
    await sess.wait();
  });

  test("a throwing fixed stdout is traced, not swallowed, and does not break reads", async () => {
    const trace = new RecordingEmitter();
    const lines: string[] = [];
    const stdout: StdoutSink = {
      write: () => {
        throw new Error("screen boom");
      },
    };
    const { sess, pty } = makeSession({
      stdout,
      onLine: (l) => lines.push(l),
      trace,
    });
    sess.start();

    pty.emit(bytes("hello\n"));
    pty.emit(bytes("world\n"));
    await drainMicrotasks();

    // The read loop survived: durable taps ran for both chunks despite the throw.
    expect(lines).toEqual(["hello", "world"]);
    expect(sess.recentOutput()).toBe("hello\nworld\n");
    // The throw was traced, not silently dropped.
    expect(trace.kinds()).toContain("stdout_write_failed");

    pty.exit({ exitCode: 0, signal: 0 });
    await sess.wait();
  });

  test("attachOutput after session exit delivers nothing", async () => {
    const trace = new RecordingEmitter();
    const { sess, pty } = makeSession({
      stdout: { write: () => {} },
      trace,
    });
    sess.start();
    pty.exit({ exitCode: 0, signal: 0 });
    await sess.wait();

    const sink = new RecordingSink();
    const detach = sess.attachOutput(sink);
    // No live PTY output can arrive post-exit; the handle is a no-op regardless.
    await drainMicrotasks();
    expect(sink.got).toEqual([]);
    expect(() => {
      detach();
    }).not.toThrow();
  });
});
