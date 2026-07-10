import type { Outcome, Retention } from "./types.ts";
/** Whether a resource is KEPT (not destroyed) for the given retention + outcome.
 *
 *  Contract (design §4):
 *  - `setup-failure` ⇒ ALWAYS destroy (never keep) regardless of retention: a
 *    preflight/apply failure leaves nothing of debugging value.
 *  - `"always"`          ⇒ keep on success and run-failure.
 *  - `"keep-on-failure"` ⇒ keep only on a failed RUN.
 *  - ABSENT              ⇒ destroy on both success and failure (the common case). */
export declare function shouldKeep(retention: Retention | undefined, outcome: Outcome): boolean;
/** An error that aggregates several teardown failures without short-circuiting
 *  (design §4: best-effort, errors aggregated, never short-circuited). Mirrors
 *  the shape of the platform `AggregateError` but carries a stable name and a
 *  readable message so callers can log it directly. */
export declare class TeardownError extends Error {
    readonly errors: unknown[];
    constructor(errors: unknown[], context?: string);
}
/** Run every cleanup thunk in order, collecting (never re-throwing) failures.
 *  Returns the collected errors so the caller decides how to surface them. */
export declare function runAll(thunks: Array<() => Promise<void>>): Promise<unknown[]>;
//# sourceMappingURL=retention.d.ts.map