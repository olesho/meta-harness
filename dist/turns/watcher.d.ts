import type { Screen } from "../screen/index.ts";
import type { Adapter, Event } from "./types.ts";
import type { SessionLike } from "./wrapper.ts";
export declare class Watcher {
    private readonly queue;
    private waiter;
    private pumpsRunning;
    private closed;
    private finished;
    private onClose;
    constructor(sess: SessionLike | null, scr: Screen | null, adapter: Adapter);
    /** The async stream of turn events; ends once both sources stop. */
    events(): AsyncIterableIterator<Event>;
    /** Signals the screen pump to stop. Does not stop the session. Idempotent. */
    close(): void;
    private send;
    private pumpDone;
}
/** Starts a Watcher. Pass null for scr to skip screen-derived signals. */
export declare function Watch(sess: SessionLike | null, scr: Screen | null, adapter: Adapter): Watcher;
//# sourceMappingURL=watcher.d.ts.map