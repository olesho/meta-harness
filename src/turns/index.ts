// Public barrel for `meta-harness/turns`.
//
// Re-exports only from src/turns/** (never from src/internal/**). Per-harness
// adapter internals (DetectInput, parse helpers, regexes) stay behind this
// barrel; only the public turn vocabulary, the Adapter contract + optional
// capability interfaces, the Watcher, and the adapter constructors are exposed.

export type {
  AcquisitionMode,
  Adapter,
  BusyDetector,
  Event,
  InputOption,
  InputRequest,
  Kind,
  MessageExtractor,
  Quitter,
  RawSessionIDExtractor,
  RequestedAcquisitionMode,
  SessionControlFlags,
  SessionIDExtractor,
  SessionIDLocator,
  SessionIDPrimer,
  SessionInitializer,
  SessionResumer,
  StreamInterleaved,
  StreamParser,
  TranscriptReader,
  Turn,
} from "./types.ts";

export {
  AcquisitionModeAuto,
  AcquisitionModeHooks,
  AcquisitionModeOff,
  AcquisitionModeStream,
  Blocked,
  describeAcquisitionMode,
  Errored,
  InputRequested,
  InputResolved,
  ToolCall,
  TurnComplete,
} from "./types.ts";

export type { SessionEvent, SessionLike, Status } from "./wrapper.ts";
export {
  StatusAPIError,
  StatusBinaryNotFound,
  StatusBlockedByCost,
  StatusFailed,
  StatusIdle,
  StatusInterrupted,
  StatusRetryLater,
  StatusStale,
  StatusUnknown,
  StatusWaitingForInput,
} from "./wrapper.ts";

export { Watch, Watcher } from "./watcher.ts";

// Generic fallback adapter and the five per-harness adapters, exposed as
// namespaces so callers write `generic.New()`, `claudecode.New()`, etc.,
// mirroring the Go package layout. Internals are not part of the surface.
export * as generic from "./generic.ts";
export * as claudecode from "./harness/claudecode.ts";
export * as codex from "./harness/codex.ts";
export * as opencode from "./harness/opencode.ts";
export * as pi from "./harness/pi.ts";
