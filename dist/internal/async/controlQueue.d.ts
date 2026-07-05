import { Context } from "./context.ts";
import { type Sentinel } from "./errors.ts";
export declare const queueClosed: Sentinel;
export declare class ControlQueue {
    private _held;
    private _closed;
    private readonly _waiters;
    get closed(): boolean;
    /**
     * Acquire the turn. Resolves when held. If `ctx` cancels first, removes this
     * waiter and rejects with ctx.err(). Rejects with queueClosed if closed.
     */
    acquire(ctx: Context): Promise<void>;
    /** Pass the turn to the next waiter. A release with no holder is a no-op. */
    release(): void;
    /** Close the queue: reject all waiters and all future acquires. */
    close(): void;
}
//# sourceMappingURL=controlQueue.d.ts.map