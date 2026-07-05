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
import { Mutex } from "../internal/async/index.js";
// @xterm/headless is a CommonJS module. A bare `import { Terminal }` resolves
// under Bun and under a bundler (esbuild), but NOT under plain Node ESM — Node's
// CJS named-export detection doesn't see `Terminal` through xterm's UMD wrapper.
// createRequire loads the CJS module identically in every runtime, so the compiled
// dist also runs under raw Node (the sandbox structured runner + the build smoke).
// `InstanceType<typeof Terminal>` recovers the instance type for annotations.
const { Terminal } = createRequire(import.meta.url)("@xterm/headless");
class Subscriber {
    pending = false;
    closed = false;
    waiter = null;
    receive() {
        if (this.pending) {
            this.pending = false;
            return Promise.resolve({ ok: true });
        }
        if (this.closed)
            return Promise.resolve({ ok: false });
        return new Promise((resolve) => {
            this.waiter = resolve;
        });
    }
    /** Non-blocking, coalesced fire (mirrors Go's `select { case ch<-{}: default: }`). */
    signal() {
        if (this.closed)
            return;
        if (this.waiter) {
            const w = this.waiter;
            this.waiter = null;
            w({ ok: true });
            return;
        }
        this.pending = true;
    }
    close() {
        if (this.closed)
            return;
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
    term;
    mu = new Mutex();
    gen = 0;
    subs = new Set();
    /**
     * Construct a Screen of the given dimensions. Cols and rows must be > 0;
     * defaults of 120x40 are applied to non-positive inputs to make tests and
     * quick experiments forgiving.
     */
    constructor(cols, rows) {
        if (cols <= 0)
            cols = 120;
        if (rows <= 0)
            rows = 40;
        this.term = new Terminal({ cols, rows, allowProposedApi: true });
    }
    /**
     * Feed raw PTY bytes (ANSI escapes intact) into the emulator. On success it
     * bumps generation and signals every subscriber. Writes are serialized so the
     * generation counter is exact under concurrency.
     */
    async write(data) {
        await this.mu.lock();
        try {
            await new Promise((resolve) => this.term.write(data, resolve));
            this.gen++;
        }
        finally {
            this.mu.unlock();
        }
        this.notify();
    }
    /** A coherent point-in-time view of the emulated screen. */
    snapshot() {
        const buf = this.term.buffer.active;
        const rows = [];
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
    generation() {
        return this.gen;
    }
    /**
     * Change the terminal dimensions. Existing screen content is preserved as
     * best the emulator allows.
     */
    resize(cols, rows) {
        if (cols <= 0 || rows <= 0)
            return;
        this.term.resize(cols, rows);
        this.gen++;
        this.notify();
    }
    /**
     * Return a coalesced (size-1) notification channel that signals after every
     * successful write/resize, plus an unsubscribe function that removes and
     * closes the channel.
     */
    subscribe() {
        const sub = new Subscriber();
        this.subs.add(sub);
        return [
            sub,
            () => {
                if (this.subs.delete(sub))
                    sub.close();
            },
        ];
    }
    notify() {
        for (const sub of this.subs)
            sub.signal();
    }
}
/** Construct a Screen of the given dimensions (mirrors Go's `screen.New`). */
export function newScreen(cols, rows) {
    return new Screen(cols, rows);
}
//# sourceMappingURL=screen.js.map