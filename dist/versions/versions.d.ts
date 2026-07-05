/** Describes one harness's pinned upstream binding. */
export interface Entry {
    /** The npm package name (e.g. "@openai/codex"). Required. */
    package: string;
    /** The on-PATH executable name installed by `package` (e.g. "claude"). Required. */
    binary: string;
    /** The upstream version our adapter is verified against. Empty = not verified. */
    pinned: string;
    /** YYYY-MM-DD date when `pinned` was confirmed. Empty when `pinned` is empty. */
    verifiedAt: string;
}
export declare const errEmptyPackage: import("../internal/async/errors.ts").Sentinel;
export declare const errEmptyBinary: import("../internal/async/errors.ts").Sentinel;
export declare const errVerifiedAtWithoutPinned: import("../internal/async/errors.ts").Sentinel;
export declare const errParse: import("../internal/async/errors.ts").Sentinel;
export declare const errRead: import("../internal/async/errors.ts").Sentinel;
/**
 * Returns every harness entry, keyed by harness name. The data is embedded
 * into the package at load time, so the call works from any working directory.
 */
export declare function all(): Map<string, Entry>;
/**
 * Returns the pinned upstream version for a harness as `[version, true]`, or
 * `["", false]` if the harness has no entry or its pin is empty.
 */
export declare function pinned(harness: string): [string, boolean];
/**
 * Reads a versions.json at an explicit path. Useful for tests and tooling that
 * operate on a different versions.json (e.g. the corpus rebake pipeline).
 */
export declare function readFrom(path: string): Map<string, Entry>;
//# sourceMappingURL=versions.d.ts.map