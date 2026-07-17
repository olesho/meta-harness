import { type Sentinel } from "./errors.ts";
export declare const chanClosed: Sentinel;
export interface Recv<T> {
    value: T | undefined;
    ok: boolean;
}
export declare class Channel<T> {
    private readonly _buffer;
    private readonly _recvWaiters;
    private readonly _sendWaiters;
    private _closed;
    private readonly _capacity;
    constructor(capacity?: number);
    get closed(): boolean;
    /** Buffer a value, awaiting room if the buffer is full. Rejects if closed. */
    send(value: T): Promise<void>;
    private readonly _rejectOnClose;
    /** Receive the next value. Resolves { ok:false } when closed and drained. */
    receive(): Promise<Recv<T>>;
    /** Close the channel. Pending receivers drain; pending senders reject. */
    close(): void;
    /** Async-iterate received values until the channel is closed and drained. */
    [Symbol.asyncIterator](): AsyncIterator<T>;
}
//# sourceMappingURL=channel.d.ts.map