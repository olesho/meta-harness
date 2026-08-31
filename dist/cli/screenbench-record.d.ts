#!/usr/bin/env node
export declare const ExitOK = 0;
export declare const ExitError = 1;
export declare const ExitUsage = 2;
interface InterruptSpec {
    /** Streaming-phase anchor: the busy footer shown only while a turn is in flight. */
    busyMarker: string;
    /** A second anchor that must co-occur so the ESC lands mid-reply, not mid-think. */
    streamingMarker: string;
    /** The interrupt keystroke. */
    key: Uint8Array;
    /** The text confirming the interrupt landed. */
    confirmText: string;
}
export declare const interruptSpecs: Record<string, InterruptSpec>;
interface DialogSpec {
    /** Any one of these on the settled frame means the dialog is up. */
    anchors: string[];
    /** Human name used in error/progress text. */
    what: string;
}
export declare const dialogSpecs: Record<string, DialogSpec>;
interface Scenario {
    prompts: string[];
    /** Interrupt the (single) prompt's reply once streaming is visible. */
    interrupt?: boolean;
    /** Terminal state is a blocking dialog, not a TurnComplete. See dialogSpecs. */
    dialog?: boolean;
    /**
     * The recording requires a directory the harness has NOT yet been trusted in.
     * Suppresses the trust-accepting warmup pass and mints a unique cwd.
     */
    freshWorkdir?: boolean;
    notes: string;
    setup?: (cwd: string) => void;
}
export declare const scenarios: Record<string, Scenario>;
export interface ParsedArgs {
    harness: string;
    out: string;
    scenario: string;
    bin: string;
    cwd: string;
    cols: number;
    rows: number;
    binaryVersion: string;
    notes: string;
    help?: boolean;
    error?: string;
}
export declare function parseArgs(argv: string[]): ParsedArgs;
/**
 * normalizeVersion extracts the bare version token from a raw `--version` line.
 * A real harness prints more than the semver (e.g. "2.1.201 (Claude Code)")
 * while the manifest pin is the bare "2.1.201", so meta.json records — and the
 * --binary-version cross-check compares against — the FIRST whitespace token.
 */
export declare function normalizeVersion(raw: string): string;
/**
 * claudeTrustState reports whether claude has already recorded an accepted
 * trust decision for `dir`. Returns null when the config cannot be read — an
 * unreadable config is NOT evidence of trust, so the caller proceeds with a
 * warning rather than blocking a legitimate recording.
 *
 * `configPath` is normally `~/.claude.json`; the caller resolves the TEST-ONLY
 * META_HARNESS_CLAUDE_CONFIG override.
 */
export declare function claudeTrustState(dir: string, configPath: string): boolean | null;
export declare function main(argv: string[]): Promise<number>;
export {};
//# sourceMappingURL=screenbench-record.d.ts.map