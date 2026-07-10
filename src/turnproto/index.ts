// Public barrel for `meta-harness/turnproto` — the neutral structured-turn
// protocol. Dependency-light (imports nothing from src/internal/** or src/cli/**)
// so both CLIs and the ./env turn client can share it without dragging heavy
// deps into any of them.

export {
  ExitOK,
  ExitError,
  ExitUsage,
  ExitDeadline,
  DeadlineLine,
  type TurnStatus,
  type StructuredTurnResult,
} from "./protocol.ts"

export { parseLastJSONLine } from "./parse.ts"
