export declare class Mutex {
    private _locked;
    private readonly _waiters;
    get locked(): boolean;
    /** Acquire the lock, awaiting if held. */
    lock(): Promise<void>;
    /** Release the lock to the next waiter, or mark it free. */
    unlock(): void;
    /** Run `fn` while holding the lock, releasing it even on throw. */
    withLock<T>(fn: () => Promise<T> | T): Promise<T>;
}
//# sourceMappingURL=mutex.d.ts.map