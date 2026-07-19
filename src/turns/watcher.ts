// Watcher composes a wrapper session, a Screen, and an Adapter into a single
// async stream of turn Events. Port of pkg/turns/watcher.go, adapted to
// JavaScript async iteration (the Go version uses goroutines + channels).
//
// Two pumps run concurrently:
//   1. wrapper session events → adapter.onWrapperStatus
//   2. screen subscription   → adapter.onScreen
// The events stream ends after both the session terminates AND close() is
// called.

import type { Screen } from "../screen/index.ts";
import type { Adapter, Event } from "./types.ts";
import { StatusAPIError, type SessionLike } from "./wrapper.ts";

export class Watcher {
  private readonly queue: Event[] = [];
  private waiter: ((v: IteratorResult<Event>) => void) | null = null;
  private pumpsRunning = 0;
  private closed = false;
  private finished = false;
  private onClose: (() => void) | null = null;

  // Run-level observation, rolled up off EVERY raw wrapper session event —
  // BEFORE the adapter maps it to turn events (a rate-limit banner or a
  // recovered api_error that yields NO turn transition would otherwise be
  // lost). Ports pkg/harness/run.go's observation struct: the LARGEST
  // retryAfter seen and whether ANY event reported an api_error.
  private maxRetryAfter = 0;
  private sawAPIError = false;

  constructor(sess: SessionLike | null, scr: Screen | null, adapter: Adapter) {
    // Pump 1: wrapper session events → adapter.onWrapperStatus.
    if (sess) {
      this.pumpsRunning++;
      void (async () => {
        try {
          for await (const ev of sess.events()) {
            // Roll up the run-level observation off the RAW event, before the
            // adapter drops non-turn-producing events. retryAfter is optional
            // on SessionEvent, so guard the read with `?? 0`.
            if ((ev.retryAfter ?? 0) > this.maxRetryAfter)
              this.maxRetryAfter = ev.retryAfter ?? 0;
            if (ev.status === StatusAPIError) this.sawAPIError = true;
            for (const te of adapter.onWrapperStatus(ev.status, ev.reason)) {
              if (te.at === undefined) te.at = ev.at;
              if (te.httpCode === undefined) te.httpCode = ev.httpCode;
              if (te.retryAfter === undefined) te.retryAfter = ev.retryAfter;
              this.send(te);
            }
            if (ev.terminated) break;
          }
        } finally {
          this.pumpDone();
        }
      })();
    }

    // Pump 2: screen subscription → adapter.onScreen.
    if (scr) {
      const [notify, unsubscribe] = scr.subscribe();
      this.pumpsRunning++;
      const closePromise = new Promise<void>((resolve) => {
        this.onClose = resolve;
      });
      void (async () => {
        try {
          for (;;) {
            const r = await Promise.race([
              notify.receive(),
              closePromise.then(() => ({ ok: false as const, closed: true })),
            ]);
            if (!("ok" in r) || !r.ok) return;
            const snap = scr.snapshot();
            for (const te of adapter.onScreen(snap)) {
              if (te.at === undefined) te.at = new Date();
              if (te.snap === undefined) te.snap = snap;
              this.send(te);
            }
          }
        } finally {
          unsubscribe();
          this.pumpDone();
        }
      })();
    }

    if (this.pumpsRunning === 0) this.finished = true;
  }

  /** The async stream of turn events; ends once both sources stop. */
  async *events(): AsyncIterableIterator<Event> {
    for (;;) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.finished) return;
      const next = await new Promise<IteratorResult<Event>>((resolve) => {
        this.waiter = resolve;
      });
      if (next.done) return;
      yield next.value;
    }
  }

  /**
   * The run-level roll-up over every raw wrapper session event seen so far:
   * the LARGEST retryAfter and whether ANY event reported an api_error. Read it
   * after pump 1 has drained the terminal event (i.e. after events() completes)
   * for the final, complete observation.
   */
  observation(): { retryAfter: number; sawAPIError: boolean } {
    return { retryAfter: this.maxRetryAfter, sawAPIError: this.sawAPIError };
  }

  /** Signals the screen pump to stop. Does not stop the session. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.();
  }

  private send(ev: Event): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ done: false, value: ev });
      return;
    }
    this.queue.push(ev);
  }

  private pumpDone(): void {
    this.pumpsRunning--;
    if (this.pumpsRunning <= 0) {
      this.finished = true;
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w({ done: true, value: undefined });
      }
    }
  }
}

/** Starts a Watcher. Pass null for scr to skip screen-derived signals. */
export function Watch(
  sess: SessionLike | null,
  scr: Screen | null,
  adapter: Adapter,
): Watcher {
  return new Watcher(sess, scr, adapter);
}
