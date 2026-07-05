// Mutex — a simple async mutual-exclusion lock. `lock` resolves once the
// caller holds the lock; `unlock` releases it to the next waiter (FIFO).
export class Mutex {
    _locked = false;
    _waiters = [];
    get locked() {
        return this._locked;
    }
    /** Acquire the lock, awaiting if held. */
    lock() {
        if (!this._locked) {
            this._locked = true;
            return Promise.resolve();
        }
        return new Promise((resolve) => this._waiters.push(resolve));
    }
    /** Release the lock to the next waiter, or mark it free. */
    unlock() {
        const next = this._waiters.shift();
        if (next) {
            next();
            return;
        }
        this._locked = false;
    }
    /** Run `fn` while holding the lock, releasing it even on throw. */
    async withLock(fn) {
        await this.lock();
        try {
            return await fn();
        }
        finally {
            this.unlock();
        }
    }
}
//# sourceMappingURL=mutex.js.map