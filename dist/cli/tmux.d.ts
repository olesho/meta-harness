import { type HarnessWrapperArgs } from "./wrapperFlags.ts";
/** Prepended to every tmux session name owned by meta-harness-wrapper. */
export declare const TMUX_SESSION_PREFIX = "mh-";
/** Tmux-session env var stashing the trace-file path for attach/status/kill recovery. */
export declare const TRACE_FILE_ENV = "META_HARNESS_TRACE_FILE";
/** Rejects names with characters that would confuse tmux or the filesystem. */
export declare function validSessionName(s: string): boolean;
/** Error when the `tmux` binary is not on PATH (or in a well-known dir). */
export declare function requireTmux(): Error | null;
/**
 * Picks the NDJSON trace path. An explicit --trace-file is used verbatim
 * (absolutized); otherwise falls back to
 * ~/.meta-harness/sessions/<name>.trace.ndjson.
 */
export declare function resolveTracePath(explicit: string, sessionName: string): {
    result: string | null;
    err: Error | null;
};
/**
 * Builds the pane command tmux re-execs: this same entry point in --tmux-child
 * mode, carrying the resolved trace path plus every launch-time knob the parent
 * parsed. Any wrapper flag that shapes the run MUST be forwarded here or a
 * `--tmux-session` invocation silently loses it. Mirrors Go's reexec argv shape
 * (tmux.go:66-90); process.execPath + process.argv[1] stand in for Go's
 * single-binary os.Executable(). Pure and exported so the argv contract is
 * testable without a tmux binary.
 */
export declare function buildReexecArgv(args: HarnessWrapperArgs, tracePath: string): string[];
/**
 * Parent half of `meta-harness-wrapper --tmux-session <name> -- <harness> ...`:
 * resolves the trace path, re-execs this same binary with --tmux-child set
 * inside a detached tmux session, and exits. binPath is not needed here — the
 * in-pane child resolves the harness binary again via start()'s resolvePath()
 * call, in the same environment tmux's child shell will see (mirrors Go's
 * comment at tmux.go:34-37).
 */
export declare function runTmuxSpawn(args: HarnessWrapperArgs): number;
/**
 * `meta-harness-wrapper attach <session>`. Node has no execve, so — unlike
 * Go's syscall.Exec (tmux.go:203) — this leaves an extra Node parent process
 * between the user's terminal and tmux for the lifetime of the attach. This is
 * a genuine, documented divergence (see HARNESS-WRAPPER-3 ticket Risks), not
 * an oversight: stdio:"inherit" still gives the user a normal-feeling
 * attached session, just with one extra process in the tree.
 */
export declare function runTmuxAttach(argv: string[]): number;
/** `meta-harness-wrapper kill <session>`. */
export declare function runTmuxKill(argv: string[]): number;
/** `meta-harness-wrapper list`. Bare session names (without the mh- prefix), sorted. */
export declare function runTmuxList(argv: string[]): number;
/** `meta-harness-wrapper status <session> [--json]`. */
export declare function runTmuxStatus(argv: string[]): number;
//# sourceMappingURL=tmux.d.ts.map