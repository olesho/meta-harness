import { type InputPolicy } from "../chat/index.ts";
import { Context } from "../internal/async/index.ts";
import type { AcquisitionMode, Adapter } from "../turns/index.ts";
import type { EventEnvelope } from "../transcript/index.ts";
import type { YieldControl } from "../acquisition/internal/yield.ts";
import type { StreamVersionPredicate } from "../acquisition/internal/planAcquisition.ts";
/** Config for a single one-shot turn. `harness` is the adapter name (e.g. "claude-code", "codex"). */
export interface OneShotConfig {
    harness: string;
    binaryPath: string;
    prompt: string;
    args?: string[];
    workingDir?: string;
    env?: string[];
    effort?: string;
    model?: string;
    /** Terminal geometry; defaults match chat.Open (120x40). */
    cols?: number;
    rows?: number;
    /** Test-only idle-completion window override (ms). Zero/undefined = package default. */
    idleGap?: number;
    /** Test-only marker-confirm window override (ms). Zero/undefined = package default. */
    markerGap?: number;
    /** REQUESTED acquisition mode; planAcquisition latches it against the adapter. Absent ⇒ Off. */
    acquisitionMode?: AcquisitionMode;
    /** Acquisition event sink. Its presence is the sink gate (Go's `haveSink`); absent ⇒ plan degrades to Off. */
    onAcquisitionEvent?: (env: EventEnvelope) => void;
    /** Best-effort per-line display callback (bounded, may drop under back-pressure). */
    onDisplayLine?: (line: string) => void;
    /** Caller-supplied cooperative-preemption handle wired into the launch env (hookEnv). */
    yieldControl?: YieldControl;
    /** Hook spool dir wired into the launch env (HW_EVENT_SPOOL) for Hooks mode. */
    spoolDir?: string;
    /** Advanced/testing seam: use this already-resolved adapter instead of resolving from `harness`. */
    adapter?: Adapter;
    /** Advanced/testing seam: overrides planAcquisition's fact-3 version predicate. */
    streamVersionPredicate?: StreamVersionPredicate;
}
/** Thrown when the run's deadline (or an ancestor deadline) fired before completion. */
export declare class DeadlineError extends Error {
    constructor(message?: string);
}
/** Thrown when the assistant turn reached a terminal ERRORED state. */
export declare class TurnErroredError extends Error {
    readonly reason: string;
    constructor(reason: string);
}
/** Thrown when the prompt is empty (nothing to submit). */
export declare class EmptyPromptError extends Error {
    constructor();
}
/**
 * AutoAcceptTrust — the input policy the one-shot loop installs. It answers the
 * claude-code folder-trust / bypass startup dialog with its "proceed" option so
 * an unattended turn is never wedged behind a trust prompt. Mirrors the Go
 * run.go one-shot `AUTO_ACCEPT_TRUST` input policy.
 */
export declare const AutoAcceptTrust: InputPolicy;
/** Environment keys that leak the outer Claude Code session into the child harness. */
export declare function isLeakedClaudeEnv(key: string): boolean;
/**
 * cleanEnv returns `env` (KEY=VALUE strings) with the CLAUDECODE / CLAUDE_CODE_*
 * variables stripped, so a nested harness process does not inherit the outer
 * Claude Code session context. Mirrors the Go run.go env scrub.
 */
export declare function cleanEnv(env: string[]): string[];
/**
 * runOneShot opens a harness, submits `cfg.prompt`, and resolves with the clean
 * reply text of the single assistant turn. It is the throwing façade over
 * {@link runOneShotDetailed}: it runs the same one-shot turn and maps the result
 * union back onto the original exception contract. Throws:
 *   - EmptyPromptError   when the prompt is blank.
 *   - DeadlineError      when `ctx` expired with a deadline cause.
 *   - TurnErroredError   when the assistant turn errored.
 *   - Error(reason)      for any other startup / underlying failure.
 */
export declare function runOneShot(ctx: Context, cfg: OneShotConfig): Promise<string>;
/**
 * OneShotOutcome — the non-throwing result of {@link runOneShotDetailed}.
 *
 * Unlike {@link runOneShot} (which throws on deadline/errored and so loses the
 * session identity a caller needs to read the transcript back), this union
 * ALWAYS carries `harnessSessionID` and `workingDir` whenever a durable harness
 * session was established — so a caller can read the on-disk transcript for a
 * completed, errored, OR deadlined turn. `startup_error` covers failures BEFORE a
 * session exists (empty prompt, binary/launch/early-PTY failure, or a deadline
 * during Open()), where `harnessSessionID` may be absent.
 */
export type OneShotOutcome = {
    status: "completed";
    reply: string;
    harnessSessionID: string;
    workingDir: string;
} | {
    status: "errored";
    reason: string;
    harnessSessionID: string;
    workingDir: string;
} | {
    status: "deadline";
    harnessSessionID: string;
    workingDir: string;
} | {
    status: "startup_error";
    reason: string;
    harnessSessionID?: string;
    workingDir: string;
};
/**
 * runOneShotDetailed is the failure-safe sibling of {@link runOneShot}: it runs a
 * single one-shot turn and RESOLVES (never throws for expected outcomes) with a
 * {@link OneShotOutcome} that preserves the harness session identity even when the
 * turn deadlines or errors — so the caller can still read the transcript back. It
 * always tears the Conversation down before returning. Genuinely unexpected
 * internal errors from Open()/send() surface as `startup_error`/`errored`.
 */
export declare function runOneShotDetailed(ctx: Context, cfg: OneShotConfig): Promise<OneShotOutcome>;
//# sourceMappingURL=oneshot.d.ts.map