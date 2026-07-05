// The durable line tap's accumulator. It buffers raw PTY bytes across
// read-chunk boundaries and invokes onLine once per complete '\n'-terminated
// line (with any trailing '\r' trimmed). It preserves arbitrarily long lines
// (no cap) and, on flush, emits a final unterminated remainder.
//
// onLine runs synchronously, so delivery is ordered and non-lossy: a slow
// callback back-pressures the caller rather than dropping a line.
const NL = 0x0a; // '\n'
const CR = 0x0d; // '\r'
export class LineSplitter {
    onLine;
    buf = new Uint8Array(0);
    constructor(onLine) {
        this.onLine = onLine;
    }
    /**
     * Feed a chunk of raw PTY bytes, emitting every line the chunk completes. The
     * chunk may split a line anywhere; the remainder is held until a later write
     * completes it.
     */
    write(p) {
        // Concatenate the carried remainder with the new chunk.
        if (this.buf.length === 0) {
            this.buf = p;
        }
        else {
            const merged = new Uint8Array(this.buf.length + p.length);
            merged.set(this.buf, 0);
            merged.set(p, this.buf.length);
            this.buf = merged;
        }
        let start = 0;
        let consumed = false;
        for (;;) {
            const i = this.buf.indexOf(NL, start);
            if (i < 0)
                break;
            let end = i;
            if (end > start && this.buf[end - 1] === CR)
                end--;
            this.onLine(decode(this.buf, start, end));
            start = i + 1;
            consumed = true;
        }
        // Reclaim the consumed prefix so the backing array doesn't grow unbounded.
        if (!consumed) {
            // partial line still accumulating — keep buf as-is.
        }
        else if (start === this.buf.length) {
            this.buf = new Uint8Array(0);
        }
        else {
            this.buf = this.buf.slice(start);
        }
    }
    /**
     * Emit any final unterminated line. Called once after the PTY closes, so a
     * harness that exits without a trailing newline still delivers its last line.
     */
    flush() {
        if (this.buf.length === 0)
            return;
        let end = this.buf.length;
        if (end > 0 && this.buf[end - 1] === CR)
            end--;
        this.onLine(decode(this.buf, 0, end));
        this.buf = new Uint8Array(0);
    }
}
function decode(buf, start, end) {
    return new TextDecoder().decode(buf.subarray(start, end));
}
/**
 * Return a splitter that forwards completed lines to onLine, or null when
 * onLine is null (the tap is disabled). Mirrors Go's nil-*lineSplitter contract:
 * a null splitter is an inert no-op.
 */
export function newLineSplitter(onLine) {
    if (onLine === null)
        return null;
    return new LineSplitter(onLine);
}
//# sourceMappingURL=linetap.js.map