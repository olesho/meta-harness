// One-shot turn loop — the harness-agnostic core shared by meta-harness's
// in-process path and the separate-process `run` CLI (src/cli/run.ts).
//
// A one-shot run opens a Conversation over a fresh harness process, submits a
// single prompt, waits for exactly one assistant turn to reach a terminal state,
// extracts its clean reply text, and tears the process down. This mirrors the
// disposable one-shot contract the Go `harness-wrapper run` provided: prompt in,
// clean reply out, one turn, then exit.
import { Open, newMemStore, DispositionAnswer, EventTurn, RoleAssistant, TurnStateComplete, TurnStateErrored, } from "../chat/index.js";
import { Context, ctxDeadlineExceeded } from "../internal/async/index.js";
/** Thrown when the run's deadline (or an ancestor deadline) fired before completion. */
export class DeadlineError extends Error {
    constructor(message = "one-shot: context deadline exceeded") {
        super(message);
        this.name = "DeadlineError";
    }
}
/** Thrown when the assistant turn reached a terminal ERRORED state. */
export class TurnErroredError extends Error {
    reason;
    constructor(reason) {
        super("one-shot: turn errored: " + reason);
        this.name = "TurnErroredError";
        this.reason = reason;
    }
}
/** Thrown when the prompt is empty (nothing to submit). */
export class EmptyPromptError extends Error {
    constructor() {
        super("one-shot: empty prompt");
        this.name = "EmptyPromptError";
    }
}
/**
 * AutoAcceptTrust — the input policy the one-shot loop installs. It answers the
 * claude-code folder-trust / bypass startup dialog with its "proceed" option so
 * an unattended turn is never wedged behind a trust prompt. Mirrors the Go
 * run.go one-shot `AUTO_ACCEPT_TRUST` input policy.
 */
export const AutoAcceptTrust = {
    byKind: {
        trust_prompt: { kind: DispositionAnswer, optionID: "proceed" },
    },
};
/** Environment keys that leak the outer Claude Code session into the child harness. */
export function isLeakedClaudeEnv(key) {
    return key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_");
}
/**
 * cleanEnv returns `env` (KEY=VALUE strings) with the CLAUDECODE / CLAUDE_CODE_*
 * variables stripped, so a nested harness process does not inherit the outer
 * Claude Code session context. Mirrors the Go run.go env scrub.
 */
export function cleanEnv(env) {
    return env.filter((entry) => {
        const i = entry.indexOf("=");
        const key = i < 0 ? entry : entry.slice(0, i);
        return !isLeakedClaudeEnv(key);
    });
}
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
export async function runOneShot(ctx, cfg) {
    if (cfg.prompt.trim() === "")
        throw new EmptyPromptError();
    const outcome = await runOneShotDetailed(ctx, cfg);
    if (outcome.status === "completed")
        return outcome.reply;
    if (outcome.status === "deadline")
        throw new DeadlineError();
    if (outcome.status === "errored")
        throw new TurnErroredError(outcome.reason);
    // startup_error (post-empty-prompt): a launch/Open failure — surface its reason.
    throw new Error(outcome.reason);
}
/** Best-effort message extraction for an unknown thrown value. */
function errReason(err) {
    if (err instanceof Error)
        return err.message;
    if (typeof err === "string")
        return err;
    return String(err);
}
/**
 * runOneShotDetailed is the failure-safe sibling of {@link runOneShot}: it runs a
 * single one-shot turn and RESOLVES (never throws for expected outcomes) with a
 * {@link OneShotOutcome} that preserves the harness session identity even when the
 * turn deadlines or errors — so the caller can still read the transcript back. It
 * always tears the Conversation down before returning. Genuinely unexpected
 * internal errors from Open()/send() surface as `startup_error`/`errored`.
 */
