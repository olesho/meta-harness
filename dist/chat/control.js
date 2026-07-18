// controlQueue — a FIFO turnstile, the TS port of pkg/chat/control.go.
//
// acquire resolves with a release function when the queue grants the caller the
// token. Waiters are served first-come, first-served. If the context cancels
// before the token is granted, acquire rejects with ctx.err() and the waiter is
// removed. release is safe to call multiple times; only the first has effect.
// After close, acquire rejects with ErrClosed.
import { ErrClosed } from "./errors.js";
export class ControlQueue {
    _held = false;
    _closed = false;
    queue = [];
    /** Acquire blocks until the token is granted or ctx cancels. */
    async acquire(ctx) {
        if (this._closed)
            throw ErrClosed;
        if (!this._held) {
            this._held = true;
            return this.releaseFunc();
        }
        const waiter = {
            resolve: () => { },
            reject: () => { },
            granted: false,
            removed: false,
        };
        const granted = new Promise((resolve, reject) => {
            waiter.resolve = resolve;
            waiter.reject = reject;
        });
        this.queue.push(waiter);
        const cancelled = ctx.done().then(() => "cancel");
        const won = granted.then(() => "grant");
        const outcome = await Promise.race([won, cancelled]);
        if (outcome === "grant") {
            return this.releaseFunc();
        }
        // ctx cancelled. We may have been granted just as ctx cancelled.
        if (waiter.granted) {
            // Token already handed to us — pass it straight on.
            this.releaseFunc()();
            throw ctx.err();
        }
        // Not yet granted — remove from queue and bail.
        waiter.removed = true;
        const i = this.queue.indexOf(waiter);
        if (i >= 0)
            this.queue.splice(i, 1);
        throw ctx.err();
    }
    /** Held reports whether some caller currently holds the token. */
    held() {
        return this._held;
    }
    /** Close marks the queue closed; subsequent acquires reject with ErrClosed. */
    close() {
        this._closed = true;
    }
    releaseFunc() {
        let done = false;
        return () => {
            if (done)
                return;
            done = true;
            if (!this._held)
                return;
            let next = this.queue.shift();
            while (next?.removed)
                next = this.queue.shift();
            if (!next) {
                this._held = false;
                return;
            }
            next.granted = true;
            next.resolve();
            // _held stays true: ownership transfers to next.
        };
    }
}
export function newControlQueue() {
    return new ControlQueue();
}
//# sourceMappingURL=control.js.map