// Watcher composes a wrapper session, a Screen, and an Adapter into a single
// async stream of turn Events. Port of pkg/turns/watcher.go, adapted to
// JavaScript async iteration (the Go version uses goroutines + channels).
//
// Two pumps run concurrently:
//   1. wrapper session events → adapter.onWrapperStatus
//   2. screen subscription   → adapter.onScreen
// The events stream ends after both the session terminates AND close() is
// called.
export class Watcher {
    queue = [];
    waiter = null;
    pumpsRunning = 0;
    closed = false;
    finished = false;
    onClose = null;
    constructor(sess, scr, adapter) {
        // Pump 1: wrapper session events → adapter.onWrapperStatus.
        if (sess) {
            this.pumpsRunning++;
            void (async () => {
                try {
                    for await (const ev of sess.events()) {
                        for (const te of adapter.onWrapperStatus(ev.status, ev.reason)) {
                            if (te.at === undefined)
                                te.at = ev.at;
                            if (te.httpCode === undefined)
                                te.httpCode = ev.httpCode;
                            if (te.retryAfter === undefined)
                                te.retryAfter = ev.retryAfter;
                            this.send(te);
                        }
                        if (ev.terminated)
                            break;
                    }
                }
                finally {
                    this.pumpDone();
                }
            })();
        }
        // Pump 2: screen subscription → adapter.onScreen.
        if (scr) {
            const [notify, unsubscribe] = scr.subscribe();
            this.pumpsRunning++;
            const closePromise = new Promise((resolve) => {
                this.onClose = resolve;
            });
            void (async () => {
                try {
                    for (;;) {
                        const r = await Promise.race([
                            notify.receive(),
                            closePromise.then(() => ({ ok: false, closed: true })),
                        ]);
                        if (!("ok" in r) || !r.ok)
                            return;
                        const snap = scr.snapshot();
                        for (const te of adapter.onScreen(snap)) {
                            if (te.at === undefined)
                                te.at = new Date();
                            if (te.snap === undefined)
                                te.snap = snap;
                            this.send(te);
                        }
                    }
                }
                finally {
                    unsubscribe();
                    this.pumpDone();
                }
            })();
        }
        if (this.pumpsRunning === 0)
            this.finished = true;
    }
    /** The async stream of turn events; ends once both sources stop. */
    async *events() {
        for (;;) {
            if (this.queue.length > 0) {
                yield this.queue.shift();
                continue;
            }
            if (this.finished)
                return;
            const next = await new Promise((resolve) => {
                this.waiter = resolve;
            });
            if (next.done)
                return;
            yield next.value;
        }
    }
    /** Signals the screen pump to stop. Does not stop the session. Idempotent. */
    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.onClose?.();
    }
    send(ev) {
        if (this.waiter) {
            const w = this.waiter;
            this.waiter = null;
            w({ done: false, value: ev });
            return;
        }
        this.queue.push(ev);
    }
    pumpDone() {
        this.pumpsRunning--;
        if (this.pumpsRunning <= 0) {
            this.finished = true;
            if (this.waiter) {
                const w = this.waiter;
                this.waiter = null;
                w({ done: true, value: undefined });
            }
        }
    }
}
/** Starts a Watcher. Pass null for scr to skip screen-derived signals. */
export function Watch(sess, scr, adapter) {
    return new Watcher(sess, scr, adapter);
}
//# sourceMappingURL=watcher.js.map