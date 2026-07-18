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
import { AcquisitionModeHooks, AcquisitionModeOff, AcquisitionModeStream, } from "../../turns/index.js";
import { pinned as versionPinned } from "../../versions/versions.js";
/**
 * probeAdapter resolves an adapter's optional acquisition capabilities by
 * structural probe — `typeof adapter.<method> === "function"` — exactly as MH's
 * Backend/Adapter seam and the tap-gate widening (integration subtask) do. It
 * never calls parseStreamLine/resumeArgs/readTranscript; it only invokes the
 * nullary streamInterleaved marker to read its boolean.
 */
export function probeAdapter(adapter) {
    // Probe optional methods off the concrete object. Adapter's declared type
    // does not include the optional capability interfaces, so widen to a record.
    const a = adapter;
    const hasStreamParser = typeof a.parseStreamLine === "function";
    const hasSessionResumer = typeof a.resumeArgs === "function";
    const hasTranscriptReader = typeof a.readTranscript === "function";
    let streamInterleaved = false;
    if (typeof a.streamInterleaved === "function") {
        streamInterleaved = a.streamInterleaved();
    }
    return {
        hasStreamParser,
        hasSessionResumer,
        hasTranscriptReader,
        streamInterleaved,
    };
}
/**
 * defaultStreamVersionPredicate ties fact 3 to versions.ts exactly as described:
 * the installed binary is treated as stream-json-capable only when the harness
 * carries a confirmed pin (versions.pinned returns a non-empty version, which is
 * emitted only when Entry.pinned is set and, by the versions.ts invariant, was
 * verified). An unpinned/unknown harness is conservatively treated as NOT
 * supporting the stream surface.
 */
export const defaultStreamVersionPredicate = (harness) => {
    const [, ok] = versionPinned(harness);
    return ok;
};
/**
 * resolveProfile assembles the ResolvedProfile from the three facts. It is the
 * MH analogue of Go's `resolveProfile` (which fed a static Profile through
 * runtime detection). Pure: it reads its inputs and the injected predicate only.
 */
export function resolveProfile(input) {
    const { info, adapter } = input;
    const predicate = input.streamVersionPredicate ?? defaultStreamVersionPredicate;
    const capabilities = probeAdapter(adapter);
    // Prefer the detected version; fall back to the pin when detection didn't run.
    const version = info.detectedVersion !== "" ? info.detectedVersion : info.pinnedVersion;
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
/**
 * streamEligible reports whether the Stream gate's three conditions all hold:
 *   (a) the adapter implements parseStreamLine,
 *   (b) the installed version supports stream-json, AND
 *   (c) the adapter marks its stream-json as interleaved with the TUI.
 * Exposed so the integration subtask and tests can assert the gate directly.
 */
export function streamEligible(profile) {
    return (profile.capabilities.hasStreamParser &&
        profile.streamJSONSupported &&
        profile.capabilities.streamInterleaved);
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
 *
 * Because streamEligible is false for all four current A1 adapters (none are
 * interleaved), real-adapter output is Hooks/Off; the Stream branch is reached
 * only by a synthetic interleaved fake.
 */
export function planAcquisition(requested, ctx) {
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
        case AcquisitionModeHooks:
            if (ctx.hooksViable) {
                return AcquisitionModeHooks;
            }
            if (eligible) {
                return AcquisitionModeStream;
            }
            return AcquisitionModeOff;
        default:
            // Exhaustive over AcquisitionMode; unreachable. Conservative default.
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
export function replanAfterStreamFailure(ctx) {
    return ctx.hooksViable ? AcquisitionModeHooks : AcquisitionModeOff;
}
//# sourceMappingURL=planAcquisition.js.map