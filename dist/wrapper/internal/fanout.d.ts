/**
 * A runtime observer of raw PTY output. Distinct from the fixed StdoutSink: an
 * OutputSink is best-effort and MAY have chunks dropped under back-pressure.
 */
export interface OutputSink {
    /**
     * Deliver one chunk of PTY bytes. May be synchronous or async; when it returns
     * a thenable the pump awaits it, applying back-pressure to THIS sink's ring
     * (accumulate, then drop-oldest) without blocking the read loop or siblings.
     * The `unknown` return (matching StdoutSink) admits void, a promise, or any
     * value.
     */
    write(data: Uint8Array): unknown;
    /** Optional end-of-stream signal, fired exactly once at session end. */
    close?(): void;
}
/** Handle returned by {@link OutputFanout.attach}: detach + drop observability. */
export interface OutputSinkHandle {
    /** Detach this sink, end its pump, and discard its ring. Idempotent. */
    detach(): void;
    /** Total chunks dropped from this sink's ring under back-pressure. */
    dropped(): number;
}
/**
 * Per-sink ring capacity in BYTES (matches recentOutput's 64 KB convention).
 * Bounding by bytes — never by chunk count — keeps memory bounded under large
 * chunks.
 */
export declare const SINK_CAP_BYTES: number;
/**
 * Multiplexes PTY output to N runtime observers. `push` copies each chunk once
 * and enqueues it into every live sink's ring (best-effort, may drop);
 * `attach`/detach manage membership; `close` ends every sink at session end.
 */
export declare class OutputFanout {
    private readonly sinks;
    private closed;
    /** True when at least one observer is attached (the hot-path guard). */
    hasSinks(): boolean;
    /**
     * Attach an observer. Returns an idempotent handle whose detach() removes the
     * sink, ends its pump, and discards its ring. After the fanout has closed
     * (session exit), returns an already-closed handle that delivers nothing.
     */
    attach(sink: OutputSink): OutputSinkHandle;
    /**
     * Enqueue a chunk into every live observer. Zero-observer fast path: when
     * nobody is attached this returns with NO copy and NO allocation, keeping the
     * common (no-observer) session's hot path byte-for-byte unchanged. When
     * observers exist, the chunk is copied ONCE (defending the ring against later
     * mutation of the caller's buffer, since the ring retains it across arbitrary
     * later reads) and the immutable copy is shared into each sink's ring.
     */
    push(data: Uint8Array): void;
    /**
     * End the fanout at session exit: end every observer's pump, DISCARD any
     * still-buffered ring contents (discard-not-flush), fire each sink's close?()
     * exactly once, and refuse future attaches. Idempotent.
     */
    close(): void;
}
//# sourceMappingURL=fanout.d.ts.map