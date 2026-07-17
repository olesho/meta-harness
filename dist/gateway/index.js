// Public barrel for `meta-harness/gateway` — the HTTP+SSE wire layer for the
// meta-harness-chatd daemon. This subtask ships the per-conversation event
// fanout + SSE framing; daemon-core wiring lives in a sibling subtask.
export { Fanout, Subscription } from "./fanout.js";
export { streamSSE, onStop, } from "./sse.js";
//# sourceMappingURL=index.js.map