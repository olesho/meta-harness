import type { Snapshot } from "../screen/index.ts";
import type { Adapter, Event } from "./types.ts";
import type { Status } from "./wrapper.ts";
/** The generic, screen-agnostic turn detector. Stateless and shareable. */
export declare class GenericAdapter implements Adapter {
    name(): string;
    /** The generic adapter relies entirely on wrapper status transitions. */
    onScreen(_snap: Snapshot): Event[];
    /**
     * Maps wrapper.Status to turn events:
     *   - waiting_for_input → TurnComplete
     *   - blocked_by_cost / retry_later / api_error → Blocked
     *   - failed / interrupted → Errored
     *   - idle (terminal) → Errored ("harness exited")
     *   - stale / unknown / other → no event (advisory only)
     */
    onWrapperStatus(status: Status, reason: string): Event[];
}
/** Constructs the generic adapter (mirrors generic.New). */
export declare function New(): GenericAdapter;
//# sourceMappingURL=generic.d.ts.map