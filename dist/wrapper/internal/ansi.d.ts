/** Strip ANSI/CSI escape sequences, leaving the printable text. */
export declare function stripANSIEscapes(s: string): string;
/**
 * Report whether output contains a cost/quota/rate fingerprint, returning the
 * matched phrase. Returns "" when nothing matched.
 */
export declare function isCostOrQuotaLimited(output: string): string;
//# sourceMappingURL=ansi.d.ts.map