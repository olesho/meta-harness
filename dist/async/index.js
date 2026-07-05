// Public barrel for `meta-harness/async`.
//
// This is the ONE sanctioned bridge from the internal async toolkit to the
// public API. chat.send / chat.acquireControl require a Context, so callers must
// be able to construct the cancellation/deadline primitive — but the rest of the
// toolkit (Channel, Mutex, ControlQueue, the sentinel/cause helpers) stays
// private under src/internal/**. Only the names below cross the boundary:
//
//   Context               — the cancellation/deadline primitive
//     .background()        — the root, never-cancelled context
//     .withCancel(parent)  — a child + an explicit cancel(cause?) (ctxCanceled)
//     .withDeadline(p, ms) — a child that auto-cancels with ctxDeadlineExceeded
//   ctxCanceled           — cause sentinel for an explicit/abort cancel
//   ctxDeadlineExceeded   — cause sentinel for a deadline expiry
//   fromAbortSignal       — adapt a DOM AbortSignal (+ optional deadline)
//
// The exports-guard test freezes this list: surfacing anything else from
// src/internal/** here is a boundary violation.
export { Context, ctxCanceled, ctxDeadlineExceeded, } from "../internal/async/context.js";
export { fromAbortSignal } from "./fromAbortSignal.js";
//# sourceMappingURL=index.js.map