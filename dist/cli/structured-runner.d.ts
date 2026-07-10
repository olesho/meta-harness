#!/usr/bin/env node
export { ExitOK, ExitError, ExitUsage, ExitDeadline, DeadlineLine, } from "../turnproto/index.ts";
export declare function resolveHarnessName(name: string): "claude-code" | "codex" | null;
export interface StructuredArgs {
    help?: boolean;
    error?: string;
    name?: string;
    promptFile?: string;
    effort?: string;
    model?: string;
    harnessArgs: string[];
}
/**
 * parseStructuredArgs — flags (--prompt-file/--effort/--model) precede <name>;
 * <name> is the first non-flag token; a `--` separator forwards the remainder to
 * the harness. The prompt is NEVER an argument (only --prompt-file), so a prompt
 * with quotes/newlines/leading-dashes can't corrupt the argv or the shell.
 */
export declare function parseStructuredArgs(argv: string[]): StructuredArgs;
/** readTranscript reads the harness's on-disk session and maps to the public DTO. */
export declare function readTranscript(harness: string, harnessSessionID: string, workingDir: string): Array<Record<string, unknown>>;
/** readUsage reads the session's token totals; null when none recorded. */
export declare function readUsage(harness: string, harnessSessionID: string, workingDir: string): Record<string, number> | null;
export declare function main(argv: string[]): Promise<number>;
//# sourceMappingURL=structured-runner.d.ts.map