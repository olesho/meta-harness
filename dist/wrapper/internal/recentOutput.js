// A bounded ring of the most recent raw PTY bytes. The built-in classifier and
// Session.RecentOutput both read this snapshot. Mirrors Go's recentOutputBuffer:
// keep at most `limit` bytes, dropping the oldest when full.
export class RecentOutputBuffer {
    limit;
    buf = new Uint8Array(0);
    constructor(limit) {
        this.limit = limit;
    }
    write(p) {
        if (this.limit <= 0 || p.length === 0)
            return;
        if (p.length >= this.limit) {
            this.buf = p.slice(p.length - this.limit);
            return;
        }
        const merged = new Uint8Array(this.buf.length + p.length);
        merged.set(this.buf, 0);
        merged.set(p, this.buf.length);
        const over = merged.length - this.limit;
        this.buf = over > 0 ? merged.slice(over) : merged;
    }
    string() {
        return new TextDecoder().decode(this.buf);
    }
}
export function newRecentOutput(limit) {
    return new RecentOutputBuffer(limit);
}
//# sourceMappingURL=recentOutput.js.map