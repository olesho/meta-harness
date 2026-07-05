// ControlQueue — a FIFO turnstile. At most one holder at a time; callers
// `acquire` (awaiting their turn in arrival order) and `release` to pass the
// turn on. Distinct from Mutex in that:
//   - acquire() takes a Context and rejects with the ctx error if cancelled
//     while waiting (the waiter is removed from the queue);
//   - a second release() with nothing waiting is a no-op (double-release safe);
//   - once closed, pending and future acquires reject with queueClosed.
import { defineSentinel } from "./errors.js";
export const queueClosed = defineSentinel("control-queue/closed", "control queue closed");
export class ControlQueue {
    _held = false;
    _closed = false;
    _waiters = [];
    get closed() {
        return this._closed;
    }
    /**
     * Acquire the turn. Resolves when held. If `ctx` cancels first, removes this
     * waiter and rejects with ctx.err(). Rejects with queueClosed if closed.
     */
    acquire(ctx) {
        if (this._closed)
            return Promise.reject(queueClosed);
        if (!this._held) {
            this._held = true;
            return Promise.resolve();
        }
        if (ctx.isDone())
            return Promise.reject(ctx.err());
        return new Promise((resolve, reject) => {
            const waiter = { resolve, reject, settled: false };
            this._waiters.push(waiter);
            ctx.done().then(() => {
                if (waiter.settled)
                    return;
                waiter.settled = true;
                const i = this._waiters.indexOf(waiter);
                if (i >= 0)
                    this._waiters.splice(i, 1);
                reject(ctx.err());
            });
        });
    }
    /** Pass the turn to the next waiter. A release with no holder is a no-op. */
    release() {
        if (!this._held)
            return;
        let next = this._waiters.shift();
        while (next && next.settled)
            next = this._waiters.shift();
        if (next) {
            next.settled = true;
            next.resolve();
            // _held stays true: the turn transferred to `next`.
            return;
        }
        this._held = false;
    }
    /** Close the queue: reject all waiters and all future acquires. */
    close() {
        if (this._closed)
            return;
        this._closed = true;
        for (const w of this._waiters.splice(0)) {
            if (w.settled)
                continue;
            w.settled = true;
            w.reject(queueClosed);
        }
    }
}
//# sourceMappingURL=controlQueue.js.map