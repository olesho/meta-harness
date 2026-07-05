/** Describes the availability and version state of one harness CLI. */
export interface Info {
    /** The lookup name the caller passed in. */
    name: string;
    /** The canonical harness key from versions.json. Empty when `name` is unknown. */
    harness: string;
    /** The on-PATH executable name actually probed. */
    binary: string;
    /** Absolute path of the binary as resolved on PATH. Empty when not installed. */
    path: string;
    /** Whether `binary` was found on PATH. */
    installed: boolean;
    /** One-line hint shown when `installed` is false. Empty otherwise. */
    installHint: string;
    /** The versions.json `pinned` value; empty for unknown/unpinned harnesses. */
    pinnedVersion: string;
    /** Version parsed from the binary's `--version` output, when a probe ran. */
    detectedVersion: string;
    /**
     * Whether `detectedVersion` equals `pinnedVersion`. True when either is empty
     * — callers must not treat "unknown" as drift.
     */
    versionMatchesPin: boolean;
    /** Human-readable failure reason when a registered probe was attempted but failed. */
    versionProbeError: string;
    /** The versions.json `package` value; empty for unknown harnesses. */
    npmPackage: string;
}
/**
 * Parses a harness binary's version from its `--version` (or equivalent)
 * output. Implementations should be cheap (one subprocess call) and treat
 * parse failures as errors rather than returning the raw output.
 */
export interface Probe {
    detect(binPath: string): string;
}
/**
 * Bounds a single `<binary> --version` invocation. A safety net for a hung
 * binary, not a latency target, so it is set generously: the harness CLIs are
 * node-based and a cold `--version` can take 1-2s just for node to start.
 */
export declare const defaultProbeTimeoutMs = 10000;
/**
 * Associates a version probe with a canonical harness key. Overwrites any
 * prior registration. Throws if `p` is nullish.
 */
export declare function registerProbe(harness: string, p: Probe | null | undefined): void;
export declare function probeFor(harness: string): Probe | undefined;
export declare const _probes: Map<string, Probe>;
/** Clears the version-detection cache. Intended for tests that swap a shim. */
export declare function resetCache(): void;
/**
 * Resolves a name to availability info. The name may be a canonical harness
 * key, a registered binary name, or any other binary name (treated as a raw
 * PATH probe). Throws only for internal failures (e.g. versions.json
 * unreadable); a binary that is simply not on PATH is a normal result with
 * `installed` false.
 */
export declare function lookup(name: string): Info;
/**
 * Returns Info for every harness declared in versions.json. Order is not
 * guaranteed.
 */
export declare function discover(): Info[];
//# sourceMappingURL=discovery.d.ts.map