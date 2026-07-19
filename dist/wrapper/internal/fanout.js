// Dynamic PTY output fan-out for the wrapper Session — a TS port of Go's
// pkg/wrapper attach.go `outputFanout` (Session.AttachOutput).
//
// A Session writes PTY bytes to one fixed StdoutSink plus the durable, non-lossy
// taps (recent-output ring + line tap). This module adds a SEPARATE, best-effort
// layer: any number of observers can attach/detach at runtime to tail the same
// output, each with its own bounded byte ring that DROPS the oldest chunks under
// back-pressure rather than stalling the PTY read loop or its siblings.
//
// Two layers, two pieces of reviewed prior art:
//   * multiplexer / lifecycle — modelled on src/gateway/fanout.ts (Fanout):
//     N subscribers, attach/detach, source-close broadcast, refuse-after-close.
//   * per-sink ring/drain — modelled on src/acquisition/internal/display.ts
//     (BoundedDisplaySink): push + async drain + drop-oldest + counted drops +
//     throw-safe delivery. The only deltas: bound by BYTES over Uint8Array
//     chunks (matching recentOutput's 64 KB byte convention) rather than by line
//     count over strings, and the drain `await`s the sink because OutputSink.write
//     may be async.
//
// Neither is imported — the gateway one is ConversationEvent-typed and pull-based,
// BoundedDisplaySink is string/line-bounded and single-sink; both are shape
// references only.
/**
 * Per-sink ring capacity in BYTES (matches recentOutput's 64 KB convention).
 * Bounding by bytes — never by chunk count — keeps memory bounded under large
 * chunks.
 */
export const SINK_CAP_BYTES = 64 * 1024;
/**
 * One attached observer: a bounded byte ring plus a single-flight async pump.
 * The byte-bounded analogue of BoundedDisplaySink's queue/dropped/schedule/drain.
 */
class SinkEntry {
    sink;
    /** Called when the pump kills this sink (write threw/rejected) so the owner drops it. */
    onDead;
    queue = [];
    bytes = 0;
    _dropped = 0;
    closed = false;
    pumping = false;
    constructor(sink, onDead) {
        this.sink = sink;
        this.onDead = onDead;
    }
    dropped() {
        return this._dropped;
    }
    /**
     * Enqueue a chunk without blocking. On a full ring, drop the OLDEST chunks
     * until it fits and count each drop (the display.ts shift-and-count loop,
     * byte-bounded). A push after close is a no-op.
     */
    push(chunk) {
        if (this.closed)
            return;
        while (this.queue.length > 0 &&
            this.bytes + chunk.length > SINK_CAP_BYTES) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const old = this.queue.shift();
            this.bytes -= old.length;
            this._dropped++;
        }
        this.queue.push(chunk);
        this.bytes += chunk.length;
        this.schedule();
    }
    /** Arrange a single asynchronous drain, coalescing a synchronous push burst. */
    schedule() {
        if (this.pumping)
            return;
        this.pumping = true;
        queueMicrotask(() => {
            void this.pump();
        });
    }
    /**
     * Drain the ring one chunk at a time, awaiting each write so a slow sink lets
     * its own ring accumulate (and eventually drop-oldest) without blocking the
     * read loop or sibling sinks — the awaited analogue of BoundedDisplaySink.drain.
     * A write that throws or rejects kills only this sink.
     */
    async pump() {
        try {
            while (this.queue.length > 0 && !this.closed) {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                const chunk = this.queue.shift();
                this.bytes -= chunk.length;
                try {
                    await this.sink.write(chunk);
                }
                catch {
                    // A misbehaving sink is detached; it must not break sibling pumps or
                    // the read loop (display.ts's deliver() try/catch, extended to reject).
                    this.shutdown(false);
                    this.onDead(this);
                    return;
                }
            }
        }
        finally {
            this.pumping = false;
        }
    }
    /**
     * End this sink synchronously: discard any buffered ring contents (the
     * deliberate discard-not-flush choice) and, when `fireEof`, invoke the sink's
     * optional close?() exactly once. The `closed` flag is set first so an
     * in-flight `await write` cannot race a second close?() nor keep draining.
     */
    shutdown(fireEof) {
        if (this.closed)
            return;
        this.closed = true;
        this.queue.length = 0;
        this.bytes = 0;
        if (fireEof && this.sink.close) {
            try {
                this.sink.close();
            }
            catch {
                // best-effort EOF signal: a throwing close?() is swallowed.
            }
        }
    }
}
/** A detached / already-closed handle: delivers nothing, drops nothing. */
const DEAD_HANDLE = {
    detach() {
        // already closed: nothing to detach.
    },
    dropped() {
        return 0;
    },
};
/**
 * Multiplexes PTY output to N runtime observers. `push` copies each chunk once
 * and enqueues it into every live sink's ring (best-effort, may drop);
 * `attach`/detach manage membership; `close` ends every sink at session end.
 */
export class OutputFanout {
    sinks = new Set();
    closed = false;
    /** True when at least one observer is attached (the hot-path guard). */
    hasSinks() {
        return this.sinks.size > 0;
    }
    /**
     * Attach an observer. Returns an idempotent handle whose detach() removes the
     * sink, ends its pump, and discards its ring. After the fanout has closed
     * (session exit), returns an already-closed handle that delivers nothing.
     */
    attach(sink) {
        if (this.closed)
            return DEAD_HANDLE;
        const entry = new SinkEntry(sink, (e) => {
            this.sinks.delete(e);
        });
        this.sinks.add(entry);
        let detached = false;
        return {
            detach: () => {
                if (detached)
                    return;
                detached = true;
                if (this.sinks.delete(entry))
                    entry.shutdown(false);
            },
            dropped: () => entry.dropped(),
        };
    }
    /**
     * Enqueue a chunk into every live observer. Zero-observer fast path: when
     * nobody is attached this returns with NO copy and NO allocation, keeping the
     * common (no-observer) session's hot path byte-for-byte unchanged. When
     * observers exist, the chunk is copied ONCE (defending the ring against later
     * mutation of the caller's buffer, since the ring retains it across arbitrary
     * later reads) and the immutable copy is shared into each sink's ring.
     */
    push(data) {
        if (this.sinks.size === 0)
            return;
        const copy = data.slice();
        for (const entry of this.sinks)
            entry.push(copy);
    }
    /**
     * End the fanout at session exit: end every observer's pump, DISCARD any
     * still-buffered ring contents (discard-not-flush), fire each sink's close?()
     * exactly once, and refuse future attaches. Idempotent.
     */
    close() {
        if (this.closed)
            return;
        this.closed = true;
        for (const entry of this.sinks)
            entry.shutdown(true);
        this.sinks.clear();
    }
}
//# sourceMappingURL=fanout.js.map