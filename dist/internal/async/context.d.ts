import { type Sentinel } from "./errors.ts";
export declare const ctxCanceled: Sentinel;
export declare const ctxDeadlineExceeded: Sentinel;
export type CancelFn = (cause?: unknown) => void;
export declare class Context {
    private _err;
    private _resolveDone;
    private readonly _done;
    private readonly _children;
    private _timer;
    private readonly _parent?;
    private constructor();
    /** The root, never-cancelled context. */
    static background(): Context;
    /** A child context plus a function to cancel it. */
    static withCancel(parent: Context): {
        ctx: Context;
        cancel: CancelFn;
    };
    /** A child context that auto-cancels after `ms` with ctxDeadlineExceeded. */
    static withDeadline(parent: Context, ms: number): {
        ctx: Context;
        cancel: CancelFn;
    };
    private _finish;
    /** Resolves when the context is cancelled or its deadline passes. */
    done(): Promise<void>;
    /** The cancellation cause, or undefined while still active. */
    err(): unknown;
    /** True once cancelled/expired. */
    isDone(): boolean;
}
//# sourceMappingURL=context.d.ts.map