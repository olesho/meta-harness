// admitParent central authority filter — TS port of harness-wrapper's
// pkg/harness/filter.go (admitParent + isParentConversationKind).
//
// The single central authority every event passes before delivery, enforcing the
// mode-dependent SOURCE authority for the PARENT conversation so no acquisition
// strategy double-records the parent from two sources. The decision is purely
// (effectiveMode, source, kind, isSubagent) — it never inspects session identity
// beyond the parent/subagent distinction.

import {
  AcquisitionModeHooks,
  AcquisitionModeStream,
  type AcquisitionMode,
} from "../../turns/index.ts"
import {
  EventText,
  EventToolResult,
  EventToolUse,
  SourceFile,
  SourceLive,
} from "../../transcript/index.ts"

// EventOutputChunk names the streamed output-chunk kind — a parent CONVERSATION
// kind alongside text/tool_use/tool_result. Defined locally until the canonical
// transcript event vocabulary grows a constant for it.
export const EventOutputChunk = "output-chunk"

/**
 * admitParent reports whether an event should be admitted to the event stream.
 *
 *   - SUBAGENT events (isSubagent) are admitted in ANY mode: a subagent is a
 *     different native session, captured from the file/export side, and never
 *     competes with the parent's source.
 *   - Stream mode: the LIVE stream is the sole parent source. Live parent events
 *     (conversation kinds AND session/usage) are admitted; file parent events are
 *     dropped (the file contributes subagents only).
 *   - Hooks mode: the FILE is authoritative for the parent. File parent events are
 *     admitted; live parent events are admitted ONLY for non-conversation kinds
 *     (session id + usage) — live conversation kinds (message/tool-use/
 *     tool-result/output-chunk) are dropped so they don't double-leak alongside
 *     the file copy.
 *   - Off / unknown admit nothing (a defensive false keeps the contract total).
 *
 * `effectiveMode` must be the LATCHED parent strategy (Stream or Hooks); Off is
 * resolved before any event reaches the filter.
 */
export function admitParent(
  effectiveMode: AcquisitionMode,
  source: "live" | "file",
  kind: string,
  isSubagent: boolean,
): boolean {
  if (isSubagent) {
    return true
  }
  switch (effectiveMode) {
    case AcquisitionModeStream:
      return source === SourceLive
    case AcquisitionModeHooks:
      if (source === SourceFile) {
        return true
      }
      return !isParentConversationKind(kind)
    default: // Off / unknown
      return false
  }
}

/**
 * isParentConversationKind reports whether an event kind is part of the parent
 * CONVERSATION (the kinds that must come from exactly one source per mode), as
 * opposed to the out-of-band session/usage metadata the live stream may always
 * contribute. Unknown kinds are treated as NON-conversation (advisory): they are
 * never dropped by the conversation rule.
 */
export function isParentConversationKind(kind: string): boolean {
  switch (kind) {
    case EventText:
    case EventToolUse:
    case EventToolResult:
    case EventOutputChunk:
      return true
    default:
      // session_meta (session), usage, system, and any unknown kind.
      return false
  }
}
