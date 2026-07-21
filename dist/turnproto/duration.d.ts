/** Default one-shot deadline when HARNESS_WRAPPER_RUN_TIMEOUT is unset (Go: 15m). */
export declare const DEFAULT_RUN_TIMEOUT_MS: number;
/** parseTimeoutMs reads a HARNESS_WRAPPER_RUN_TIMEOUT value (Go duration) → ms. */
export declare function parseTimeoutMs(raw: string | undefined, defaultMs?: number): number;
/** parseGoDuration parses a subset of Go durations ("15m", "90s", "1h30m", "500ms"). */
export declare function parseGoDuration(s: string): number | null;
//# sourceMappingURL=duration.d.ts.map