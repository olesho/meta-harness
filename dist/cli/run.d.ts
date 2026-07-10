#!/usr/bin/env node
export { ExitOK, ExitError, ExitUsage, ExitDeadline, DeadlineLine, } from "../turnproto/index.ts";
/** Maps a CLI short name to the chat adapter (harness) name. */
export declare function resolveHarnessName(name: string): string | null;
export interface ParsedArgs {
    help?: boolean;
    effort?: string;
    model?: string;
    /** Raw <name> token (pre-resolution). */
    name?: string;
    /** Args after `--`, forwarded to the harness. */
    harnessArgs: string[];
    /** Set when the grammar is violated (message for stderr). */
    error?: string;
}
/**
 * parseArgs implements the grammar. Flags (--effort/--model) must precede <name>;
 * <name> is the first non-flag token; a `--` separator ends CLI parsing and the
 * remainder is forwarded to the harness.
 */
export declare function parseArgs(argv: string[]): ParsedArgs;
/** parseTimeout reads HARNESS_WRAPPER_RUN_TIMEOUT (Go duration) → ms; default 15m. */
export declare function parseTimeoutMs(raw: string | undefined): number;
/** parseGoDuration parses a subset of Go durations ("15m", "90s", "1h30m", "500ms"). */
export declare function parseGoDuration(s: string): number | null;
export declare function main(argv: string[]): Promise<number>;
//# sourceMappingURL=run.d.ts.map