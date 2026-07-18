// Retention resolution + error aggregation — shared by the local provisioner,
// compose(), and the env() lifecycle engine.
/** Whether a resource is KEPT (not destroyed) for the given retention + outcome.
 *
 *  Contract (design §4):
 *  - `setup-failure` ⇒ ALWAYS destroy (never keep) regardless of retention: a
 *    preflight/apply failure leaves nothing of debugging value.
 *  - `"always"`          ⇒ keep on success and run-failure.
 *  - `"keep-on-failure"` ⇒ keep only on a failed RUN.
 *  - ABSENT              ⇒ destroy on both success and failure (the common case). */
export function shouldKeep(retention, outcome) {
    if (outcome === "setup-failure")
        return false;
    if (retention === "always")
        return true;
    if (retention === "keep-on-failure")
        return outcome === "failure";
    return false;
}
/** An error that aggregates several teardown failures without short-circuiting
 *  (design §4: best-effort, errors aggregated, never short-circuited). Mirrors
 *  the shape of the platform `AggregateError` but carries a stable name and a
 *  readable message so callers can log it directly. */
export class TeardownError extends Error {
    errors;
    constructor(errors, context) {
        const detail = errors
            .map((e) => (e instanceof Error ? e.message : String(e)))
            .join("; ");
        super(context ? `${context}: ${detail}` : detail);
        this.name = "TeardownError";
        this.errors = errors;
    }
}
/** Run every cleanup thunk in order, collecting (never re-throwing) failures.
 *  Returns the collected errors so the caller decides how to surface them. */
export async function runAll(thunks) {
    const errs = [];
    for (const t of thunks) {
        try {
            await t();
        }
        catch (e) {
            errs.push(e);
        }
    }
    return errs;
}
//# sourceMappingURL=retention.js.map