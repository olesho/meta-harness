import type { Adapter, AcquisitionMode, RequestedAcquisitionMode } from "../../turns/index.ts";
import type { Info } from "../../discovery/discovery.ts";
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
export declare function probeAdapter(adapter: Adapter): AdapterCapabilities;
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
export declare const defaultStreamVersionPredicate: StreamVersionPredicate;
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
    info: Pick<Info, "harness" | "installed" | "detectedVersion" | "pinnedVersion">;
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
export declare function resolveProfile(input: ResolveProfileInput): ResolvedProfile;
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
export declare function streamEligible(profile: ResolvedProfile): boolean;
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
export declare function planAcquisition(requested: RequestedAcquisitionMode, ctx: PlanContext): AcquisitionMode;
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
export declare function replanAfterStreamFailure(ctx: PlanContext): AcquisitionMode;
//# sourceMappingURL=planAcquisition.d.ts.map