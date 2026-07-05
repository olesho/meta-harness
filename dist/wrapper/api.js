// Aggregated public surface for the wrapper classifier core.
//
// This module (not the barrel itself) reaches into src/wrapper/internal/** and
// re-exports only the public-facing symbols. The barrel re-exports from here,
// keeping its own source free of any `internal` import path (the boundary the
// exports-guard test enforces).
export { classifyOutput } from "./internal/classifier.js";
export { ErrNone, ErrRateLimited, ErrAuth, ErrBilling, ErrModelNotFound, ErrContextOverflow, ErrTimeout, ErrTransient, ErrUnknown, errorClassString, } from "./internal/errorclass.js";
export { StatusIdle, StatusFailed, StatusBlockedByCost, StatusRetryLater, StatusAPIError, StatusWaitingForInput, StatusStale, StatusInterrupted, StatusUnknown, StatusBinaryNotFound, } from "./internal/status.js";
export { ErrInvalidConfig, ErrBinaryNotFound, isBinaryNotFound, validateConfig, } from "./internal/config.js";
export { argsWithHarnessEffort, harnessSupportsEffort, isSupportedEffort, } from "./internal/effort.js";
export { argsWithHarnessModel } from "./internal/mode.js";
// PTY supervision surface.
export { start, run } from "./internal/run.js";
export { Session, ClassifierFunc, classifyExit, EventChannel, } from "./internal/session.js";
export { ErrPTYAllocation, ErrPTYRead } from "./internal/pty.js";
//# sourceMappingURL=api.js.map