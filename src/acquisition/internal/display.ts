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

/**
 * DisplaySink is a queue-bounded, best-effort consumer of raw output lines.
 * `push` never blocks the producer; `close` flushes and returns the total number
 * of dropped lines.
 */
export interface DisplaySink {
  /** Enqueue a line without blocking. Evicts the oldest line when full. */
  push(line: string): void;
  /** Flush remaining lines and return the total dropped-line count. */
  close(): number;
}

// noopSink stands in for a null/absent callback so callers need not branch (the
// Go original returns a nil *displaySink whose methods are nil-safe).
const noopSink: DisplaySink = {
  push(): void {},
  close(): number {
    return 0;
  },
};

/**
 * newDisplaySink returns a best-effort sink draining to `onLine`, or a no-op
 * sink when `onLine` is null/undefined (the push/close methods stay safe to
 * call, so callers need not branch on the callback's presence).
 */
export function newDisplaySink(
  onLine?: ((line: string) => void) | null,
): DisplaySink {
  if (!onLine) return noopSink;
  return new BoundedDisplaySink(onLine);
}

class BoundedDisplaySink implements DisplaySink {
  private readonly onLine: (line: string) => void;
  private readonly queue: string[] = [];
  private dropped = 0;
  private closed = false;
  private scheduled = false;

  constructor(onLine: (line: string) => void) {
    this.onLine = onLine;
  }

  // push enqueues a line without blocking. On a full queue it drops the OLDEST
  // line to make room for the newest, counting the drop. A push after close is a
  // no-op.
  push(line: string): void {
    if (this.closed) return;
    if (this.queue.length >= displaySinkCap) {
      this.queue.shift();
      this.dropped++;
    }
    this.queue.push(line);
    this.schedule();
  }

  // schedule arranges an asynchronous drain on the event loop, coalescing many
  // pushes into a single drain so the producer's synchronous burst never blocks.
  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.drain();
    });
  }

  private drain(): void {
    this.scheduled = false;
    while (this.queue.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.deliver(this.queue.shift()!);
    }
  }

  // deliver calls the callback with error recovery: a misbehaving display sink is
  // dropped, never crashing the drain (display is non-critical).
  private deliver(line: string): void {
    try {
      this.onLine(line);
    } catch {
      // best-effort: a throwing callback is swallowed.
    }
  }

  // close flushes remaining lines and returns the total dropped count. Idempotent.
  close(): number {
    if (!this.closed) {
      this.closed = true;
      while (this.queue.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        this.deliver(this.queue.shift()!);
      }
    }
    return this.dropped;
  }
}
