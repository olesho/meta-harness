// The normalized run status reported by the wrapper.

export type Status = string;

export const StatusIdle: Status = "idle";
export const StatusFailed: Status = "failed";
export const StatusBlockedByCost: Status = "blocked_by_cost";
export const StatusRetryLater: Status = "retry_later";
export const StatusAPIError: Status = "api_error";
export const StatusWaitingForInput: Status = "waiting_for_input";
export const StatusStale: Status = "stale";
export const StatusInterrupted: Status = "interrupted";
export const StatusUnknown: Status = "unknown";
export const StatusBinaryNotFound: Status = "binary_not_found";
