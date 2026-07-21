// planAcquisition — the acquisition-mode decision function.
//
// This is the MH port of harness-wrapper's `planAcquisition`
// (pkg/harness/run.go), with `resolveProfile`/`acqPlan`, adapted to MH's
// existing detection layers. It is a PURE decision module: no I/O, no PTY, no
// wrapper. The integration subtask (a separate ticket) wires it into
// conversation.ts; here it is delivered stand-alone and unit-tested.
//
// The Go `ResolvedProfile` is a static Profile fed through runtime detection so
// each capability field is non-nil only when CONFIRMED for the run. MH has no
// single such struct, so `resolveProfile` below assembles the equivalent by
// combining THREE distinct facts that must NOT be conflated:
//
//   1. Installed / version / pin  — from src/discovery/discovery.ts (Info) and
//      src/versions/versions.ts (Entry.pinned / Entry.verifiedAt). Answers "is
//      this harness installed, at what version, pinned to what".
//   2. Per-capability presence    — does the resolved turns.Adapter actually
//      implement parseStreamLine (StreamParser) / resumeArgs (SessionResumer) /
//      readTranscript (TranscriptReader)? Answered by probing the object for the
//      optional method (`typeof adapter.<m> === "function"`), the same seam
//      MH's Backend/Adapter code already uses.
//   3. Capability-by-version      — does THIS installed binary's version support
//      the stream-json surface? A DISTINCT third fact: a version predicate over
//      versions.ts (pinned/verifiedAt). This is NOT "the adapter implements
//      StreamParser" — an adapter can carry the parser while the installed
//      binary is too old to emit the stream.
//
// Decision policy (explicit gate-and-fall-back). Stream is chosen ONLY when all
// three of these hold:
//   (a) the adapter implements parseStreamLine (fact 2),
//   (b) the version predicate says the installed binary supports stream-json
//       (fact 3), AND
//   (c) stream-json is emitted INTERLEAVED with the interactive TUI, per the
//       adapter's StreamInterleaved marker (fact 2).
// Otherwise Hooks is chosen when hook delivery is viable for the run; else Off.
//
// Because condition (c) fails for all four current A1 adapters (none mark
// themselves interleaved), planAcquisition's live output for real adapters is
// Hooks/Off and the Stream branch is reachable only by a synthetic interleaved
// fake. This is the accepted A1 outcome — the Stream branch is scaffolding.

import type {
  Adapter,
  AcquisitionMode,
  RequestedAcquisitionMode,
} from "../../turns/index.ts";
import {
  AcquisitionModeAuto,
  AcquisitionModeHooks,
  AcquisitionModeOff,
  AcquisitionModeStream,
} from "../../turns/index.ts";
import type { Info } from "../../discovery/discovery.ts";
import { pinned as versionPinned } from "../../versions/versions.ts";

// ── Fact 2: per-capability adapter presence ─────────────────────────────────

/**
 * The optional turns.Adapter capabilities that matter to acquisition, resolved
 * by structural probe (never by declared type). A capability is present only
 * when the adapter object actually carries the method.
 */
export interface AdapterCapabilities {
  /** adapter implements StreamParser.parseStreamLine. */
  hasStreamParser: boolean;
  /** adapter implements SessionResumer.resumeArgs. */
  hasSessionResumer: boolean;
  /** adapter implements TranscriptReader.readTranscript. */
  hasTranscriptReader: boolean;
  /**
   * adapter implements StreamInterleaved AND its marker returns true — i.e. the
   * harness emits stream-json interleaved with the interactive TUI so a live
   * tap can observe it. Absent interface ⇒ false (the conservative default).
   */
  streamInterleaved: boolean;
}

/**
 * probeAdapter resolves an adapter's optional acquisition capabilities by
 * structural probe — `typeof adapter.<method> === "function"` — exactly as MH's
 * Backend/Adapter seam and the tap-gate widening (integration subtask) do. It
 * never calls parseStreamLine/resumeArgs/readTranscript; it only invokes the
 * nullary streamInterleaved marker to read its boolean.
 */
