// controlQueue — a FIFO turnstile, the TS port of pkg/chat/control.go.
//
// acquire resolves with a release function when the queue grants the caller the
// token. Waiters are served first-come, first-served. If the context cancels
// before the token is granted, acquire rejects with ctx.err() and the waiter is
// removed. release is safe to call multiple times; only the first has effect.
// After close, acquire rejects with ErrClosed.

import { Context } from "../internal/async/index.ts";
import { ErrClosed } from "./errors.ts";

interface Waiter {
  resolve: () => void;
  reject: (e: unknown) => void;
  granted: boolean;
  removed: boolean;
}

export class ControlQueue {
  private _held = false;
  private _closed = false;
  private readonly queue: Waiter[] = [];

  /** Acquire blocks until the token is granted or ctx cancels. */
  async acquire(ctx: Context): Promise<() => void> {
    if (this._closed) throw ErrClosed;
    if (!this._held) {
      this._held = true;
      return this.releaseFunc();
    }

    const waiter: Waiter = {
      resolve: () => {},
      reject: () => {},
      granted: false,
      removed: false,
    };
    const granted = new Promise<void>((resolve, reject) => {
      waiter.resolve = resolve;
      waiter.reject = reject;
    });
    this.queue.push(waiter);

    const cancelled = ctx.done().then(() => "cancel" as const);
    const won = granted.then(() => "grant" as const);
    const outcome = await Promise.race([won, cancelled]);

    if (outcome === "grant") {
      return this.releaseFunc();
    }
    // ctx cancelled. We may have been granted just as ctx cancelled.
    if (waiter.granted) {
      // Token already handed to us — pass it straight on.
      this.releaseFunc()();
      throw ctx.err();
    }
    // Not yet granted — remove from queue and bail.
    waiter.removed = true;
    const i = this.queue.indexOf(waiter);
    if (i >= 0) this.queue.splice(i, 1);
    throw ctx.err();
  }

  /** Held reports whether some caller currently holds the token. */
  held(): boolean {
    return this._held;
  }

  /** Close marks the queue closed; subsequent acquires reject with ErrClosed. */
  close(): void {
    this._closed = true;
  }

  private releaseFunc(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (!this._held) return;
      let next = this.queue.shift();
      while (next?.removed) next = this.queue.shift();
      if (!next) {
        this._held = false;
        return;
      }
      next.granted = true;
      next.resolve();
      // _held stays true: ownership transfers to next.
    };
  }
}

export function newControlQueue(): ControlQueue {
  return new ControlQueue();
}
