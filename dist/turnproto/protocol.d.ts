/** Exit codes — the coarse orchestration signal. The JSON payload on stdout is
 *  the source of truth; these mirror the orchestrator's headless reply() parser. */
export declare const ExitOK = 0;
export declare const ExitError = 1;
export declare const ExitUsage = 2;
export declare const ExitDeadline = 124;
/** The literal stderr anchor the orchestrator's deadline regex matches on a 124
 *  exit. FROZEN string — do not reword. */
export declare const DeadlineLine = "harness-wrapper run: context deadline exceeded";
/** The turn's coarse status, mirroring src/oneshot's OneShotOutcome union. */
export type TurnStatus = "completed" | "errored" | "deadline" | "startup_error";
/**
 * The single JSON line `meta-harness-structured-run` emits on stdout, and the
 * shape the host turn client parses back (design §7 step 3). FROZEN schema:
 * the five required keys are ALWAYS present with these types; the three optional
 * keys are present-with-type when set and ABSENT otherwise (JSON.stringify omits
 * undefined keys — an exact-string match would be flaky).
 */
export interface StructuredTurnResult {
    /** Coarse status of the turn. */
    status: TurnStatus | string;
    /** The clean reply text; "" on any non-completed status. */
    reply: string;
    /** The harness's own session id ("" when it could not be recovered). */
    harnessSessionID: string;
    /** The canonical transcript, read in-guest (both harnesses). */
    transcript_entries: Array<Record<string, unknown>>;
    /** The guest working directory the turn ran in. */
    working_dir: string;
    /** Additive token telemetry; absent when the transcript records none. */
    usage?: Record<string, number>;
    /** Failure detail; present on errored/startup_error. */
    reason?: string;
    /** Best-effort transcript read failure; present only when the read failed. */
    transcript_error?: string;
}
//# sourceMappingURL=protocol.d.ts.map