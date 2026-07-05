// generic provides a fallback turn-detection adapter that maps wrapper.Status
// transitions directly to turn events without looking at screen contents.
//
// Use it when no per-harness adapter is available, or as a safety net while a
// per-harness adapter is in development. Its fidelity is bounded by the
// wrapper's classifier vocabulary. Port of pkg/turns/generic/generic.go.
import { Blocked, Errored, TurnComplete } from "./types.js";
import { StatusAPIError, StatusBlockedByCost, StatusFailed, StatusIdle, StatusInterrupted, StatusRetryLater, StatusWaitingForInput, } from "./wrapper.js";
/** The generic, screen-agnostic turn detector. Stateless and shareable. */
export class GenericAdapter {
    name() {
        return "generic";
    }
    /** The generic adapter relies entirely on wrapper status transitions. */
    onScreen(_snap) {
        return [];
    }
    /**
     * Maps wrapper.Status to turn events:
     *   - waiting_for_input → TurnComplete
     *   - blocked_by_cost / retry_later / api_error → Blocked
     *   - failed / interrupted → Errored
     *   - idle (terminal) → Errored ("harness exited")
     *   - stale / unknown / other → no event (advisory only)
     */
    onWrapperStatus(status, reason) {
        switch (status) {
            case StatusWaitingForInput:
                return [{ kind: TurnComplete, reason }];
            case StatusBlockedByCost:
            case StatusRetryLater:
            case StatusAPIError:
                return [{ kind: Blocked, reason }];
            case StatusFailed:
            case StatusInterrupted:
                return [{ kind: Errored, reason }];
            case StatusIdle:
                return [{ kind: Errored, reason: "harness exited" }];
            default:
                return [];
        }
    }
}
/** Constructs the generic adapter (mirrors generic.New). */
export function New() {
    return new GenericAdapter();
}
//# sourceMappingURL=generic.js.map