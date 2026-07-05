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
    receive(): Promise<{
        ok: boolean;
    }>;
}
/**
 * Wraps a vt100 emulator with change-notification fan-out. All methods are safe
 * for concurrent (interleaved-async) use.
 */
export declare class Screen {
    private readonly term;
    private readonly mu;
    private gen;
    private readonly subs;
    /**
     * Construct a Screen of the given dimensions. Cols and rows must be > 0;
     * defaults of 120x40 are applied to non-positive inputs to make tests and
     * quick experiments forgiving.
     */
    constructor(cols: number, rows: number);
    /**
     * Feed raw PTY bytes (ANSI escapes intact) into the emulator. On success it
     * bumps generation and signals every subscriber. Writes are serialized so the
     * generation counter is exact under concurrency.
     */
    write(data: string | Uint8Array): Promise<void>;
    /** A coherent point-in-time view of the emulated screen. */
    snapshot(): Snapshot;
    /** The current write counter without rendering a snapshot. */
    generation(): number;
    /**
     * Change the terminal dimensions. Existing screen content is preserved as
     * best the emulator allows.
     */
    resize(cols: number, rows: number): void;
    /**
     * Return a coalesced (size-1) notification channel that signals after every
     * successful write/resize, plus an unsubscribe function that removes and
     * closes the channel.
     */
    subscribe(): [Notify, () => void];
    private notify;
}
/** Construct a Screen of the given dimensions (mirrors Go's `screen.New`). */
export declare function newScreen(cols: number, rows: number): Screen;
//# sourceMappingURL=screen.d.ts.map