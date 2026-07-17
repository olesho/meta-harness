export declare const EnvSpool = "HW_EVENT_SPOOL";
export declare const EnvHookCwd = "HW_HOOK_CWD";
export declare const EnvHome = "HW_HOME";
export declare const EnvYieldFile = "HW_YIELD_FILE";
/**
 * YieldControl allocates a private yield file under a fresh temp dir. The caller
 * owns the lifecycle and should `close()` it when the run is done. It is safe to
 * construct before the run and call `request`/`clear` while the run is in flight
 * (single filesystem ops).
 */
export declare class YieldControl {
    private readonly dir;
    private readonly path;
    constructor();
    /**
     * request signals a yield: the next tool the harness attempts is blocked, with
     * `reason` surfaced in the block message. Idempotent (re-requesting overwrites
     * the reason). Written atomically (temp file + rename) so the guard never reads
     * a partial file.
     */
    request(reason: string): void;
    /** filePath is the yield file's path (wired into the harness env as HW_YIELD_FILE). */
    filePath(): string;
    /** clear cancels a pending yield (removes the file). A nonexistent file is fine. */
    clear(): void;
    /** close removes the yield file and its temp dir. Safe to call more than once. */
    close(): void;
}
/**
 * YieldOutcome directs the caller to BLOCK the tool: print `blockOutput` to
 * stdout and exit with the non-zero code the harness interprets as "block"
 * (Claude/Gemini: exit 2). The zero value ({ block: false }) means proceed.
 */
export interface YieldOutcome {
    block: boolean;
    blockOutput: string;
}
/**
 * checkYield inspects the yield file and, if a yield was requested, returns a
 * blocking outcome carrying the harness's block-decision JSON. The protocol
 * (decision:block + exit 2) is the shared Claude/Gemini shell-hook contract. No
 * file (or empty path) ⇒ no block ⇒ the tool proceeds.
 */
export declare function checkYield(yieldFile: string): YieldOutcome;
/**
 * hookEnv augments the harness launch env array with the HW_* hook variables
 * (spool dir, hook cwd, home, and — when a YieldControl is present — the yield
 * file path). `base` is a "KEY=VALUE" string array (the env convention src/chat
 * uses); when null it is materialized from the current process environment.
 */
export declare function hookEnv(base: string[] | null, spoolDir: string, cwd: string, yieldControl?: YieldControl | null): string[];
//# sourceMappingURL=yield.d.ts.map