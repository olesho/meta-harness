/** Network / fetch failure reaching the npm registry. */
export declare const errFetch: import("../internal/async/errors.ts").Sentinel;
/** Response body could not be parsed / lacked the expected version field. */
export declare const errParse: import("../internal/async/errors.ts").Sentinel;
/** Three-state registry-drift status for one harness. */
export type Status = "match" | "drift" | "unpinned";
/** One row of the registry-drift report. */
export interface Row {
    /** Harness name (versions.json key), e.g. "codex". */
    name: string;
    /** npm package name, e.g. "@openai/codex". */
    package: string;
    /** The version pinned in versions.json ("" when unpinned). */
    pinned: string;
    /** npm registry `latest` — undefined for `unpinned` rows (never fetched). */
    latest?: string;
    /** match | drift | unpinned. */
    status: Status;
}
/**
 * Fetch the npm registry `latest` version for a package. Uses ONE code path for
 * both scoped (`@openai/codex`) and bare (`opencode-ai`) names by
 * percent-encoding the whole name — so the `/` in a scope never lands raw in the
 * URL path (which the registry resolves inconsistently and can silently 404,
 * the exact failure that would let a probe error masquerade as match/drift).
 *
 *   PRIMARY  : GET /${encodeURIComponent(pkg)}          → body["dist-tags"].latest
 *   FALLBACK : GET /${encodeURIComponent(pkg)}/latest   → body.version
 *
 * Throws a wrapped `errFetch` on network failure / non-OK status, or a wrapped
 * `errParse` when neither response shape yields a usable version string.
 */
export declare function fetchLatest(pkg: string): Promise<string>;
/**
 * Build one Row for a single harness. Unpinned entries (`pinned === ""`) are
 * reported as `unpinned` WITHOUT ever hitting the network — never as drift.
 */
export declare function checkEntry(name: string, pkg: string, pinned: string): Promise<Row>;
/**
 * Check every harness in the embedded catalog against the npm registry.
 *
 * Returns a Row per harness on success. A fetch/parse failure for ANY package
 * throws the underlying sentinel (errFetch / errParse) — the CLI maps that to
 * exit 1, so a registry outage can never silently read as all-match.
 */
export declare function checkAll(): Promise<Row[]>;
/** True when any row is in the `drift` state. */
export declare function hasDrift(rows: Row[]): boolean;
//# sourceMappingURL=sentry.d.ts.map