export async function runOneShotDetailed(ctx, cfg) {
    const workingDir = cfg.workingDir ?? "";
    if (cfg.prompt.trim() === "") {
        return { status: "startup_error", reason: "empty prompt", workingDir };
    }
    let conv;
    try {
        conv = await Open(ctx, {
            harness: cfg.harness,
            binaryPath: cfg.binaryPath,
            args: cfg.args,
            workingDir: cfg.workingDir,
            env: cfg.env,
            effort: cfg.effort,
            model: cfg.model,
            cols: cfg.cols,
            rows: cfg.rows,
            idleGap: cfg.idleGap,
            markerGap: cfg.markerGap,
            store: newMemStore(),
            inputPolicy: AutoAcceptTrust,
            // Inherit acquisition from THIS single chat seam — the StreamTap attaches
            // once inside Open/Watch. oneshot forwards the opt-in and NEVER attaches
            // its own tap (that would double-write the session record).
            acquisitionMode: cfg.acquisitionMode,
            onAcquisitionEvent: cfg.onAcquisitionEvent,
            onDisplayLine: cfg.onDisplayLine,
            yieldControl: cfg.yieldControl,
            spoolDir: cfg.spoolDir,
            adapter: cfg.adapter,
            streamVersionPredicate: cfg.streamVersionPredicate,
        });
    }
    catch (err) {
        // Open failed before any durable session existed — no id to read back.
        return { status: "startup_error", reason: errReason(err), workingDir };
    }
    try {
        const release = await conv.acquireControl(ctx);
        try {
            await conv.send(ctx, cfg.prompt);
        }
        finally {
            release();
        }
        const turn = await waitForTerminalTurn(ctx, conv);
        const harnessSessionID = conv.session.harnessSessionID;
        if (turn.state === TurnStateErrored) {
            return {
                status: "errored",
                reason: turn.reason,
                harnessSessionID,
                workingDir,
            };
        }
        return {
            status: "completed",
            reply: turn.text,
            harnessSessionID,
            workingDir,
        };
    }
    catch (err) {
        // A session may or may not have been established before the failure. Read the
        // id best-effort: present → deadline/errored (transcript readable); absent →
        // startup_error.
        const harnessSessionID = conv.session.harnessSessionID;
        if (isDeadline(ctx, err)) {
            return harnessSessionID
                ? { status: "deadline", harnessSessionID, workingDir }
                : {
                    status: "startup_error",
                    reason: "context deadline exceeded",
                    workingDir,
                };
        }
        return harnessSessionID
            ? {
                status: "errored",
                reason: errReason(err),
                harnessSessionID,
                workingDir,
            }
            : { status: "startup_error", reason: errReason(err), workingDir };
    }
    finally {
        const { ctx: closeCtx } = Context.withDeadline(Context.background(), 2000);
        await conv.close(closeCtx).catch(() => { });
    }
}
/** waitForTerminalTurn drains conversation events until an assistant turn ends, or ctx fires. */
async function waitForTerminalTurn(ctx, conv) {
    const bus = conv.events();
    for (;;) {
        const next = bus.receive();
        const cancelled = ctx.done().then(() => "cancel");
        const outcome = await Promise.race([next, cancelled]);
        if (outcome === "cancel")
            throw ctx.err() ?? new Error("one-shot: context done");
        const { value, ok } = outcome;
        if (!ok)
            throw new Error("one-shot: event channel closed before a terminal turn");
        const ev = value;
        if (ev.type === EventTurn &&
            ev.turn?.role === RoleAssistant &&
            (ev.turn.state === TurnStateComplete ||
                ev.turn.state === TurnStateErrored)) {
            return ev.turn;
        }
    }
}
/** isDeadline reports whether ctx expired with a deadline cause (vs plain cancel). */
function isDeadline(ctx, err) {
    if (err === ctxDeadlineExceeded)
        return true;
    if (err instanceof DeadlineError)
        return true;
    return ctx.err() === ctxDeadlineExceeded;
}
//# sourceMappingURL=oneshot.js.map