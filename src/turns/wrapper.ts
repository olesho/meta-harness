// Minimal wrapper-layer types the turns layer depends on.
//
// The full wrapper.Session lives in a later phase; turns only needs the
// normalized run Status vocabulary and the per-event shape its Watcher pumps
// through an Adapter. These mirror pkg/wrapper exactly (Status string values
// are wire-compatible with the Go enum) and are re-exported from the turns
// barrel so the generic adapter and tests have a single source of truth until
// the wrapper layer proper is ported.

/** Normalized run status reported by the wrapper. Mirrors wrapper.Status. */
export type Status =
  | "idle"
  | "failed"
  | "blocked_by_cost"
  | "retry_later"
  | "api_error"
  | "waiting_for_input"
  | "stale"
  | "interrupted"
  | "unknown"
  | "binary_not_found"

export const StatusIdle: Status = "idle"
export const StatusFailed: Status = "failed"
export const StatusBlockedByCost: Status = "blocked_by_cost"
export const StatusRetryLater: Status = "retry_later"
export const StatusAPIError: Status = "api_error"
export const StatusWaitingForInput: Status = "waiting_for_input"
export const StatusStale: Status = "stale"
export const StatusInterrupted: Status = "interrupted"
export const StatusUnknown: Status = "unknown"
export const StatusBinaryNotFound: Status = "binary_not_found"

/**
 * One status transition emitted on a wrapper session's event stream. Mirrors
 * wrapper.SessionEvent (only the fields the Watcher copies onto turn Events).
 */
export interface SessionEvent {
  at?: Date
  status: Status
  reason: string
  terminated: boolean
  /** Upstream API status code for api_error events; 0/undefined otherwise. */
  httpCode?: number
  /** Parsed "retry after" hint in milliseconds; 0/undefined when absent. */
  retryAfter?: number
}

/**
 * The minimal surface a Watcher needs from a wrapper session: an async stream
 * of status events. The full Session (Wait/Stop/Snapshot) is owned elsewhere.
 */
export interface SessionLike {
  events(): AsyncIterable<SessionEvent>
}
