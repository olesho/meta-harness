/** The Go-parity CLI harness names, minus gemini. Sorted for a stable error message. */
export declare const SUPPORTED_HARNESSES: readonly string[];
/** Config.harness / Config.binaryPath for a validated harness name. */
export interface ResolvedHarness {
    harness: string;
    binaryPath: string;
}
/**
 * Validates name against the CLI-facing allow-list. Returns the pass-through
 * Config.harness/Config.binaryPath pair on success, or an error listing the
 * supported names (mirrors Go's resolveHarness "unsupported harness" message,
 * harness_resolver.go:32-42) — but leaves the binary-path lookup itself to
 * start()'s resolvePath() call.
 */
export declare function assertSupportedHarness(name: string): {
    result: ResolvedHarness | null;
    err: Error | null;
};
//# sourceMappingURL=harnessResolver.d.ts.map