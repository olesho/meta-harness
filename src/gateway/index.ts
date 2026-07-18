// Public barrel for `meta-harness/gateway` — the HTTP+SSE wire layer for the
// meta-harness-chatd daemon. This subtask ships the per-conversation event
// fanout + SSE framing; daemon-core wiring lives in a sibling subtask.

export { Fanout, Subscription, type EventSource } from "./fanout.ts";
export {
  streamSSE,
  onStop,
  type StopSignal,
  type StreamSSEOptions,
  type ServerResponseLike,
  type RequestLike,
} from "./sse.ts";

export {
  Server,
  newToken,
  eventDTO,
  parseBind,
  main,
  type ConversationLike,
  type Opener,
} from "./server.ts";
