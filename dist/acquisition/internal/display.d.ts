export declare const displaySinkCap = 1024;
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
/**
 * newDisplaySink returns a best-effort sink draining to `onLine`, or a no-op
 * sink when `onLine` is null/undefined (the push/close methods stay safe to
 * call, so callers need not branch on the callback's presence).
 */
export declare function newDisplaySink(onLine?: ((line: string) => void) | null): DisplaySink;
//# sourceMappingURL=display.d.ts.map