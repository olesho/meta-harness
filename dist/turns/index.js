// Public barrel for `meta-harness/turns`.
//
// Re-exports only from src/turns/** (never from src/internal/**). Per-harness
// adapter internals (DetectInput, parse helpers, regexes) stay behind this
// barrel; only the public turn vocabulary, the Adapter contract + optional
// capability interfaces, the Watcher, and the adapter constructors are exposed.
export { AcquisitionModeAuto, AcquisitionModeHooks, AcquisitionModeOff, AcquisitionModeStream, Blocked, describeAcquisitionMode, Errored, InputRequested, InputResolved, ToolCall, TurnComplete, } from "./types.js";
export { StatusAPIError, StatusBinaryNotFound, StatusBlockedByCost, StatusFailed, StatusIdle, StatusInterrupted, StatusRetryLater, StatusStale, StatusUnknown, StatusWaitingForInput, } from "./wrapper.js";
export { Watch, Watcher } from "./watcher.js";
// Generic fallback adapter and the five per-harness adapters, exposed as
// namespaces so callers write `generic.New()`, `claudecode.New()`, etc.,
// mirroring the Go package layout. Internals are not part of the surface.
export * as generic from "./generic.js";
export * as claudecode from "./harness/claudecode.js";
export * as codex from "./harness/codex.js";
export * as opencode from "./harness/opencode.js";
export * as pi from "./harness/pi.js";
//# sourceMappingURL=index.js.map