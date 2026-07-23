// Public barrel for `meta-harness/chat`.
//
// Re-exports only from src/chat/** (never from src/internal/**). The chat layer
// is the top of the core: a Conversation owns one supervised harness process and
// serves the chat-style API on top of it.
//
// Note: `isSentinel` is intentionally NOT re-exported here — it belongs to the
// internal async toolkit. Callers match the cause-chain sentinels exported below
// against it by importing it from the internal toolkit in their own code/tests.

export {
  type Role,
  RoleUser,
  RoleAssistant,
  RoleSystem,
  type TurnState,
  TurnStatePending,
  TurnStateStreaming,
  TurnStateComplete,
  TurnStateErrored,
  type Turn,
  type EventType,
  EventTurn,
  EventInputRequest,
  EventInputResolved,
  type ConversationEvent,
  type Session,
  type InputRequest,
  type InputOption,
  type InputAnswer,
  type DispositionKind,
  DispositionAsk,
  DispositionAnswer,
  DispositionDeny,
  type Disposition,
  type InputPolicy,
  type HistorySource,
  HistorySourceTranscript,
  HistorySourceStore,
  ReasonAuthRequired,
  ReasonUsageLimited,
} from "./types.ts";

export type { Store } from "./store.ts";
export { MemStore, newMemStore } from "./memstore.ts";

export { cleanHarnessEnv } from "./env.ts";

export {
  ErrInvalidOptions,
  ErrUnknownHarness,
  ErrNoControl,
  ErrTurnInFlight,
  ErrClosed,
  ErrInputPending,
  ErrNoInputPending,
  ErrStaleInputRequest,
  ErrUnknownOption,
  ErrNotMultiSelect,
  ErrQuitUnsupported,
  ErrResumeUnsupported,
  ErrNoHarnessSession,
} from "./errors.ts";

export {
  type PermissionRung,
  type PermissionModeSource,
  type PermissionModeReading,
  parsePermissionMode,
  normalizePermissionRung,
} from "./permission.ts";

export {
  submitKeyForHarness,
  requiresPromptReadiness,
  readyForInput,
  authRequired,
  onboardingWall,
} from "./ready.ts";

export {
  Conversation,
  Open,
  Reopen,
  resolveAdapter,
  type Options,
  type ReopenOptions,
} from "./conversation.ts";

export type {
  WrapperSession,
  Adapter,
  TranscriptTurn,
  Watcher,
  EventStream,
  TurnEvent,
  TurnEventKind,
  TurnsInputRequest,
  TurnsInputOption,
  StartConfig,
  Backend,
} from "./deps.ts";
