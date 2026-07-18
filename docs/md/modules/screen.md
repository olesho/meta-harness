# `meta-harness/screen`

A headless VT100 terminal emulator (built on `@xterm/headless`) behind a small,
concurrency-safe surface. Raw PTY bytes from a harness go in via `write()`; coherent,
retainable [`Snapshot`](#snapshot)s of the rendered screen come out via `snapshot()`. A
[`subscribe()`](#methods) channel fires after every write so consumers react to change
without polling.

The screen is the substrate the [`turns`](turns.md) layer reads to decide what a harness
is showing. It exposes only what that layer needs: rendered text, dimensions, cursor, and
a monotonic generation counter.

```ts
import {
  newScreen,
  Screen,
  type Snapshot,
  type Notify,
} from "meta-harness/screen";
```

---

## `Screen`

```ts
new Screen(cols: number, rows: number)
newScreen(cols: number, rows: number): Screen   // factory; mirrors Go's screen.New
```

Construct an emulator of the given cell dimensions. Non-positive inputs fall back to
120×40 (forgiving for tests). In practice you rarely build one yourself — a
[`Conversation`](chat.md) creates it and hands it to the wrapper as the PTY sink.

### Methods

```ts
write(data: string | Uint8Array): Promise<void>
```

Feed raw PTY bytes (ANSI escapes intact) into the emulator. On success it bumps the
generation counter and signals every subscriber. Writes are serialized behind a mutex, so
the generation count is exact even under interleaved async writes.

```ts
snapshot(): Snapshot
```

A coherent point-in-time view (see [`Snapshot`](#snapshot)). Lock-free and synchronous —
safe to call any time; the returned object is plain values, safe to retain.

```ts
generation(): number
```

The current write counter, without rendering a snapshot. Cheap change-detection.

```ts
resize(cols: number, rows: number): void
```

Change dimensions, preserving content as best the emulator allows. Bumps generation and
signals subscribers.

```ts
subscribe(): [Notify, () => void]
```

Returns a `[notify, unsubscribe]` tuple. `notify` is a coalesced (size-1) channel that
fires after every successful `write()` or `resize()`; `unsubscribe()` removes and closes
it. This is how the [`Watcher`](turns.md#the-watcher) reacts to screen changes.

---

## `Snapshot`

```ts
interface Snapshot {
  text: string; // rendered contents, top-to-bottom, one '\n' per row; trailing whitespace preserved
  cols: number;
  rows: number;
  cursorCol: number; // 0-indexed
  cursorRow: number;
  generation: number; // increments on each successful write/resize
}
```

The `text` is what turn adapters pattern-match against (prompt regions, thinking markers,
tool-call lines, session-id rows). Trailing per-row whitespace is preserved deliberately,
mirroring the Go `vt10x` emulator's behavior so recorded corpora stay comparable.

---

## `Notify`

```ts
interface Notify {
  receive(): Promise<{ ok: boolean }>;
}
```

A coalesced notification channel (like a Go `chan struct{}` of capacity 1). `receive()`
resolves `{ ok: true }` when a signal is available, or `{ ok: false }` once the
subscription is closed and drained. At most one signal buffers — firing while one is
pending is a no-op. The consumer pattern is: `await notify.receive()` → `screen.snapshot()`
→ analyze.

---

## How it's used

- A [`Conversation`](chat.md) builds a `Screen` with `newScreen(cols, rows)` and passes
  it to [`wrapper.start`](wrapper.md) as the `stdout` sink; the PTY read loop `write()`s
  harness bytes into it.
- The [`turns.Watcher`](turns.md#the-watcher) `subscribe()`s and feeds each `snapshot()`
  to the adapter's `onScreen()`.
- `Conversation.screenSnapshot()` exposes the current view to you directly.
