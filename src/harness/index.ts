// Public barrel for `meta-harness/harness`.
//
// Re-exports the single-turn driver (`runTurn`) and its result/error types from
// the internal implementation, so consumers (the gateway daemon, the CLI) import
// through this barrel rather than reaching into `./internal/**` — matching how
// the gateway already imports chat via `../chat/index.ts`.
//
// `runTurn` is the TS port of Go's `pkg/harness.RunTurn`: it opens a
// Conversation, submits one prompt, waits for that turn to reach a terminal
// state, and then either stops the harness (`exitAfterTurn`) or hands the live
// Conversation back to the caller.

export {
  runTurn,
  ErrTurnErrored,
  RunTurnError,
  type TurnConfig,
  type TurnResult,
} from "./internal/runTurn.ts";
