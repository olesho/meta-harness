#!/usr/bin/env node
export { ExitOK, ExitError, ExitUsage, ExitDeadline, DeadlineLine, parseTimeoutMs, parseGoDuration, } from "../turnproto/index.ts";
/** Maps a CLI short name to the chat adapter (harness) name. */
export declare function resolveHarnessName(name: string): string | null;
export interface ParsedArgs {
    help?: boolean;
    effort?: string;
    model?: string;
    /** Launch-time permission mode (plan|manual|ask|auto|bypass); unset injects nothing. */
    permissionMode?: string;
    /** Raw <name> token (pre-resolution). */
    name?: string;
    /** Args after `--`, forwarded to the harness. */
    harnessArgs: string[];
    /** Set when the grammar is violated (message for stderr). */
    error?: string;
}
/**
 * parseArgs implements the grammar. Flags (--effort/--model/--permission-mode) must precede <name>;
 * <name> is the first non-flag token; a `--` separator ends CLI parsing and the
 * remainder is forwarded to the harness.
 */
export declare function parseArgs(argv: string[]): ParsedArgs;
export declare function main(argv: string[]): Promise<number>;
//# sourceMappingURL=run.d.ts.map