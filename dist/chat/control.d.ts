import { Context } from "../internal/async/index.ts";
export declare class ControlQueue {
    private _held;
    private _closed;
    private readonly queue;
    /** Acquire blocks until the token is granted or ctx cancels. */
    acquire(ctx: Context): Promise<() => void>;
    /** Held reports whether some caller currently holds the token. */
    held(): boolean;
    /** Close marks the queue closed; subsequent acquires reject with ErrClosed. */
    close(): void;
    private releaseFunc;
}
export declare function newControlQueue(): ControlQueue;
//# sourceMappingURL=control.d.ts.map