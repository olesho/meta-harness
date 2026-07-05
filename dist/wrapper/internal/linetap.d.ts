export declare class LineSplitter {
    private readonly onLine;
    private buf;
    constructor(onLine: (line: string) => void);
    /**
     * Feed a chunk of raw PTY bytes, emitting every line the chunk completes. The
     * chunk may split a line anywhere; the remainder is held until a later write
     * completes it.
     */
    write(p: Uint8Array): void;
    /**
     * Emit any final unterminated line. Called once after the PTY closes, so a
     * harness that exits without a trailing newline still delivers its last line.
     */
    flush(): void;
}
/**
 * Return a splitter that forwards completed lines to onLine, or null when
 * onLine is null (the tap is disabled). Mirrors Go's nil-*lineSplitter contract:
 * a null splitter is an inert no-op.
 */
export declare function newLineSplitter(onLine: ((line: string) => void) | null): LineSplitter | null;
//# sourceMappingURL=linetap.d.ts.map