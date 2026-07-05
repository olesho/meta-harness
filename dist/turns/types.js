// turns translates low-level harness signals — emulated screen state changes
// and wrapper-level status events — into a small vocabulary of chat-oriented
// turn events: turn complete, tool call, blocked, errored, input requested.
//
// Adapters implement the per-harness logic. A generic fallback adapter (see
// ./generic.ts) maps wrapper.Status to turn events without looking at the
// screen at all; per-harness adapters live in ./harness/<name>.ts and add
// screen-derived signals such as prompt-region detection and tool-call markers.
//
// Port of pkg/turns/turns.go.
/** Assistant finished its turn; the caller may send the next user message. */
export const TurnComplete = "turn_complete";
/** Harness is invoking a tool. Informational; the turn is still in progress. */
export const ToolCall = "tool_call";
/** Transient block (cost/quota/rate-limit). Back off and retry. */
export const Blocked = "blocked";
/** Terminal failure; the turn did not complete and is unlikely to recover. */
export const Errored = "errored";
/** Harness is blocked on an interactive prompt; see Event.input. */
export const InputRequested = "input_requested";
/** A previously-requested interactive prompt is no longer on screen. */
export const InputResolved = "input_resolved";
//# sourceMappingURL=types.js.map