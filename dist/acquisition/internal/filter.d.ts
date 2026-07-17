import { type AcquisitionMode } from "../../turns/index.ts";
export declare const EventOutputChunk = "output-chunk";
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
export declare function admitParent(effectiveMode: AcquisitionMode, source: "live" | "file", kind: string, isSubagent: boolean): boolean;
/**
 * isParentConversationKind reports whether an event kind is part of the parent
 * CONVERSATION (the kinds that must come from exactly one source per mode), as
 * opposed to the out-of-band session/usage metadata the live stream may always
 * contribute. Unknown kinds are treated as NON-conversation (advisory): they are
 * never dropped by the conversation rule.
 */
export declare function isParentConversationKind(kind: string): boolean;
//# sourceMappingURL=filter.d.ts.map