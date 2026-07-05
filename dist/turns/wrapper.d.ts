/** Normalized run status reported by the wrapper. Mirrors wrapper.Status. */
export type Status = "idle" | "failed" | "blocked_by_cost" | "retry_later" | "api_error" | "waiting_for_input" | "stale" | "interrupted" | "unknown" | "binary_not_found";
export declare const StatusIdle: Status;
export declare const StatusFailed: Status;
export declare const StatusBlockedByCost: Status;
export declare const StatusRetryLater: Status;
export declare const StatusAPIError: Status;
export declare const StatusWaitingForInput: Status;
export declare const StatusStale: Status;
export declare const StatusInterrupted: Status;
export declare const StatusUnknown: Status;
export declare const StatusBinaryNotFound: Status;
/**
 * One status transition emitted on a wrapper session's event stream. Mirrors
 * wrapper.SessionEvent (only the fields the Watcher copies onto turn Events).
 */
export interface SessionEvent {
    at?: Date;
    status: Status;
    reason: string;
    terminated: boolean;
    /** Upstream API status code for api_error events; 0/undefined otherwise. */
    httpCode?: number;
    /** Parsed "retry after" hint in milliseconds; 0/undefined when absent. */
    retryAfter?: number;
}
/**
 * The minimal surface a Watcher needs from a wrapper session: an async stream
 * of status events. The full Session (Wait/Stop/Snapshot) is owned elsewhere.
 */
export interface SessionLike {
    events(): AsyncIterable<SessionEvent>;
}
//# sourceMappingURL=wrapper.d.ts.map