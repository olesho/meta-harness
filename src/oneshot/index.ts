// Public barrel for `meta-harness/oneshot`.
//
// The harness-agnostic one-shot turn loop (prompt in → clean reply out, one
// turn, then teardown) shared by the in-process path and the separate-process
// `run` CLI. Re-exports only from src/oneshot/** (never from src/internal/**);
// the loop takes a caller-provided Context so this barrel need not surface the
// internal async toolkit.

export {
  runOneShot,
  runOneShotDetailed,
  cleanEnv,
  isLeakedClaudeEnv,
  AutoAcceptTrust,
  DeadlineError,
  TurnErroredError,
  EmptyPromptError,
  type OneShotConfig,
  type OneShotOutcome,
} from "./oneshot.ts"
