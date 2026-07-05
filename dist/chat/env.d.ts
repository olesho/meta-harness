/** True for CLAUDECODE and any CLAUDE_CODE_* variable (the nesting markers). */
export declare function isClaudeNestingEnvKey(key: string): boolean;
/**
 * Return env (as "KEY=VALUE" entries) with Claude Code's nesting markers
 * removed. When `env` is undefined/null the current process environment is
 * materialized and cleaned — mirroring the Go cleanedEnv(), which reads
 * os.Environ(). Materializing is load-bearing: a PTY child inherits the parent
 * environment when no explicit env is passed, so the only way to strip an
 * inherited marker is to hand the child an explicit, cleaned env.
 */
export declare function cleanHarnessEnv(env?: string[] | null): string[];
//# sourceMappingURL=env.d.ts.map