export function probeAdapter(adapter: Adapter): AdapterCapabilities {
  // Probe optional methods off the concrete object. Adapter's declared type
  // does not include the optional capability interfaces, so widen to a record.
  const a = adapter as unknown as Record<string, unknown>;
  const hasStreamParser = typeof a.parseStreamLine === "function";
  const hasSessionResumer = typeof a.resumeArgs === "function";
  const hasTranscriptReader = typeof a.readTranscript === "function";

  let streamInterleaved = false;
  if (typeof a.streamInterleaved === "function") {
    streamInterleaved = (a.streamInterleaved as () => boolean)();
  }

  return {
    hasStreamParser,
    hasSessionResumer,
    hasTranscriptReader,
    streamInterleaved,
  };
}

// ── Fact 3: capability-by-version ───────────────────────────────────────────

/**
 * StreamVersionPredicate answers fact 3: does THIS installed binary's version
 * support the stream-json surface the live tap needs? It is a predicate over
 * versions.ts (pinned/verifiedAt), DISTINCT from "the adapter implements
 * StreamParser". Injected so tests can drive the version gate independently of
 * the embedded versions.json.
 */
export type StreamVersionPredicate = (harness: string) => boolean;

/**
 * defaultStreamVersionPredicate ties fact 3 to versions.ts exactly as described:
 * the installed binary is treated as stream-json-capable only when the harness
 * carries a confirmed pin (versions.pinned returns a non-empty version, which is
 * emitted only when Entry.pinned is set and, by the versions.ts invariant, was
 * verified). An unpinned/unknown harness is conservatively treated as NOT
 * supporting the stream surface.
 */
export const defaultStreamVersionPredicate: StreamVersionPredicate = (
  harness,
) => {
  const [, ok] = versionPinned(harness);
  return ok;
};

// ── The ResolvedProfile-analogue ────────────────────────────────────────────

/**
 * ResolvedProfile is MH's analogue of Go's ResolvedProfile: the three facts
 * above resolved for one run. A capability is "confirmed" only when the
 * corresponding field says so — mirroring Go's non-nil-means-confirmed contract.
 */
export interface ResolvedProfile {
  /** Canonical harness key (versions.json name). Empty when unknown. */
  harness: string;
  /** Fact 1: the binary was found installed for the run. */
  installed: boolean;
  /** Fact 1: the version detected/pinned for the run ("" when unknown). */
  version: string;
  /** Fact 1: the harness carries a confirmed pin in versions.json. */
  hasPin: boolean;
  /** Fact 2: the resolved adapter's optional capabilities. */
  capabilities: AdapterCapabilities;
  /** Fact 3: this installed version supports the stream-json surface. */
  streamJSONSupported: boolean;
}

/** Inputs to resolveProfile. Kept structural so tests supply plain fakes. */
export interface ResolveProfileInput {
  /**
   * Fact 1 — the discovery result for the run's harness. Only the identity /
   * install / version fields are consulted; a `Pick` of Info satisfies it, so
   * tests need not build a whole Info.
   */
  info: Pick<
    Info,
    "harness" | "installed" | "detectedVersion" | "pinnedVersion"
  >;
  /** The resolved turns adapter for the run (probed structurally, fact 2). */
  adapter: Adapter;
  /**
   * Fact 3 — the version predicate. Defaults to the versions.json-backed
   * predicate; tests override it to drive the version gate.
   */
  streamVersionPredicate?: StreamVersionPredicate;
}

/**
 * resolveProfile assembles the ResolvedProfile from the three facts. It is the
 * MH analogue of Go's `resolveProfile` (which fed a static Profile through
 * runtime detection). Pure: it reads its inputs and the injected predicate only.
 */
export function resolveProfile(input: ResolveProfileInput): ResolvedProfile {
  const { info, adapter } = input;
  const predicate =
    input.streamVersionPredicate ?? defaultStreamVersionPredicate;

  const capabilities = probeAdapter(adapter);
  // Prefer the detected version; fall back to the pin when detection didn't run.
  const version =
    info.detectedVersion !== "" ? info.detectedVersion : info.pinnedVersion;
  const hasPin = info.pinnedVersion !== "";
  // Fact 3 is a property of the installed binary, so it is only meaningful when
  // the harness is actually installed for the run.
  const streamJSONSupported = info.installed && predicate(info.harness);

  return {
    harness: info.harness,
    installed: info.installed,
    version,
    hasPin,
    capabilities,
    streamJSONSupported,
  };
}

