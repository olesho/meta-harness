// The FIRST eventID-based dedup consumer. It merges a batch of hook-sourced
// events (source: SourceHook, delivered as ParsedEvent[]) against the SourceFile
// events already drained from the reader, on the durable-store feed alongside
// marshalParsedEvents.
//
// This is a NEW seam: eventID() had ZERO callers before this file. Dedup keys on
// eventID(event); authority is decided by Event.source, matching eventWire.ts's
// contract ("the authority filter keys on source and dedup keys on nativeID").
// SourceFile is authoritative and supersedes a provisional SourceHook event that
// shares its id.
//
// What collapses cross-source, and what does NOT:
//   - Tool events carry SOURCE-INDEPENDENT ids: `tool-use:<id>` and
//     `tool-result:<tool_use_id>` (see parseClaude.ts / parseCodex.ts). A
//     SourceHook tool event therefore shares eventID() with the later SourceFile
//     tool event and collapses cleanly here — the one kind for which cross-source
//     collapse is achievable with no parser change.
//   - Text events are source- AND seq-dependent: textNativeID embeds the literal
//     "file" string plus a per-file-parse seq counter the hook side cannot
//     reproduce (parseClaude.ts / parseCodex.ts). Their eventIDs differ across
//     sources, so this consumer does NOT — and MUST NOT — attempt file-identity
//     dedup for text. Hook text stays tagged SourceHook and provisional; the
//     authoritative SourceFile text event lands alongside it and supersedes it
//     downstream. We never synthesize a competing SourceFile-identity text event,
//     and textNativeID is left untouched.

import {
  SourceFile,
  SourceHook,
  SourceLive,
  eventID,
  type ParsedEvent,
} from "./event.ts";

// sourceAuthority ranks provenance for dedup collisions: the higher rank wins
// when two events share an eventID. SourceFile (durable, parser-owned) outranks
// SourceHook (provisional, real-time). SourceLive is never produced, so it only
// ever appears as the floor. Unknown/unset sources sit below hook.
function sourceAuthority(source: string | undefined): number {
  switch (source) {
    case SourceFile:
      return 2;
    case SourceHook:
      return 1;
    case SourceLive:
      return 0;
    default:
      return 0;
  }
}

// wins reports whether candidate should replace incumbent when they collide on
// eventID. Strictly-higher authority wins; ties keep the incumbent (first-seen),
// which for equal sources preserves reader order.
function wins(candidate: ParsedEvent, incumbent: ParsedEvent): boolean {
  return (
    sourceAuthority(candidate.event.source) >
    sourceAuthority(incumbent.event.source)
  );
}

// orderKey sorts the merged set the way every other event is ordered: by seq,
// then timestamp, as a stable tie-break. Missing seq/timestamp sort first.
function compareOrder(a: ParsedEvent, b: ParsedEvent): number {
  const sa = a.event.seq ?? 0;
  const sb = b.event.seq ?? 0;
  if (sa !== sb) return sa - sb;
  const ta = a.event.timestamp ? a.event.timestamp.getTime() : 0;
  const tb = b.event.timestamp ? b.event.timestamp.getTime() : 0;
  return ta - tb;
}

// mergeHookEvents merges an incoming hook batch (source: SourceHook) into the
// existing events already read from the durable store / reader (typically
// SourceFile), deduping on eventID and resolving collisions by source authority.
//
// The runtime-integration subtask feeds drained hook events in via `hookBatch`;
// `existing` is whatever the reader has produced so far. Both are ParsedEvent[]
// so the result can flow straight back onto the marshalParsedEvents feed.
//
// Returns the merged, deduped set ordered by seq/timestamp. Neither input is
// mutated.
export function mergeHookEvents(
  existing: ParsedEvent[],
  hookBatch: ParsedEvent[],
): ParsedEvent[] {
  const byID = new Map<string, ParsedEvent>();
  const order: string[] = [];

  // Existing events first so, on an authority tie, the reader's event is the
  // first-seen incumbent that hook events must strictly outrank to replace.
  for (const pe of existing) {
    const id = eventID(pe.event);
    const incumbent = byID.get(id);
    if (incumbent === undefined) {
      byID.set(id, pe);
      order.push(id);
    } else if (wins(pe, incumbent)) {
      byID.set(id, pe);
    }
  }

  for (const pe of hookBatch) {
    const id = eventID(pe.event);
    const incumbent = byID.get(id);
    if (incumbent === undefined) {
      byID.set(id, pe);
      order.push(id);
    } else if (wins(pe, incumbent)) {
      byID.set(id, pe);
    }
  }

  const merged = order.map((id) => byID.get(id)!);
  merged.sort(compareOrder);
  return merged;
}
