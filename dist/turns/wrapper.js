// Minimal wrapper-layer types the turns layer depends on.
//
// The full wrapper.Session lives in a later phase; turns only needs the
// normalized run Status vocabulary and the per-event shape its Watcher pumps
// through an Adapter. These mirror pkg/wrapper exactly (Status string values
// are wire-compatible with the Go enum) and are re-exported from the turns
// barrel so the generic adapter and tests have a single source of truth until
// the wrapper layer proper is ported.
export const StatusIdle = "idle";
export const StatusFailed = "failed";
export const StatusBlockedByCost = "blocked_by_cost";
export const StatusRetryLater = "retry_later";
export const StatusAPIError = "api_error";
export const StatusWaitingForInput = "waiting_for_input";
export const StatusStale = "stale";
export const StatusInterrupted = "interrupted";
export const StatusUnknown = "unknown";
export const StatusBinaryNotFound = "binary_not_found";
//# sourceMappingURL=wrapper.js.map