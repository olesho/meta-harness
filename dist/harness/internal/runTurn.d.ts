import { type Conversation, type Turn, type Session, type HistorySource, type InputPolicy, type InputRequest, type InputAnswer } from "../../chat/index.ts";
import { Context, CausedError, type Sentinel } from "../../internal/async/index.ts";
/** ErrTurnErrored is thrown (as a RunTurnError's cause) when the harness
 * reports that the submitted assistant turn ended in an errored state. The
 * RunTurnError's `.result` carries the errored turn. */
export declare const ErrTurnErrored: Sentinel;
/**
 * Thrown by runTurn when the run ends before a normal ExitAfterTurn/keep-alive
 * return: context cancellation, the event channel closing, an out-of-band
 * adapter error, or the submitted turn reaching TurnStateErrored (cause is
 * then ErrTurnErrored). Carries the best-effort TurnResult snapshot taken at
 * the moment of failure — the TS analogue of Go's (TurnResult, error) double
 * return, since a single throw can't carry both.
 */
export declare class RunTurnError extends CausedError {
    readonly result: TurnResult;
    constructor(message: string, cause: unknown, result: TurnResult);
}
/**
 * TurnConfig configures runTurn, the one-shot interactive-turn entrypoint.
 *
 * runTurn starts an interactive harness, sends Prompt through the PTY, waits
 * for the adapter to report that the assistant turn completed, and then
 * either stops the harness process or returns the live Conversation to the
 * caller.
 */
export interface TurnConfig {
    /** Wrapper harness/profile name ("claude", "codex", "gemini", ...). Also
     * used to pick the chat adapter unless turnHarness is set. */
    harness: string;
    /** Overrides the chat adapter name. Most callers leave this unset. Exists
     * for naming mismatches such as wrapper harness "claude" using chat
     * adapter "claude-code". */
    turnHarness?: string;
    /** The harness executable. Required. */
    binaryPath: string;
    /** Passed verbatim to the harness. For Claude Code this is the normal
     * interactive arg set, not print/headless args. */
    args?: string[];
    workingDir?: string;
    env?: string[];
    /** Execution-mode knobs forwarded to chat.Options. Empty leaves the harness
     * default. */
    effort?: string;
    model?: string;
    /**
     * Launch-time permission posture, forwarded to chat.Options. Rungs least to
     * most permissive: plan, manual, ask, auto, bypass (`ask` is ABOVE `manual` —
     * it auto-accepts edits); claude also accepts acceptEdits / bypassPermissions
     * / dontAsk, codex its read-only / workspace-write / danger-full-access
     * sandbox values. Empty leaves the harness default. When this is a claude
     * `bypass` and `inputPolicy` is absent, chat installs its default
     * trust_prompt→proceed policy so the run is not wedged on the bypass dialog.
     */
    permissionMode?: string;
    /** Submitted as one user message. */
    prompt: string;
    /** Stops the interactive harness after the submitted turn completes or
     * errors. When false, the returned TurnResult.conversation is live and the
     * caller owns closing it. */
    exitAfterTurn?: boolean;
    /** Virtual terminal size. Zero values use chat.Open defaults. */
    cols?: number;
    rows?: number;
    /** Sizes the chat event buffer. Zero uses chat.Open default. */
    eventBuffer?: number;
    /** Pre-resolves blocking interactive prompts so a one-shot run proceeds
     * unattended. */
    inputPolicy?: InputPolicy;
    /** In-process resolver for prompts the policy didn't answer. */
    onInputRequest?: (req: InputRequest) => [InputAnswer, boolean];
}
/** TurnResult is the outcome of a runTurn call. */
export interface TurnResult {
    /** The assistant turn that completed or errored. */
    turn: Turn;
    /** The chat-level session record after the turn. */
    session: Session;
    /** conv.historyWithSource() after the turn (or the store fallback). */
    history: Turn[];
    /** Which of those two paths produced history — len(history) alone can't
     * distinguish them, since the store fallback also returns non-empty arrays. */
    historySource: HistorySource;
    /** True when runTurn intentionally stopped the interactive harness after
     * the submitted turn reached a terminal state. */
    processStoppedAfterTurn: boolean;
    /** Set only when exitAfterTurn is false/omitted. The caller owns the live
     * interactive process and must eventually call close(). */
    conversation?: Conversation;
}
/** runTurn runs one interactive harness turn and resolves when that turn
 * reaches a completed or errored state. */
export declare function runTurn(ctx: Context | undefined, cfg: TurnConfig): Promise<TurnResult>;
//# sourceMappingURL=runTurn.d.ts.map