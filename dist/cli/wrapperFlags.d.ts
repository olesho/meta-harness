/** The parsed form of a `harness-wrapper` invocation. */
export interface HarnessWrapperArgs {
    traceFile: string;
    traceStderr: boolean;
    effort: string;
    model: string;
    /**
     * Requests the wrapper spawn the run inside a detached tmux session named
     * mh-<value> and exit immediately after `tmux new-session -d` succeeds.
     */
    tmuxSession: string;
    /** In-pane re-exec marker; set only by the tmux-spawn parent. */
    tmuxChild: string;
    harnessName: string;
    harnessArgs: string[];
}
/** Renders the frozen flag surface as `--name <type> = "default" : usage` lines, sorted. */
export declare function renderFlagSurface(): string;
/**
 * Splits argv at the required "--" separator, parses wrapper flags + the
 * harness name from the prefix, and returns the harness args verbatim.
 * Mirrors Go's parseHarnessWrapperArgs (flags.go:35-71).
 */
export declare function parseHarnessWrapperArgs(argv: string[]): {
    result: HarnessWrapperArgs | null;
    err: Error | null;
};
//# sourceMappingURL=wrapperFlags.d.ts.map