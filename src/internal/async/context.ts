// Context — a cancellation/deadline primitive modeled on Go's context.Context.
//
// A Context can be cancelled explicitly (withCancel) or automatically after a
// deadline (withDeadline). Cancellation propagates to child contexts. Callers
// await `done()` to learn when the context is finished, and read `err()` to
// learn why (sentinel: ctxCanceled or ctxDeadlineExceeded).

import { defineSentinel, type Sentinel } from "./errors.ts"

export const ctxCanceled: Sentinel = defineSentinel(
  "context/canceled",
  "context canceled",
)
export const ctxDeadlineExceeded: Sentinel = defineSentinel(
  "context/deadline-exceeded",
  "context deadline exceeded",
)

export type CancelFn = (cause?: unknown) => void

export class Context {
  private _err: unknown = undefined
  private _resolveDone!: () => void
  private readonly _done: Promise<void>
  private readonly _children = new Set<Context>()
  private _timer: ReturnType<typeof setTimeout> | undefined
  private readonly _parent?: Context

  private constructor(_parent?: Context) {
    this._parent = _parent
    this._done = new Promise<void>((resolve) => {
      this._resolveDone = resolve
    })
    if (_parent) {
      if (_parent._err !== undefined) {
        // Parent already cancelled: inherit immediately.
        this._finish(_parent._err)
      } else {
        _parent._children.add(this)
      }
    }
  }

  /** The root, never-cancelled context. */
  static background(): Context {
    return new Context()
  }

  /** A child context plus a function to cancel it. */
  static withCancel(parent: Context): { ctx: Context; cancel: CancelFn } {
    const ctx = new Context(parent)
    const cancel: CancelFn = (cause?: unknown) =>
      ctx._finish(cause ?? ctxCanceled)
    return { ctx, cancel }
  }

  /** A child context that auto-cancels after `ms` with ctxDeadlineExceeded. */
  static withDeadline(
    parent: Context,
    ms: number,
  ): { ctx: Context; cancel: CancelFn } {
    const { ctx, cancel } = Context.withCancel(parent)
    if (ctx._err === undefined) {
      ctx._timer = setTimeout(() => ctx._finish(ctxDeadlineExceeded), ms)
    }
    return { ctx, cancel }
  }

  private _finish(err: unknown): void {
    if (this._err !== undefined) return
    this._err = err
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = undefined
    }
    this._parent?._children.delete(this)
    this._resolveDone()
    for (const child of this._children) child._finish(err)
    this._children.clear()
  }

  /** Resolves when the context is cancelled or its deadline passes. */
  done(): Promise<void> {
    return this._done
  }

  /** The cancellation cause, or undefined while still active. */
  err(): unknown {
    return this._err
  }

  /** True once cancelled/expired. */
  isDone(): boolean {
    return this._err !== undefined
  }
}
