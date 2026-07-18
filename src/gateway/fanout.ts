// Per-conversation SSE fanout primitive for the meta-harness-chatd daemon.
//
// Ports the Go `cmd/harness-chatd/sse.go` `fanout` type + `subscribe()`. A
// `Conversation.events()` (src/chat/conversation.ts) EventBus is a SINGLE-
// consumer buffered channel: `tryReceive()`/`receive()` REMOVE the event from
// the buffer, and `emit()` silently DROPS once full. There can therefore be
// exactly one drainer. `Fanout` is that sole drainer: on construction it starts
// a background loop reading `events()` and re-broadcasts each drained
// `ConversationEvent` to N independent subscribers.
//
// No-lost-events (mirrors the Go daemon's guarantee): events emitted between
// conversation open and the FIRST `subscribe()` are buffered and replayed to
// that first subscriber, so nothing observed before anyone attached is lost.
// After the first attach, the buffer is dropped and later subscribers see only
// events from their subscription point onward (Go's `pump`: broadcast to the
// current subscriber set, drop when a subscriber is slow/full).

import type { ConversationEvent } from "../chat/types.ts";

/**
 * The minimal receive surface `Fanout` drains — satisfied by the chat layer's
 * `EventBus` (`Conversation.events()`). Kept structural so tests can supply a
 * fake matching just `receive()`.
 */
export interface EventSource {
  /** Resolves `{value, ok:true}` per event, or `{ok:false}` once closed. */
  receive(): Promise<{ value?: ConversationEvent; ok: boolean }>;
}

/** Per-subscriber ring capacity; a full ring drops (Go's `default:` branch). */
const SUBSCRIBER_CAP = 64;

/**
 * A single fanout subscription: an async pull/iterator of events plus
 * `unsubscribe()`. Backed by a bounded ring — a slow consumer drops events
 * rather than stalling the drainer or its siblings.
 */
export class Subscription {
  private readonly buf: ConversationEvent[] = [];
  private waiter?: (r: { value?: ConversationEvent; ok: boolean }) => void;
  private closed = false;
  /** Installed by Fanout so `unsubscribe()` detaches from the subscriber set. */
  private detach: () => void = () => {};

  constructor(private readonly cap: number = SUBSCRIBER_CAP) {}

  /** Fanout-internal: register the detach hook run on unsubscribe. */
  _bind(detach: () => void): void {
    this.detach = detach;
  }

  /**
   * Fanout-internal: deliver one event. Non-blocking — hands off to a pending
   * waiter, else buffers, else DROPS when the ring is full (never blocks the
   * drainer). No-op once closed.
   */
  _push(ev: ConversationEvent): void {
    if (this.closed) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      w({ value: ev, ok: true });
      return;
    }
    if (this.buf.length >= this.cap) return;
    this.buf.push(ev);
  }

  /** Fanout-internal: mark end-of-stream and wake any pending receiver. */
  _close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      w({ value: undefined, ok: false });
    }
  }

  /** Pull the next event; `{ok:false}` once the subscription is closed/drained. */
  receive(): Promise<{ value?: ConversationEvent; ok: boolean }> {
    if (this.buf.length > 0)
      return Promise.resolve({ value: this.buf.shift(), ok: true });
    if (this.closed) return Promise.resolve({ value: undefined, ok: false });
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  /** Detach from the Fanout and free this subscription (idempotent). */
  unsubscribe(): void {
    this.detach();
    this._close();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ConversationEvent> {
    for (;;) {
      const { value, ok } = await this.receive();
      if (!ok) return;
      yield value!;
    }
  }
}

/**
 * Reads a conversation's single-consumer event channel and broadcasts each
 * event to all live subscribers. Sole drainer of the source.
 */
export class Fanout {
  private readonly subscribers = new Set<Subscription>();
  /** Events drained before the first subscriber attached (replayed once). */
  private pending: ConversationEvent[] = [];
  private firstAttached = false;
  private _closed = false;
  private readonly pumpDone: Promise<void>;

  /**
   * @param src the conversation's `events()` EventBus (or any `EventSource`).
   *            The background pump starts immediately, so no event is lost
   *            before a subscriber attaches.
   */
  constructor(src: EventSource) {
    this.pumpDone = this.pump(src);
  }

  private async pump(src: EventSource): Promise<void> {
    for (;;) {
      const { value, ok } = await src.receive();
      if (!ok) break;
      this.broadcast(value!);
    }
    // Source closed: end every subscriber and refuse future attaches.
    this._closed = true;
    for (const sub of this.subscribers) sub._close();
    this.subscribers.clear();
    this.pending = [];
  }

  private broadcast(ev: ConversationEvent): void {
    if (!this.firstAttached) {
      // Hold events until the first subscriber can replay them.
      this.pending.push(ev);
      return;
    }
    for (const sub of this.subscribers) sub._push(ev);
  }

  /**
   * Attach a new subscriber. The FIRST subscriber replays everything buffered
   * since construction; later subscribers start from now. If the source has
   * already closed, the returned subscription is already ended.
   */
  subscribe(): Subscription {
    const sub = new Subscription();
    if (this._closed) {
      sub._close();
      return sub;
    }
    sub._bind(() => this.subscribers.delete(sub));
    this.subscribers.add(sub);
    if (!this.firstAttached) {
      this.firstAttached = true;
      const replay = this.pending;
      this.pending = [];
      for (const ev of replay) sub._push(ev);
    }
    return sub;
  }

  /** True once the upstream source has closed and all subscribers ended. */
  get closed(): boolean {
    return this._closed;
  }

  /** Resolves when the background pump has finished (source closed). */
  done(): Promise<void> {
    return this.pumpDone;
  }
}
