// SSE wire helper for the meta-harness-chatd daemon.
//
// Ports the streaming half of Go `cmd/harness-chatd/server.go`'s
// `streamEvents`: given a Node `http.ServerResponse`, a `Fanout` Subscription,
// and a cancellation signal, it writes the `text/event-stream` headers, emits
// each event as a `data: <JSON>\n\n` frame, and a `: ping\n\n` heartbeat every
// 15s. It tears the subscription down and stops the heartbeat when the response
// or request closes, or when the stop signal fires.
//
// Node's `ServerResponse` has NO `http.Flusher`: `write()` flushes by default
// and this daemon runs no compression middleware, so there is nothing to
// reproduce from Go's `flusher.Flush()` calls.
/** Registers `cb` to run once when `sig` fires. No-op if `sig` is undefined. */
export function onStop(sig, cb) {
    if (!sig)
        return;
    if (typeof sig === "function") {
        sig(cb);
        return;
    }
    if (typeof sig.then === "function") {
        ;
        sig.then(cb, cb);
        return;
    }
    const signal = sig;
    if (signal.aborted) {
        cb();
        return;
    }
    signal.addEventListener("abort", cb, { once: true });
}
const DEFAULT_HEARTBEAT_MS = 15_000;
const SSE_HEADERS = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    // Defeat proxy buffering (e.g. nginx) so frames flush immediately.
    "X-Accel-Buffering": "no",
};
/**
 * Stream a Fanout subscription to an SSE response until the subscription ends
 * or a stop condition fires (`res`/`req` `'close'`, or `opts.signal`). Writes
 * headers, per-event `data:` frames, and periodic `: ping` heartbeats. Always
 * unsubscribes and clears the heartbeat on teardown.
 *
 * Resolves when streaming has fully stopped.
 */
export async function streamSSE(res, sub, opts = {}) {
    const encode = opts.encode ?? ((ev) => JSON.stringify(ev));
    const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    res.writeHead(200, SSE_HEADERS);
    let stopped = false;
    let heartbeat;
    const teardown = () => {
        if (stopped)
            return;
        stopped = true;
        if (heartbeat !== undefined)
            clearInterval(heartbeat);
        // Ends the subscription's async iterator, which unblocks the loop below.
        sub.unsubscribe();
    };
    res.on("close", teardown);
    if (opts.req)
        opts.req.on("close", teardown);
    onStop(opts.signal, teardown);
    heartbeat = setInterval(() => {
        if (stopped)
            return;
        try {
            res.write(": ping\n\n");
        }
        catch {
            teardown();
        }
    }, heartbeatMs);
    heartbeat.unref?.();
    try {
        for (;;) {
            const { value, ok } = await sub.receive();
            if (!ok)
                break;
            if (stopped)
                break;
            try {
                res.write(`data: ${encode(value)}\n\n`);
            }
            catch {
                break;
            }
        }
    }
    finally {
        teardown();
    }
}
//# sourceMappingURL=sse.js.map