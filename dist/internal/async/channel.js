// Channel<T> — a buffered, closeable async queue modeled on Go channels.
//
// `send` resolves once the value is buffered (or rejects if the channel is
// closed). `receive` resolves to { value, ok } where ok=false signals the
// channel was closed and drained. Buffer capacity bounds in-flight values;
// senders block (await) when the buffer is full until a receiver makes room.
import { defineSentinel } from "./errors.js";
export const chanClosed = defineSentinel("channel/closed", "send on closed channel");
export class Channel {
    _capacity;
    _buffer = [];
    _recvWaiters = [];
    _sendWaiters = [];
    _closed = false;
    constructor(_capacity = 0) {
        this._capacity = _capacity;
    }
    get closed() {
        return this._closed;
    }
    /** Buffer a value, awaiting room if the buffer is full. Rejects if closed. */
    async send(value) {
        if (this._closed)
            throw chanClosed;
        // Hand directly to a waiting receiver.
        const recv = this._recvWaiters.shift();
        if (recv) {
            recv({ value, ok: true });
            return;
        }
        if (this._buffer.length < this._capacity) {
            this._buffer.push(value);
            return;
        }
        // Full buffer (or unbuffered with no receiver): block until drained.
        await new Promise((resolve, reject) => {
            this._sendWaiters.push({ value, resolve: () => resolve() });
            // If closed while waiting, the close() call rejects below.
            this._rejectOnClose.push(reject);
        });
    }
    _rejectOnClose = [];
    /** Receive the next value. Resolves { ok:false } when closed and drained. */
    receive() {
        if (this._buffer.length > 0) {
            const value = this._buffer.shift();
            // A blocked sender may now proceed into the freed slot.
            const pending = this._sendWaiters.shift();
            if (pending) {
                this._buffer.push(pending.value);
                this._rejectOnClose.shift();
                pending.resolve();
            }
            return Promise.resolve({ value, ok: true });
        }
        // No buffered values: pair with a blocked sender directly.
        const pending = this._sendWaiters.shift();
        if (pending) {
            this._rejectOnClose.shift();
            pending.resolve();
            return Promise.resolve({ value: pending.value, ok: true });
        }
        if (this._closed)
            return Promise.resolve({ value: undefined, ok: false });
        return new Promise((resolve) => {
            this._recvWaiters.push(resolve);
        });
    }
    /** Close the channel. Pending receivers drain; pending senders reject. */
    close() {
        if (this._closed)
            return;
        this._closed = true;
        for (const r of this._recvWaiters.splice(0)) {
            r({ value: undefined, ok: false });
        }
        for (const reject of this._rejectOnClose.splice(0))
            reject(chanClosed);
        this._sendWaiters.splice(0);
    }
    /** Async-iterate received values until the channel is closed and drained. */
    async *[Symbol.asyncIterator]() {
        while (true) {
            const { value, ok } = await this.receive();
            if (!ok)
                return;
            yield value;
        }
    }
}
//# sourceMappingURL=channel.js.map