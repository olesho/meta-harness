// SSE wire helper for the meta-harness-chatd daemon.
//
// Ports the streaming half of Go `cmd/harness-chatd/server.go`'s
// `streamEvents`: given a Node `http.ServerResponse`, a `Fanout` Subscription,
// and a cancellation signal, it writes the `text/event-stream` headers, emits
// each event as a `data: <JSON>\n\n` frame, and a `: ping\n\n` heartbeat every
// 15s. It tears the subscription down and stops the heartbeat when the response
// or request closes, or when the stop signal fires.
//
// Node's `ServerResponse` has NO `http.Flusher`: `write()` flushes by default
// and this daemon runs no compression middleware, so there is nothing to
// reproduce from Go's `flusher.Flush()` calls.

import type { ConversationEvent } from "../chat/types.ts";
import type { Subscription } from "./fanout.ts";

/**
 * Abstract cancellation, so the daemon-core subtask can wire its request
 * lifecycle / `Context` without this module importing `src/internal/async`.
 * Accepts any of:
 *  - an `AbortSignal` (fires on `abort`),
 *  - a `Promise<void>` (fires on settle),
 *  - a register-callback `(onStop) => void` (calls `onStop` when cancelled).
 */
export type StopSignal =
  AbortSignal | Promise<void> | ((onStop: () => void) => void);

/** Registers `cb` to run once when `sig` fires. No-op if `sig` is undefined. */
export function onStop(sig: StopSignal | undefined, cb: () => void): void {
  if (!sig) return;
  if (typeof sig === "function") {
    sig(cb);
    return;
  }
  if (typeof (sig as Promise<void>).then === "function") {
    (sig as Promise<void>).then(cb, cb);
    return;
  }
  const signal = sig as AbortSignal;
  if (signal.aborted) {
    cb();
    return;
  }
  signal.addEventListener("abort", cb, { once: true });
}

/**
 * The subset of Node's `http.ServerResponse` this helper drives. Structural so
 * tests can pass a fake that captures writes. `http.ServerResponse` satisfies
 * it.
 */
export interface ServerResponseLike {
  writeHead(status: number, headers: Record<string, string>): unknown;
  write(chunk: string): boolean;
  end?(): void;
  on(event: "close", listener: () => void): unknown;
}

/** The subset of Node's `http.IncomingMessage` used to detect client aborts. */
export interface RequestLike {
  on(event: "close", listener: () => void): unknown;
}

export interface StreamSSEOptions {
  /**
   * Frame-body encoder. Parameterized so the daemon-core subtask can swap in a
   * DTO mapper; defaults to serializing the raw `ConversationEvent`.
   */
  encode?: (ev: ConversationEvent) => string;
  /** Heartbeat period in ms (injectable for tests); defaults to 15000. */
  heartbeatMs?: number;
  /** Cancellation signal (see {@link StopSignal}). */
  signal?: StopSignal;
  /** The originating request, to also tear down on its `close`. */
  req?: RequestLike;
}

const DEFAULT_HEARTBEAT_MS = 15_000;

const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  // Defeat proxy buffering (e.g. nginx) so frames flush immediately.
  "X-Accel-Buffering": "no",
};

/**
 * Stream a Fanout subscription to an SSE response until the subscription ends
 * or a stop condition fires (`res`/`req` `'close'`, or `opts.signal`). Writes
 * headers, per-event `data:` frames, and periodic `: ping` heartbeats. Always
 * unsubscribes and clears the heartbeat on teardown.
 *
 * Resolves when streaming has fully stopped.
 */
export async function streamSSE(
  res: ServerResponseLike,
  sub: Subscription,
  opts: StreamSSEOptions = {},
): Promise<void> {
  const encode = opts.encode ?? ((ev: ConversationEvent) => JSON.stringify(ev));
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

  res.writeHead(200, SSE_HEADERS);

  let stopped = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const teardown = (): void => {
    if (stopped) return;
    stopped = true;
    if (heartbeat !== undefined) clearInterval(heartbeat);
    // Ends the subscription's async iterator, which unblocks the loop below.
    sub.unsubscribe();
  };

  res.on("close", teardown);
  if (opts.req) opts.req.on("close", teardown);
  onStop(opts.signal, teardown);

  heartbeat = setInterval(() => {
    if (stopped) return;
    try {
      res.write(": ping\n\n");
    } catch {
      teardown();
    }
  }, heartbeatMs);
  // Don't let the heartbeat timer keep the process alive on its own.
  (heartbeat as { unref?: () => void }).unref?.();

  try {
    for (;;) {
      const { value, ok } = await sub.receive();
      if (!ok) break;
      if (stopped) break;
      try {
        res.write(`data: ${encode(value!)}\n\n`);
      } catch {
        break;
      }
    }
  } finally {
    teardown();
  }
}
