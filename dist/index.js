// meta-harness — library root.
//
// This barrel is intentional: it exports only the package VERSION and curated,
// public re-exports. Nothing private is surfaced here. The internal async
// toolkit under `src/internal/**` stays private too — with ONE sanctioned
// exception: the `meta-harness/async` subpath re-exports just the Context
// cancellation primitive (Context / ctxCanceled / ctxDeadlineExceeded /
// fromAbortSignal) that chat.send / chat.acquireControl require. No other public
// subpath barrel (./screen, ./wrapper, ./turns, ./transcript, ./chat,
// ./discovery, ./versions) exposes anything from `src/internal/**`.
export const VERSION = "0.0.0";
//# sourceMappingURL=index.js.map