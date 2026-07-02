// One-shot turn loop — the harness-agnostic core shared by meta-harness's
// in-process path and the separate-process `run` CLI (src/cli/run.ts).
//
// A one-shot run opens a Conversation over a fresh harness process, submits a
// single prompt, waits for exactly one assistant turn to reach a terminal state,
// extracts its clean reply text, and tears the process down. This mirrors the
// disposable one-shot contract the Go `harness-wrapper run` provided: prompt in,
// clean reply out, one turn, then exit.

import {
  Open,
  newMemStore,
  DispositionAnswer,
  EventTurn,
  RoleAssistant,
  TurnStateComplete,
  TurnStateErrored,
  type Conversation,
  type InputPolicy,
  type Turn,
} from "../chat/index.ts"
import { Context, ctxDeadlineExceeded } from "../internal/async/index.ts"

/** Config for a single one-shot turn. `harness` is the adapter name (e.g. "claude-code", "codex"). */
export interface OneShotConfig {
  harness: string
  binaryPath: string
  prompt: string
  args?: string[]
  workingDir?: string
  env?: string[]
  effort?: string
  model?: string
  /** Terminal geometry; defaults match chat.Open (120x40). */
  cols?: number
  rows?: number
  /** Test-only idle-completion window override (ms). Zero/undefined = package default. */
  idleGap?: number
  /** Test-only marker-confirm window override (ms). Zero/undefined = package default. */
  markerGap?: number
}

/** Thrown when the run's deadline (or an ancestor deadline) fired before completion. */
export class DeadlineError extends Error {
  constructor(message = "one-shot: context deadline exceeded") {
    super(message)
    this.name = "DeadlineError"
  }
}

/** Thrown when the assistant turn reached a terminal ERRORED state. */
export class TurnErroredError extends Error {
  readonly reason: string
  constructor(reason: string) {
    super("one-shot: turn errored: " + reason)
    this.name = "TurnErroredError"
    this.reason = reason
  }
}

/** Thrown when the prompt is empty (nothing to submit). */
export class EmptyPromptError extends Error {
  constructor() {
    super("one-shot: empty prompt")
    this.name = "EmptyPromptError"
  }
}

/**
 * AutoAcceptTrust — the input policy the one-shot loop installs. It answers the
 * claude-code folder-trust / bypass startup dialog with its "proceed" option so
 * an unattended turn is never wedged behind a trust prompt. Mirrors the Go
 * run.go one-shot `AUTO_ACCEPT_TRUST` input policy.
 */
export const AutoAcceptTrust: InputPolicy = {
  byKind: {
    trust_prompt: { kind: DispositionAnswer, optionID: "proceed" },
  },
}

/** Environment keys that leak the outer Claude Code session into the child harness. */
export function isLeakedClaudeEnv(key: string): boolean {
  return key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_")
}

/**
 * cleanEnv returns `env` (KEY=VALUE strings) with the CLAUDECODE / CLAUDE_CODE_*
 * variables stripped, so a nested harness process does not inherit the outer
 * Claude Code session context. Mirrors the Go run.go env scrub.
 */
export function cleanEnv(env: string[]): string[] {
  return env.filter((entry) => {
    const i = entry.indexOf("=")
    const key = i < 0 ? entry : entry.slice(0, i)
    return !isLeakedClaudeEnv(key)
  })
}

/**
 * runOneShot opens a harness, submits `cfg.prompt`, and resolves with the clean
 * reply text of the single assistant turn. It always tears the Conversation down
 * before returning. Throws:
 *   - EmptyPromptError   when the prompt is blank.
 *   - DeadlineError      when `ctx` expired with a deadline cause.
 *   - TurnErroredError   when the assistant turn errored.
 *   - the ctx cause / underlying error otherwise.
 */
export async function runOneShot(ctx: Context, cfg: OneShotConfig): Promise<string> {
  if (cfg.prompt.trim() === "") throw new EmptyPromptError()

  const conv = await Open(ctx, {
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
  })

  try {
    const release = await conv.acquireControl(ctx)
    try {
      await conv.send(ctx, cfg.prompt)
    } finally {
      release()
    }

    const turn = await waitForTerminalTurn(ctx, conv)
    if (turn.state === TurnStateErrored) throw new TurnErroredError(turn.reason)
    return turn.text
  } catch (err) {
    if (isDeadline(ctx, err)) throw new DeadlineError()
    throw err
  } finally {
    const { ctx: closeCtx } = Context.withDeadline(Context.background(), 2000)
    await conv.close(closeCtx).catch(() => {})
  }
}

/** waitForTerminalTurn drains conversation events until an assistant turn ends, or ctx fires. */
async function waitForTerminalTurn(ctx: Context, conv: Conversation): Promise<Turn> {
  const bus = conv.events()
  for (;;) {
    const next = bus.receive()
    const cancelled = ctx.done().then(() => "cancel" as const)
    const outcome = await Promise.race([next, cancelled])
    if (outcome === "cancel") throw ctx.err() ?? new Error("one-shot: context done")
    const { value, ok } = outcome as Awaited<typeof next>
    if (!ok) throw new Error("one-shot: event channel closed before a terminal turn")
    const ev = value!
    if (
      ev.type === EventTurn &&
      ev.turn?.role === RoleAssistant &&
      (ev.turn.state === TurnStateComplete || ev.turn.state === TurnStateErrored)
    ) {
      return ev.turn
    }
  }
}

/** isDeadline reports whether ctx expired with a deadline cause (vs plain cancel). */
function isDeadline(ctx: Context, err: unknown): boolean {
  if (err === ctxDeadlineExceeded) return true
  if (err instanceof DeadlineError) return true
  return ctx.err() === ctxDeadlineExceeded
}
