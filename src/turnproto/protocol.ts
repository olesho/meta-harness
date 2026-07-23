// Neutral structured-turn protocol — the ONE source of truth for the exit codes,
// the deadline anchor line, and the result-schema TYPE shared by the producer
// (src/cli/structured-runner.ts) and the host-side turn client (src/env/turn.ts).
//
// Dependency-light BY CONTRACT: this file imports NOTHING. Both CLIs re-export
// these constants (so their tested surface is unchanged) and the ./env turn
// client imports them directly, so no copy is ever hand-synced. Frozen as the
// cross-repo contract (design §7 "Protocol ownership").

/** Exit codes — the coarse orchestration signal. The JSON payload on stdout is
 *  the source of truth; these mirror the orchestrator's headless reply() parser. */
export const ExitOK = 0;
export const ExitError = 1;
export const ExitUsage = 2;
export const ExitDeadline = 124;

/** The literal stderr anchor the orchestrator's deadline regex matches on a 124
 *  exit. FROZEN string — do not reword. */
export const DeadlineLine = "harness-wrapper run: context deadline exceeded";

/** The turn's coarse status, mirroring src/oneshot's OneShotOutcome union. */
export type TurnStatus = "completed" | "errored" | "deadline" | "startup_error";

/**
 * The single JSON line `meta-harness-structured-run` emits on stdout, and the
 * shape the host turn client parses back (design §7 step 3). FROZEN schema:
 * the five required keys are ALWAYS present with these types; the four optional
 * keys (usage, reason, transcript_error, permission_mode) are present-with-type
 * when set and ABSENT otherwise (JSON.stringify omits undefined keys — an
 * exact-string match would be flaky).
 */
export interface StructuredTurnResult {
  /** Coarse status of the turn. */
  status: TurnStatus | string;
  /** The clean reply text; "" on any non-completed status. */
  reply: string;
  /** The harness's own session id ("" when it could not be recovered). */
  harnessSessionID: string;
  /** The canonical transcript, read in-guest (both harnesses). */
  transcript_entries: Record<string, unknown>[];
  /** The guest working directory the turn ran in. */
  working_dir: string;
  /** Additive token telemetry; absent when the transcript records none. */
  usage?: Record<string, number>;
  /** Failure detail; present on errored/startup_error. */
  reason?: string;
  /** Best-effort transcript read failure; present only when the read failed. */
  transcript_error?: string;
  /**
   * The permission rung the RUNNER LAUNCHED the harness at — descriptive
   * telemetry, NOT an authorization signal, and NOT a readback of the live
   * mode. A consumer asking "what is this agent allowed to do RIGHT NOW" for a
   * live session must use chat's permission readback, not this field.
   *
   * Vocabulary — one of:
   *   • the canonical ladder, least to most permissive:
   *     "plan" | "manual" | "ask" | "auto" | "bypass"
   *   • "override" — permissions are pinned by the argv in a shape NO SINGLE
   *     TOKEN can name: a valueless/empty --permission-mode, or a codex pin
   *     whose (sandbox, approval) posture is not one a rung emits (-p/--profile,
   *     a lone -a, a `-c sandbox_mode=`/`approval_policy=` key). A pin that DOES
   *     name a posture resolves to its rung instead.
   *   • claude-code only: an off-ladder native --permission-mode spelling passed
   *     through verbatim (at 2.1.217 the only such value is "dontAsk").
   * ABSENT means no mode was requested AND the runner injected none — it does
   * NOT mean "default". A host that must tell "unset" from "the guest binary
   * predates this field" compares against its OWN request: request set AND this
   * key absent ⇒ the guest predates the field (or the launch failed before the
   * result was assembled). The host never synthesises the key from its request.
   *
   * NOT ROUND-TRIPPABLE into --permission-mode. Distinct argv shapes map onto
   * the same token: "bypass" is emitted for the runner-injected
   * --dangerously-skip-permissions (--sandbox-defaults), for the ladder
   * translation --permission-mode bypassPermissions, and for codex's
   * --dangerously-bypass-approvals-and-sandbox. Replaying a recorded value as a
   * flag yields a DIFFERENT argv than the one recorded.
   *
   * Consumers MUST treat an unrecognised value as opaque and MUST NOT map it
   * onto a rung. Typed `string`, not a union, mirroring `status` above: this
   * file imports NOTHING by contract, so a second copy of the rung union here
   * would be a hand-synced vocabulary — and Go needs the same tolerance to
   * accept a value a newer producer added.
   */
  permission_mode?: string;
}
