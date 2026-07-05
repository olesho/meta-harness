/** A stable, package-level sentinel error identified by a unique `code`. */
export declare class Sentinel extends Error {
    readonly code: string;
    constructor(code: string, message?: string);
}
/** Construct a sentinel. Create one module-level instance per error kind. */
export declare function defineSentinel(code: string, message?: string): Sentinel;
/**
 * An Error subclass that wraps an underlying `cause` (which may itself be a
 * CausedError, a Sentinel, or any Error), forming a chain.
 */
export declare class CausedError extends Error {
    readonly cause?: unknown;
    constructor(message: string, cause?: unknown);
}
/** Wrap a cause with a contextual message, preserving the chain. */
export declare function wrap(message: string, cause: unknown): CausedError;
/**
 * Walk the `cause` chain of `err` and report whether any link matches
 * `sentinel` — either by object identity or by equal `code` string. This is
 * the analogue of Go's `errors.Is(err, sentinel)`.
 */
export declare function isSentinel(err: unknown, sentinel: Sentinel): boolean;
//# sourceMappingURL=errors.d.ts.map