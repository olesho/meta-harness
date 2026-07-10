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
//# sourceMappingURL=protocol.js.map