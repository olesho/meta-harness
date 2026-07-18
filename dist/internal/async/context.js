// Context — a cancellation/deadline primitive modeled on Go's context.Context.
//
// A Context can be cancelled explicitly (withCancel) or automatically after a
// deadline (withDeadline). Cancellation propagates to child contexts. Callers
// await `done()` to learn when the context is finished, and read `err()` to
// learn why (sentinel: ctxCanceled or ctxDeadlineExceeded).
import { defineSentinel } from "./errors.js";
export const ctxCanceled = defineSentinel("context/canceled", "context canceled");
export const ctxDeadlineExceeded = defineSentinel("context/deadline-exceeded", "context deadline exceeded");
export class Context {
    _err = undefined;
    _resolveDone;
    _done;
    _children = new Set();
    _timer;
    _parent;
    constructor(_parent) {
        this._parent = _parent;
        this._done = new Promise((resolve) => {
            this._resolveDone = resolve;
        });
        if (_parent) {
            if (_parent._err !== undefined) {
                // Parent already cancelled: inherit immediately.
                this._finish(_parent._err);
            }
            else {
                _parent._children.add(this);
            }
        }
    }
    /** The root, never-cancelled context. */
    static background() {
        return new Context();
    }
    /** A child context plus a function to cancel it. */
    static withCancel(parent) {
        const ctx = new Context(parent);
        const cancel = (cause) => {
            ctx._finish(cause ?? ctxCanceled);
        };
        return { ctx, cancel };
    }
    /** A child context that auto-cancels after `ms` with ctxDeadlineExceeded. */
    static withDeadline(parent, ms) {
        const { ctx, cancel } = Context.withCancel(parent);
        if (ctx._err === undefined) {
            ctx._timer = setTimeout(() => {
                ctx._finish(ctxDeadlineExceeded);
            }, ms);
        }
        return { ctx, cancel };
    }
    _finish(err) {
        if (this._err !== undefined)
            return;
        this._err = err;
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = undefined;
        }
        this._parent?._children.delete(this);
        this._resolveDone();
        for (const child of this._children)
            child._finish(err);
        this._children.clear();
    }
    /** Resolves when the context is cancelled or its deadline passes. */
    done() {
        return this._done;
    }
    /** The cancellation cause, or undefined while still active. */
    err() {
        return this._err;
    }
    /** True once cancelled/expired. */
    isDone() {
        return this._err !== undefined;
    }
}
//# sourceMappingURL=context.js.map