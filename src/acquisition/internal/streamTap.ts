// StreamTap — the per-run consumer of chat's durable PTY line tap. TS port of
// harness-wrapper's pkg/harness/run.go `streamTap` (onLine / emit / deliver /
// installs), adapted to MH's chat seam.
//
// Load-bearing channel decision (see META-HARNESS-57): StreamTap is a PARALLEL
// CONSUMER of the SAME PTY byte stream chat already taps for raw session-id
// capture (StartConfig.onLine → wrapper/internal/linetap.ts). It adds NO second
// PTY reader and NO second launch: chat fans the single durable onLine callback
// out to BOTH `captureRawSessionID` (unchanged) and this tap. The rendered
// `Screen` + `Backend.watch` remain the SOLE turn-state authority — StreamTap
// routes admitted events to the acquisition consumers only (a bounded display
// sink / an onEvent bridge), never to the turn-state watcher.
//
// Session-id ownership boundary (correctness — must hold): chat's existing
// `captureRawSessionID` / SessionIDExtractor chain remains the SINGLE authority
// that writes the persisted session record. StreamTap ONLY reads the
// already-captured id (via the injected `sessionID()` getter) to STAMP events;
// it never writes the session record. Because stream-event lines and the
// session-id-bearing line arrive on the same ordered onLine callback, an early
// stream event can be emitted BEFORE capture completes (a cross-line hazard).
// StreamTap tolerates this: such an event ships with an EMPTY id, is retained,
// and is BACKFILLED in place once the id becomes known (see `backfill`) — never
// dropped, never left permanently blank.
//
// TODO(packaging subtask): this module lives under src/acquisition/internal and
// is imported directly by src/chat/conversation.ts. If StreamTap needs a PUBLIC
// entry point, the separate packaging subtask owns adding the barrel export — do
// NOT re-export it from a public barrel here.

import {
  SchemaVersion,
  SourceLive,
  type EventEnvelope,
  type ParsedEvent,
} from "../../transcript/index.ts"
import {
  AcquisitionModeStream,
  type AcquisitionMode,
} from "../../turns/index.ts"
import { admitParent } from "./filter.ts"
import type { DisplaySink } from "./display.ts"

/** parseStreamLine, structurally bound off the resolved turns.Adapter. */
export type StreamLineParser = (line: string) => ParsedEvent[]

/** Config wiring a StreamTap to its run-level identity and consumers. */
export interface StreamTapConfig {
  /** Canonical harness key stamped onto every envelope. */
  harness: string
  /** Run identity stamped onto every envelope (the chat session id in MH). */
  runID: string
  /**
   * The LATCHED acquisition mode for the run (as chosen by planAcquisition).
   * Live stream events are emitted ONLY when this is Stream; under Hooks/Off the
   * live fan-off is inert (display still runs). Passed to `admitParent` as the
   * effective parent-source authority.
   */
  mode: AcquisitionMode
  /**
   * adapter.parseStreamLine (bound), or null/undefined when the adapter carries
   * no StreamParser — in which case no live events are ever produced.
   */
  parser?: StreamLineParser | null
  /**
   * The acquisition event bridge. Admitted, stamped envelopes are delivered here.
   * Absent ⇒ events are stamped/seq'd but not delivered (display-only runs).
   */
  onEvent?: (env: EventEnvelope) => void
  /** Best-effort bounded display sink (every raw line, never blocking). */
  display?: DisplaySink | null
  /**
   * Reads the chat-owned, already-captured harness session id ("" until capture
   * completes). StreamTap reads it to stamp events; it NEVER writes it.
   */
  sessionID: () => string
  /**
   * Invoked once when an onEvent delivery throws. The run is being torn down;
   * StreamTap goes inert after the first failure (mirrors the Go cancel seam).
   */
  onDeliverError?: (err: unknown) => void
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
export class StreamTap {
  private readonly cfg: StreamTapConfig
  private seq = 0
  private deliverErr = false
  /**
   * Envelopes emitted before the session id was known, retained so their id can
   * be backfilled in place once capture completes. Holds the SAME object handed
   * to onEvent (the consumer sees the backfill through its reference).
   */
  private readonly pending: EventEnvelope[] = []

  constructor(cfg: StreamTapConfig) {
    this.cfg = cfg
  }