// ── The decision function ───────────────────────────────────────────────────

/**
 * PlanContext bundles the run-level facts planAcquisition needs beyond the
 * requested mode: the resolved profile, whether an event sink exists, and
 * whether hook delivery is viable for the run.
 */
export interface PlanContext {
  /** The three facts resolved for the run. */
  profile: ResolvedProfile;
  /**
   * Whether an event sink exists for the run (Go's `haveSink`). With no sink
   * there is nothing to acquire into, so the plan is Off regardless of mode.
   */
  haveSink: boolean;
  /**
   * Whether hook-based delivery is viable for the run — a HookProvider resolved
   * and its config can be ensured. The Hooks fall-back rung.
   */
  hooksViable: boolean;
}

/**
 * streamEligible reports whether the Stream gate's three conditions all hold:
 *   (a) the adapter implements parseStreamLine,
 *   (b) the installed version supports stream-json, AND
 *   (c) the adapter marks its stream-json as interleaved with the TUI.
 * Exposed so the integration subtask and tests can assert the gate directly.
 */
export function streamEligible(profile: ResolvedProfile): boolean {
  return (
    profile.capabilities.hasStreamParser &&
    profile.streamJSONSupported &&
    profile.capabilities.streamInterleaved
  );
}

/**
 * planAcquisition maps the requested mode + resolved context to the acquisition
 * mode actually used for the run. Mirrors Go's planAcquisition switch, with the
 * MH gate-and-fall-back policy:
 *
 *   - No sink                       → Off (nothing to acquire into).
 *   - requested Off                 → Off (explicit opt-out; a session id may
 *                                     still be captured elsewhere).
 *   - requested Stream              → Stream when streamEligible, else fall back
 *                                     to Hooks (if viable) else Off.
 *   - requested Hooks               → Hooks when viable; else Stream when
 *                                     streamEligible; else Off.
 *   - requested Auto                → best available: identical to the
 *                                     requested-Hooks resolution above. `auto`
 *                                     is a request-only token; it is resolved
 *                                     to a concrete mode and never returned.
 *
 * Because streamEligible is false for all four current A1 adapters (none are
 * interleaved), real-adapter output is Hooks/Off; the Stream branch is reached
 * only by a synthetic interleaved fake.
 */
export function planAcquisition(
  requested: RequestedAcquisitionMode,
  ctx: PlanContext,
): AcquisitionMode {
  if (!ctx.haveSink) {
    return AcquisitionModeOff;
  }

  const eligible = streamEligible(ctx.profile);

  switch (requested) {
    case AcquisitionModeOff:
      return AcquisitionModeOff;
    case AcquisitionModeStream:
      if (eligible) {
        return AcquisitionModeStream;
      }
      return ctx.hooksViable ? AcquisitionModeHooks : AcquisitionModeOff;
    // `auto` resolves to "best available channel" — identical to a requested
    // Hooks. Routed through the SAME arm (bare fall-through) so the two can
    // never diverge; the distinct string literals make the fall-through safe.
    case AcquisitionModeAuto:
    case AcquisitionModeHooks:
      if (ctx.hooksViable) {
        return AcquisitionModeHooks;
      }
      if (eligible) {
        return AcquisitionModeStream;
      }
      return AcquisitionModeOff;
    default:
      // Exhaustive over RequestedAcquisitionMode (off/stream/hooks/auto);
      // `requested` narrows to `never` here. Conservative dead-but-safe net.
      return AcquisitionModeOff;
  }
}

/**
 * replanAfterStreamFailure is the runtime fall-back seam (belt and suspenders).
 * When a run planned to Stream but the live stream produced no parseable events
 * within the turn — a live stream failure — the acquisition must degrade rather
 * than hang waiting for events that never come. The integration subtask invokes
 * this (as a hook/flag or re-plan entry point) to re-derive the mode after the
 * failure: Hooks when hook delivery is viable for the run, else Off.
 *
 * Kept distinct from planAcquisition so the failure path is a single, testable
 * seam the tap/StreamTap layer can call without re-running the full plan.
 */
export function replanAfterStreamFailure(ctx: PlanContext): AcquisitionMode {
  return ctx.hooksViable ? AcquisitionModeHooks : AcquisitionModeOff;
}
