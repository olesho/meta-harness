// Public barrel for `meta-harness/wrapper`.
//
// Exposes the classifier core public surface. Implementation details live under
// src/wrapper/internal/** and are aggregated by ./api.ts; this barrel re-exports
// only from non-internal modules so it never names an `internal` import path
// (the boundary the exports-guard test enforces). isSentinel is intentionally
// NOT re-exported here — it belongs to the internal async toolkit; callers reach
// the wrapper's cause-chain sentinels through isBinaryNotFound and the exported
// ErrInvalidConfig / ErrBinaryNotFound objects.
export * from "./api.js";
// Diagnostic trace vocabulary.
export * as trace from "./trace.js";
//# sourceMappingURL=index.js.map