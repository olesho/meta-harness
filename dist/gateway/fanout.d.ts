import type { ConversationEvent } from "../chat/types.ts";
/**
 * The minimal receive surface `Fanout` drains — satisfied by the chat layer's
 * `EventBus` (`Conversation.events()`). Kept structural so tests can supply a
 * fake matching just `receive()`.
 */
export interface EventSource {
    /** Resolves `{value, ok:true}` per event, or `{ok:false}` once closed. */
    receive(): Promise<{
        value?: ConversationEvent;
        ok: boolean;
    }>;
}
/**
 * A single fanout subscription: an async pull/iterator of events plus
 * `unsubscribe()`. Backed by a bounded ring — a slow consumer drops events
 * rather than stalling the drainer or its siblings.
 */
export declare class Subscription {
    private readonly cap;
    private readonly buf;
    private waiter?;
    private closed;
    /** Installed by Fanout so `unsubscribe()` detaches from the subscriber set. */
    private detach;
    constructor(cap?: number);
    /** Fanout-internal: register the detach hook run on unsubscribe. */
    _bind(detach: () => void): void;
    /**
     * Fanout-internal: deliver one event. Non-blocking — hands off to a pending
     * waiter, else buffers, else DROPS when the ring is full (never blocks the
     * drainer). No-op once closed.
     */
    _push(ev: ConversationEvent): void;
    /** Fanout-internal: mark end-of-stream and wake any pending receiver. */
    _close(): void;
    /** Pull the next event; `{ok:false}` once the subscription is closed/drained. */
    receive(): Promise<{
        value?: ConversationEvent;
        ok: boolean;
    }>;
    /** Detach from the Fanout and free this subscription (idempotent). */
    unsubscribe(): void;
    [Symbol.asyncIterator](): AsyncIterator<ConversationEvent>;
}
/**
 * Reads a conversation's single-consumer event channel and broadcasts each
 * event to all live subscribers. Sole drainer of the source.
 */
export declare class Fanout {
    private readonly subscribers;
    /** Events drained before the first subscriber attached (replayed once). */
    private pending;
    private firstAttached;
    private _closed;
    private readonly pumpDone;
    /**
     * @param src the conversation's `events()` EventBus (or any `EventSource`).
     *            The background pump starts immediately, so no event is lost
     *            before a subscriber attaches.
     */
    constructor(src: EventSource);
    private pump;
    private broadcast;
    /**
     * Attach a new subscriber. The FIRST subscriber replays everything buffered
     * since construction; later subscribers start from now. If the source has
     * already closed, the returned subscription is already ended.
     */
    subscribe(): Subscription;
    /** True once the upstream source has closed and all subscribers ended. */
    get closed(): boolean;
    /** Resolves when the background pump has finished (source closed). */
    done(): Promise<void>;
}
//# sourceMappingURL=fanout.d.ts.map