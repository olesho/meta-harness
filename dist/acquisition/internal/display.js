// Bounded best-effort display sink — TS port of harness-wrapper's
// pkg/harness/display.go (displaySink).
//
// Delivers raw output lines to a best-effort consumer callback WITHOUT ever
// stalling the durable PTY read loop. The producer pushes lines non-blockingly;
// delivery to the callback happens asynchronously on the event loop. This is
// deliberately separate from the durable event / line-tap path: display is
// non-critical and MAY drop lines, the transcript path must not.
//
// Under sustained back-pressure the OLDEST line is dropped (the user wants the
// latest output), the drop is counted, and the producer never blocks.
// displaySinkCap bounds the best-effort display queue. Generous enough to absorb
// normal bursts; under sustained back-pressure the oldest lines are dropped.
export const displaySinkCap = 1024;
// noopSink stands in for a null/absent callback so callers need not branch (the
// Go original returns a nil *displaySink whose methods are nil-safe).
const noopSink = {
    push() { },
    close() {
        return 0;
    },
};
/**
 * newDisplaySink returns a best-effort sink draining to `onLine`, or a no-op
 * sink when `onLine` is null/undefined (the push/close methods stay safe to
 * call, so callers need not branch on the callback's presence).
 */
export function newDisplaySink(onLine) {
    if (!onLine)
        return noopSink;
    return new BoundedDisplaySink(onLine);
}
class BoundedDisplaySink {
    onLine;
    queue = [];
    dropped = 0;
    closed = false;
    scheduled = false;
    constructor(onLine) {
        this.onLine = onLine;
    }
    // push enqueues a line without blocking. On a full queue it drops the OLDEST
    // line to make room for the newest, counting the drop. A push after close is a
    // no-op.
    push(line) {
        if (this.closed)
            return;
        if (this.queue.length >= displaySinkCap) {
            this.queue.shift();
            this.dropped++;
        }
        this.queue.push(line);
        this.schedule();
    }
    // schedule arranges an asynchronous drain on the event loop, coalescing many
    // pushes into a single drain so the producer's synchronous burst never blocks.
    schedule() {
        if (this.scheduled)
            return;
        this.scheduled = true;
        queueMicrotask(() => this.drain());
    }
    drain() {
        this.scheduled = false;
        while (this.queue.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            this.deliver(this.queue.shift());
        }
    }
    // deliver calls the callback with error recovery: a misbehaving display sink is
    // dropped, never crashing the drain (display is non-critical).
    deliver(line) {
        try {
            this.onLine(line);
        }
        catch {
            // best-effort: a throwing callback is swallowed.
        }
    }
    // close flushes remaining lines and returns the total dropped count. Idempotent.
    close() {
        if (!this.closed) {
            this.closed = true;
            while (this.queue.length > 0) {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                this.deliver(this.queue.shift());
            }
        }
        return this.dropped;
    }
}
//# sourceMappingURL=display.js.map