  /**
   * installs reports whether the durable line tap must be attached FOR THIS TAP.
   * The tap is needed whenever a live-stream consumer (a StreamParser under an
   * onEvent bridge) or a display sink is present. chat's tap-gate ORs this with
   * its own raw-session-id need, so the single onLine callback is created when
   * EITHER consumer needs it.
   */
  installs(): boolean {
    return (this.cfg.parser != null && this.cfg.onEvent != null) || this.cfg.display != null
  }

  /** True once live stream events should be emitted (Stream mode + a parser). */
  private emitLive(): boolean {
    return this.cfg.mode === AcquisitionModeStream && this.cfg.parser != null
  }

  /**
   * onLine is the per-line half of the shared onLine fan-out. It pushes the raw
   * line to the best-effort display sink (always, independent of the transcript
   * path and never blocking) and, in Stream mode, parses + emits live events.
   * Once a delivery has failed it becomes inert (the run is being torn down).
   */
  onLine(line: string): void {
    this.cfg.display?.push(line)
    if (this.deliverErr) return
    if (!this.emitLive()) return
    const parser = this.cfg.parser
    if (!parser) return
    for (const pe of parser(line)) {
      if (!this.emit(pe)) return
    }
  }

  /**
   * emit shapes one ParsedEvent into an envelope, applies the central authority
   * filter for the latched mode, stamps seq + schema, and delivers it. Returns
   * false only when delivery threw (the caller stops); a filtered-out event
   * returns true. Events whose id is not yet known are recorded for backfill.
   */
  private emit(pe: ParsedEvent): boolean {
    const source = pe.event.source ?? SourceLive
    const isSubagent = (pe.parentSessionID ?? "") !== ""
    if (!admitParent(this.cfg.mode, source as "live" | "file", pe.event.type ?? "", isSubagent)) {
      return true
    }

    const ev = { ...pe.event }
    ev.seq = this.seq
    ev.schemaVersion = SchemaVersion
    this.seq++

    // hsid precedence: the parser-supplied id wins; else backfill from the
    // chat-captured id; else leave EMPTY and retain for after-the-fact backfill.
    const parsedID = pe.harnessSessionID ?? ""
    const hsid = parsedID !== "" ? parsedID : this.cfg.sessionID()

    const env: EventEnvelope = {
      runID: this.cfg.runID,
      harness: this.cfg.harness,
      harnessSessionID: hsid,
      parentSessionID: pe.parentSessionID,
      event: ev,
    }
    // Retain for backfill ONLY when the id is still unknown AND the parser did
    // not supply one (a parser-supplied id is final and never re-stamped).
    if (hsid === "" && parsedID === "") {
      this.pending.push(env)
    }

    if (!this.cfg.onEvent) return true
    try {
      this.cfg.onEvent(env)
    } catch (err) {
      this.deliverErr = true
      this.cfg.onDeliverError?.(err)
      return false
    }
    return true
  }

  /**
   * backfill stamps the now-known chat-captured session id onto every event that
   * was emitted before capture completed. Idempotent and safe to call whenever
   * capture MIGHT have completed (chat calls it after each capture attempt): a
   * no-op while the id is still empty, and it clears the retained set once done.
   * Mutates the retained envelope objects in place — the consumer observes the
   * backfill through the reference it already holds.
   */
  backfill(): void {
    if (this.pending.length === 0) return
    const id = this.cfg.sessionID()
    if (id === "") return
    for (const env of this.pending) {
      if (env.harnessSessionID === "") env.harnessSessionID = id
    }
    this.pending.length = 0
  }

  /** Test/diagnostic: the count of events still awaiting an id backfill. */
  pendingCount(): number {
    return this.pending.length
  }

  /** Test/diagnostic: the next arrival-order seq (i.e. the count emitted so far). */
  seqCount(): number {
    return this.seq
  }
}

/**
 * adapterStreamParser structurally probes an adapter for StreamParser and
 * returns its `parseStreamLine` bound to the adapter, or null when absent — the
 * SAME `typeof … === "function"` seam planAcquisition's probeAdapter uses. chat's
 * tap-gate uses this both to widen the tap-instantiation condition and to wire
 * the parser into the StreamTap.
 */
export function adapterStreamParser(adapter: unknown): StreamLineParser | null {
  const a = adapter as Record<string, unknown>
  if (a && typeof a.parseStreamLine === "function") {
    return (line: string) => (a.parseStreamLine as StreamLineParser).call(a, line)
  }
  return null
}
