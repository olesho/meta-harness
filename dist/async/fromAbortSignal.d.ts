import { Context } from "../internal/async/context.ts";
/**
 * Build a Context cancelled by `signal` (cause ctxCanceled) and, when
 * `deadlineMs` is a positive number, also by a deadline (cause
 * ctxDeadlineExceeded). If the signal is already aborted the Context starts
 * cancelled. The abort listener is removed once the Context is done, so a
 * deadline-expiry never leaves a dangling listener on the signal.
 */
export declare function fromAbortSignal(signal: AbortSignal, deadlineMs?: number): Context;
//# sourceMappingURL=fromAbortSignal.d.ts.map