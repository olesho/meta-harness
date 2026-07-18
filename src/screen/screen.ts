// Screen — a vt100 terminal emulator (@xterm/headless, the TypeScript analog
// of vt10x per ADR-001) wrapped behind a small concurrent-safe surface.
// Callers feed raw PTY bytes via `write` and read coherent screen snapshots via
// `snapshot`. `subscribe` returns a coalesced notification channel that fires
// after every write so observers (turn detectors, gateways) can react without
// polling.
//
// The Screen is the substrate the turn-detection layer reads from. It
// intentionally exposes only what that layer needs: the rendered text,
// terminal dimensions, cursor position, and a monotonically increasing
// generation counter for change detection.
//
// JavaScript runs on a single thread, but writes into @xterm/headless are
// parsed asynchronously (the parser flushes on a microtask). We serialize
// writes behind a Mutex and await each flush so snapshots stay coherent and the
// generation counter mirrors the Go implementation exactly.

import { createRequire } from "node:module";

import { Mutex } from "../internal/async/index.ts";

// @xterm/headless is a CommonJS module. A bare `import { Terminal }` resolves
// under Bun and under a bundler (esbuild), but NOT under plain Node ESM — Node's
// CJS named-export detection doesn't see `Terminal` through xterm's UMD wrapper.
// createRequire loads the CJS module identically in every runtime, so the compiled
// dist also runs under raw Node (the sandbox structured runner + the build smoke).
// `InstanceType<typeof Terminal>` recovers the instance type for annotations.
const { Terminal } = createRequire(import.meta.url)(
  "@xterm/headless",
) as typeof import("@xterm/headless");

/**
 * A coherent point-in-time view of the emulated screen. Snapshots are plain
 * values and safe to retain — the underlying terminal continues to mutate
 * independently.
 */
export interface Snapshot {
  /**
   * Rendered screen contents, top-to-bottom, one '\n' per row. Trailing
   * whitespace per row is preserved (mirroring vt10x's String()); callers that
   * compare snapshots should normalize first.
   */
  text: string;
  /** Terminal dimensions in cells. */
  cols: number;
  rows: number;
  /** 0-indexed cursor position. */
  cursorCol: number;
  cursorRow: number;
  /** Increments on each successful write/resize. */
  generation: number;
}

/**
 * A coalesced notification channel handed back by `subscribe`. At most one
 * signal is buffered (size-1, like a Go `chan struct{}` of capacity 1): firing
 * while a signal is already pending is a no-op. Callers `receive()` then take a
 * `snapshot`.
 */
export interface Notify {
  /**
   * Resolve with `{ ok: true }` when a signal is available, or `{ ok: false }`
   * once the subscription has been closed and drained.
   */
  receive(): Promise<{ ok: boolean }>;
}

class Subscriber implements Notify {
  private pending = false;
  private closed = false;
  private waiter: ((r: { ok: boolean }) => void) | null = null;

  receive(): Promise<{ ok: boolean }> {
    if (this.pending) {
      this.pending = false;
      return Promise.resolve({ ok: true });
    }
    if (this.closed) return Promise.resolve({ ok: false });
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  /** Non-blocking, coalesced fire (mirrors Go's `select { case ch<-{}: default: }`). */
  signal(): void {
    if (this.closed) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ ok: true });
      return;
    }
    this.pending = true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ ok: false });
    }
  }
}

/**
 * Wraps a vt100 emulator with change-notification fan-out. All methods are safe
 * for concurrent (interleaved-async) use.
 */
export class Screen {
  private readonly term: InstanceType<typeof Terminal>;
  private readonly mu = new Mutex();
  private gen = 0;
  private readonly subs = new Set<Subscriber>();

  /**
   * Construct a Screen of the given dimensions. Cols and rows must be > 0;
   * defaults of 120x40 are applied to non-positive inputs to make tests and
   * quick experiments forgiving.
   */
  constructor(cols: number, rows: number) {
    if (cols <= 0) cols = 120;
    if (rows <= 0) rows = 40;
    this.term = new Terminal({ cols, rows, allowProposedApi: true });
  }

  /**
   * Feed raw PTY bytes (ANSI escapes intact) into the emulator. On success it
   * bumps generation and signals every subscriber. Writes are serialized so the
   * generation counter is exact under concurrency.
   */
  async write(data: string | Uint8Array): Promise<void> {
    await this.mu.lock();
    try {
      await new Promise<void>((resolve) => {
        this.term.write(data, resolve);
      });
      this.gen++;
    } finally {
      this.mu.unlock();
    }
    this.notify();
  }

  /** A coherent point-in-time view of the emulated screen. */
  snapshot(): Snapshot {
    const buf = this.term.buffer.active;
    const rows: string[] = [];
    for (let y = 0; y < this.term.rows; y++) {
      const line = buf.getLine(buf.baseY + y);
      // translateToString(false) keeps trailing whitespace, mirroring vt10x.
      rows.push(line ? line.translateToString(false) : "");
    }
    return {
      text: rows.join("\n"),
      cols: this.term.cols,
      rows: this.term.rows,
      cursorCol: buf.cursorX,
      cursorRow: buf.cursorY,
      generation: this.gen,
    };
  }

  /** The current write counter without rendering a snapshot. */
  generation(): number {
    return this.gen;
  }

  /**
   * Change the terminal dimensions. Existing screen content is preserved as
   * best the emulator allows.
   */
  resize(cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0) return;
    this.term.resize(cols, rows);
    this.gen++;
    this.notify();
  }

  /**
   * Return a coalesced (size-1) notification channel that signals after every
   * successful write/resize, plus an unsubscribe function that removes and
   * closes the channel.
   */
  subscribe(): [Notify, () => void] {
    const sub = new Subscriber();
    this.subs.add(sub);
    return [
      sub,
      () => {
        if (this.subs.delete(sub)) sub.close();
      },
    ];
  }

  private notify(): void {
    for (const sub of this.subs) sub.signal();
  }
}

/** Construct a Screen of the given dimensions (mirrors Go's `screen.New`). */
export function newScreen(cols: number, rows: number): Screen {
  return new Screen(cols, rows);
}
