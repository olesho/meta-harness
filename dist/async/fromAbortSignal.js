// fromAbortSignal — adapt a DOM AbortSignal into a meta-harness Context.
//
// In-process callers (e.g. the orchestrator) drive cancellation with an AbortSignal, but
// chat.send / chat.acquireControl require a Context. This bridges the two: the
// returned Context cancels (cause = ctxCanceled) when the signal aborts and —
// when a positive deadlineMs is given — auto-cancels (cause =
// ctxDeadlineExceeded) if the deadline elapses first. Whichever fires first
// wins, and the cause is what lets a caller tell a real timeout (→ exit 124)
// apart from an abort.
import { Context, ctxCanceled } from "../internal/async/context.js";
/**
 * Build a Context cancelled by `signal` (cause ctxCanceled) and, when
 * `deadlineMs` is a positive number, also by a deadline (cause
 * ctxDeadlineExceeded). If the signal is already aborted the Context starts
 * cancelled. The abort listener is removed once the Context is done, so a
 * deadline-expiry never leaves a dangling listener on the signal.
 */
export function fromAbortSignal(signal, deadlineMs) {
    const parent = Context.background();
    const { ctx, cancel } = deadlineMs !== undefined && deadlineMs > 0
        ? Context.withDeadline(parent, deadlineMs)
        : Context.withCancel(parent);
    if (signal.aborted) {
        cancel(ctxCanceled);
        return ctx;
    }
    const onAbort = () => cancel(ctxCanceled);
    signal.addEventListener("abort", onAbort, { once: true });
    // Drop the listener once the Context finishes for any reason (e.g. deadline).
    void ctx.done().then(() => signal.removeEventListener("abort", onAbort));
    return ctx;
}
//# sourceMappingURL=fromAbortSignal.js.map