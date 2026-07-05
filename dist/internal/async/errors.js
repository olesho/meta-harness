// Error-cause toolkit — the TS analogue of Go's sentinel errors + errors.Is.
//
// A Sentinel is a stable, identity-comparable error object carrying a unique
// `code` string. CausedError is an Error subclass that carries a `cause` chain.
// `isSentinel` walks the `Error.cause` chain matching by `code`, the way
// Go's errors.Is walks the wrapped-error chain.
/** A stable, package-level sentinel error identified by a unique `code`. */
export class Sentinel extends Error {
    code;
    constructor(code, message) {
        super(message ?? code);
        this.name = "Sentinel";
        this.code = code;
    }
}
/** Construct a sentinel. Create one module-level instance per error kind. */
export function defineSentinel(code, message) {
    return new Sentinel(code, message);
}
/**
 * An Error subclass that wraps an underlying `cause` (which may itself be a
 * CausedError, a Sentinel, or any Error), forming a chain.
 */
export class CausedError extends Error {
    // `cause` is standard on Error, but we re-declare for clarity/typing.
    cause;
    constructor(message, cause) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = "CausedError";
        this.cause = cause;
    }
}
/** Wrap a cause with a contextual message, preserving the chain. */
export function wrap(message, cause) {
    return new CausedError(message, cause);
}
function codeOf(err) {
    if (err && typeof err === "object" && "code" in err) {
        const c = err.code;
        if (typeof c === "string")
            return c;
    }
    return undefined;
}
/**
 * Walk the `cause` chain of `err` and report whether any link matches
 * `sentinel` — either by object identity or by equal `code` string. This is
 * the analogue of Go's `errors.Is(err, sentinel)`.
 */
export function isSentinel(err, sentinel) {
    const seen = new Set();
    let cur = err;
    while (cur && typeof cur === "object" && !seen.has(cur)) {
        seen.add(cur);
        if (cur === sentinel)
            return true;
        if (codeOf(cur) === sentinel.code)
            return true;
        cur = cur.cause;
    }
    return false;
}
//# sourceMappingURL=errors.js.map