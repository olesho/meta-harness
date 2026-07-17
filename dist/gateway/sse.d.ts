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
export type StopSignal = AbortSignal | Promise<void> | ((onStop: () => void) => void);
/** Registers `cb` to run once when `sig` fires. No-op if `sig` is undefined. */
export declare function onStop(sig: StopSignal | undefined, cb: () => void): void;
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
/**
 * Stream a Fanout subscription to an SSE response until the subscription ends
 * or a stop condition fires (`res`/`req` `'close'`, or `opts.signal`). Writes
 * headers, per-event `data:` frames, and periodic `: ping` heartbeats. Always
 * unsubscribes and clears the heartbeat on teardown.
 *
 * Resolves when streaming has fully stopped.
 */
export declare function streamSSE(res: ServerResponseLike, sub: Subscription, opts?: StreamSSEOptions): Promise<void>;
//# sourceMappingURL=sse.d.ts.map