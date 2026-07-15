// Public barrel for `meta-harness/chat`.
//
// Re-exports only from src/chat/** (never from src/internal/**). The chat layer
// is the top of the core: a Conversation owns one supervised harness process and
// serves the chat-style API on top of it.
//
// Note: `isSentinel` is intentionally NOT re-exported here — it belongs to the
// internal async toolkit. Callers match the cause-chain sentinels exported below
// against it by importing it from the internal toolkit in their own code/tests.
export { RoleUser, RoleAssistant, RoleSystem, TurnStatePending, TurnStateStreaming, TurnStateComplete, TurnStateErrored, EventTurn, EventInputRequest, EventInputResolved, DispositionAsk, DispositionAnswer, DispositionDeny, HistorySourceTranscript, HistorySourceStore, } from "./types.js";
export { MemStore, newMemStore } from "./memstore.js";
export { cleanHarnessEnv } from "./env.js";
export { ErrInvalidOptions, ErrUnknownHarness, ErrNoControl, ErrTurnInFlight, ErrClosed, ErrInputPending, ErrNoInputPending, ErrStaleInputRequest, ErrUnknownOption, ErrNotMultiSelect, ErrQuitUnsupported, ErrResumeUnsupported, ErrNoHarnessSession, } from "./errors.js";
export { submitKeyForHarness, requiresPromptReadiness, readyForInput, } from "./ready.js";
export { Conversation, Open, Reopen, resolveAdapter, } from "./conversation.js";
//# sourceMappingURL=index.js.map