import { type EventEnvelope, type ParsedEvent } from "../../transcript/index.ts";
import { type AcquisitionMode } from "../../turns/index.ts";
import type { DisplaySink } from "./display.ts";
/** parseStreamLine, structurally bound off the resolved turns.Adapter. */
export type StreamLineParser = (line: string) => ParsedEvent[];
/** Config wiring a StreamTap to its run-level identity and consumers. */
export interface StreamTapConfig {
    /** Canonical harness key stamped onto every envelope. */
    harness: string;
    /** Run identity stamped onto every envelope (the chat session id in MH). */
    runID: string;
    /**
     * The LATCHED acquisition mode for the run (as chosen by planAcquisition).
     * Live stream events are emitted ONLY when this is Stream; under Hooks/Off the
     * live fan-off is inert (display still runs). Passed to `admitParent` as the
     * effective parent-source authority.
     */
    mode: AcquisitionMode;
    /**
     * adapter.parseStreamLine (bound), or null/undefined when the adapter carries
     * no StreamParser — in which case no live events are ever produced.
     */
    parser?: StreamLineParser | null;
    /**
     * The acquisition event bridge. Admitted, stamped envelopes are delivered here.
     * Absent ⇒ events are stamped/seq'd but not delivered (display-only runs).
     */
    onEvent?: (env: EventEnvelope) => void;
    /** Best-effort bounded display sink (every raw line, never blocking). */
    display?: DisplaySink | null;
    /**
     * Reads the chat-owned, already-captured harness session id ("" until capture
     * completes). StreamTap reads it to stamp events; it NEVER writes it.
     */
    sessionID: () => string;
    /**
     * Invoked once when an onEvent delivery throws. The run is being torn down;
     * StreamTap goes inert after the first failure (mirrors the Go cancel seam).
     */
    onDeliverError?: (err: unknown) => void;
}
/**
 * StreamTap receives raw lines off the shared durable onLine callback, parses
 * them into events via the adapter's StreamParser, stamps run/harness ids and a
 * monotonic arrival-order seq, filters through `admitParent`, and routes
 * admitted events to the acquisition consumers.
 *
 * Single-threaded like the Go original's goroutine-confined tap: onLine is
 * invoked serially by the LineSplitter, so the mutable fields need no locking.
 */
export declare class StreamTap {
    private readonly cfg;
    private seq;
    private deliverErr;
    /**
     * Envelopes emitted before the session id was known, retained so their id can
     * be backfilled in place once capture completes. Holds the SAME object handed
     * to onEvent (the consumer sees the backfill through its reference).
     */
    private readonly pending;
    constructor(cfg: StreamTapConfig);
    /**
     * installs reports whether the durable line tap must be attached FOR THIS TAP.
     * The tap is needed whenever a live-stream consumer (a StreamParser under an
     * onEvent bridge) or a display sink is present. chat's tap-gate ORs this with
     * its own raw-session-id need, so the single onLine callback is created when
     * EITHER consumer needs it.
     */
    installs(): boolean;
    /** True once live stream events should be emitted (Stream mode + a parser). */
    private emitLive;
    /**
     * onLine is the per-line half of the shared onLine fan-out. It pushes the raw
     * line to the best-effort display sink (always, independent of the transcript
     * path and never blocking) and, in Stream mode, parses + emits live events.
     * Once a delivery has failed it becomes inert (the run is being torn down).
     */
    onLine(line: string): void;
    /**
     * emit shapes one ParsedEvent into an envelope, applies the central authority
     * filter for the latched mode, stamps seq + schema, and delivers it. Returns
     * false only when delivery threw (the caller stops); a filtered-out event
     * returns true. Events whose id is not yet known are recorded for backfill.
     */
    private emit;
    /**
     * backfill stamps the now-known chat-captured session id onto every event that
     * was emitted before capture completed. Idempotent and safe to call whenever
     * capture MIGHT have completed (chat calls it after each capture attempt): a
     * no-op while the id is still empty, and it clears the retained set once done.
     * Mutates the retained envelope objects in place — the consumer observes the
     * backfill through the reference it already holds.
     */
    backfill(): void;
    /** Test/diagnostic: the count of events still awaiting an id backfill. */
    pendingCount(): number;
    /** Test/diagnostic: the next arrival-order seq (i.e. the count emitted so far). */
    seqCount(): number;
}
/**
 * adapterStreamParser structurally probes an adapter for StreamParser and
 * returns its `parseStreamLine` bound to the adapter, or null when absent — the
 * SAME `typeof … === "function"` seam planAcquisition's probeAdapter uses. chat's
 * tap-gate uses this both to widen the tap-instantiation condition and to wire
 * the parser into the StreamTap.
 */
export declare function adapterStreamParser(adapter: unknown): StreamLineParser | null;
//# sourceMappingURL=streamTap.d.ts.map