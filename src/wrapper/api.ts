// Aggregated public surface for the wrapper classifier core.
//
// This module (not the barrel itself) reaches into src/wrapper/internal/** and
// re-exports only the public-facing symbols. The barrel re-exports from here,
// keeping its own source free of any `internal` import path (the boundary the
// exports-guard test enforces).

export { classifyOutput } from "./internal/classifier.ts"

export type {
  Classification,
  Classifier,
  ClassifierInput,
} from "./internal/classification.ts"

export {
  ErrNone,
  ErrRateLimited,
  ErrAuth,
  ErrBilling,
  ErrModelNotFound,
  ErrContextOverflow,
  ErrTimeout,
  ErrTransient,
  ErrUnknown,
  errorClassString,
  type ErrorClass,
} from "./internal/errorclass.ts"

export {
  StatusIdle,
  StatusFailed,
  StatusBlockedByCost,
  StatusRetryLater,
  StatusAPIError,
  StatusWaitingForInput,
  StatusStale,
  StatusInterrupted,
  StatusUnknown,
  StatusBinaryNotFound,
  type Status,
} from "./internal/status.ts"

export {
  ErrInvalidConfig,
  ErrBinaryNotFound,
  isBinaryNotFound,
  validateConfig,
  type Config,
} from "./internal/config.ts"

export {
  argsWithHarnessEffort,
  envWithHarnessEffort,
  harnessSupportsEffort,
  isSupportedEffort,
} from "./internal/effort.ts"
export { argsWithHarnessModel } from "./internal/mode.ts"
