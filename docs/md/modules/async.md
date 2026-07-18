# `meta-harness/async`

The one sanctioned bridge from the private internal concurrency toolkit to the public
API. It surfaces **exactly** the `Context` cancellation/deadline primitive — nothing
else from `src/internal/async/**` (not `Channel`, not `Mutex`, not `isSentinel`). This
narrow leak exists because every blocking [`chat`](chat.md) and [`oneshot`](oneshot.md)
method takes a `Context`, so callers must be able to construct one.

The boundary is enforced by [`test/exports-guard.test.ts`](../../../test/exports-guard.test.ts):
this subpath may export only the four names below.

```ts
import {
  Context,
  ctxCanceled,
  ctxDeadlineExceeded,
  fromAbortSignal,
} from "meta-harness/async";
```

---

## `Context`

The cancellation/deadline primitive, a faithful port of Go's `context.Context`.
Cancellation and deadlines propagate **parent → child** down a tree: cancelling a parent
cancels its descendants; a child can be cancelled without touching its parent or
siblings.

### Static constructors

```ts
Context.background(): Context
```

The root, never-cancelled context. Its `done()` never resolves and `err()` is always
`undefined`. Use it as the top of a tree, or as the `ctx` when you don't need
cancellation.

```ts
Context.withCancel(parent: Context): { ctx: Context; cancel: CancelFn }
```

A child context plus an explicit `cancel(cause?)`. Calling `cancel()` resolves the
child's `done()` and sets `err()` to the given cause, or to
[`ctxCanceled`](#sentinels) if none is supplied.

```ts
Context.withDeadline(parent: Context, ms: number): { ctx: Context; cancel: CancelFn }
```

A child that auto-cancels after `ms` milliseconds with
[`ctxDeadlineExceeded`](#sentinels). You also get an explicit `cancel()`; whichever fires
first (deadline or explicit) wins and sets the cause. **Always call `cancel()`** (e.g. in
a `finally`) even after a normal completion, to release the timer.

### Instance methods

```ts
ctx.done(): Promise<void>   // resolves when cancelled or the deadline passes; awaitable repeatedly
ctx.err(): unknown          // the cancellation cause (a Sentinel), or undefined while active
ctx.isDone(): boolean       // true once cancelled/expired (=== err() !== undefined)
```

`err()` returns one of the [sentinels](#sentinels), so a caller can distinguish a
timeout (`ctxDeadlineExceeded`) from an abort (`ctxCanceled`):

```ts
await ctx.done();
if (ctx.err() === ctxDeadlineExceeded) {
  /* timed out */
}
```

---

## Sentinels

```ts
ctxCanceled: Sentinel; // explicit cancel() / aborted AbortSignal
ctxDeadlineExceeded: Sentinel; // deadline elapsed
```

Stable, identity-comparable cause objects. Compare with `===` (as above) or, when they
may be wrapped in a cause chain, with `isSentinel` from the internal toolkit. Downstream
layers key on this distinction — e.g. the wrapper reports "context deadline exceeded" vs
"context cancelled", and the [CLI](cli.md) maps a deadline to exit code `124`.

---

## `CancelFn`

```ts
type CancelFn = (cause?: unknown) => void;
```

The function returned alongside a child context. Calling it resolves the context's
`done()` with the given cause (or `ctxCanceled` if omitted). Type-only — erased at
runtime.

---

## `fromAbortSignal`

```ts
fromAbortSignal(signal: AbortSignal, deadlineMs?: number): Context
```

Adapt a DOM `AbortSignal` into a `Context`. Used to bridge an orchestrator's
`AbortSignal`-based cancellation into meta-harness's `Context`-based API.

- If `signal` is already aborted, returns an already-cancelled context.
- If `deadlineMs` is a positive number, the context _also_ auto-cancels with
  `ctxDeadlineExceeded` after that delay.
- Whichever fires first (abort → `ctxCanceled`, deadline → `ctxDeadlineExceeded`) sets
  the cause.
- The abort listener is cleaned up once the context finishes, so a deadline expiry never
  leaves a dangling listener on the signal.

```ts
const ac = new AbortController();
const ctx = fromAbortSignal(ac.signal, 30_000); // abort OR 30s, whichever first
await conv.send(ctx, "…");
```

---

## What stays private

`Context` is the _only_ thing that crosses the boundary. The rest of the internal
toolkit — `Channel<T>` (a Go `chan`), `Mutex`, `ControlQueue` (the FIFO turnstile behind
[`acquireControl`](chat.md#sending--control)), and the `Sentinel`/`defineSentinel`/`wrap`/
`isSentinel` error system — lives under `src/internal/async/**` and powers the layers
above without being part of the public surface. See
[Architecture › Go heritage](../architecture.md#go-heritage) for the mapping.
