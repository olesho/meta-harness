// Hook event spool — the on-disk hand-off between the OUT-OF-PROCESS hook CLI
// (meta-harness-hooks, one Node process per hook fire) and the in-process
// runtime that drains it. TS port-by-behavior of Go's pkg/harness/hookrun.go
// spool + drainSpool.
//
// Format: newline-delimited JSON (JSONL). Each line is one serialized
// ParsedEvent record ({ harnessSessionID, parentSessionID?, event }). Records
// are APPENDED — many short-lived hook processes may append concurrently — and
// the runtime DRAINS by reading then truncating the file under the same lock,
// so an append and a drain never interleave. Arrival order is line order and is
// preserved within a drain.
//
// The Event's timestamp is a Date on the canonical model; JSON renders it as an
// ISO string on append and drainSpool rehydrates it back to a Date. Every
// drained event is (re)stamped source=SourceHook — that provenance is the whole
// point of the spool (it feeds the eventID dedup consumer in hookMerge.ts).

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import { SourceHook, type Event, type ParsedEvent } from "../transcript/event.ts"
import { withLockedFile } from "./lock.ts"

// spoolFileName is the fixed basename of the spool file inside a spool dir. The
// appender and the drainer derive the same path from the dir alone.
export const spoolFileName = "events.jsonl"

// spoolFilePath resolves the spool file inside a spool directory.
export function spoolFilePath(spoolDir: string): string {
  return path.join(spoolDir, spoolFileName)
}

// SpoolRecord is the JSONL wire shape of one spooled event. It mirrors
// ParsedEvent; the Event's Date timestamp round-trips through an ISO string.
interface SpoolRecord {
  harnessSessionID: string
  parentSessionID?: string
  event: Event
}

// appendSpool appends the given ParsedEvents to the spool file for spoolDir as
// JSONL, one record per line, in the order given. It creates the spool dir and
// file on first use. The write is serialized with the same file lock drainSpool
// uses, so concurrent hook processes never interleave a line and a drain never
// observes a half-written record. An empty batch is a no-op.
export function appendSpool(spoolDir: string, events: ParsedEvent[]): void {
  if (events.length === 0) return
  mkdirSync(spoolDir, { recursive: true })
  const file = spoolFilePath(spoolDir)
  let lines = ""
  for (const pe of events) {
    lines += JSON.stringify(toRecord(pe)) + "\n"
  }
  withLockedFile(file, () => {
    const fd = openSync(file, "a", 0o600)
    try {
      writeFileSync(fd, lines)
    } finally {
      closeSync(fd)
    }
  })
}

// drainSpool reads AND truncates the spool for spoolDir, returning every spooled
// record as a canonical ParsedEvent whose Event.source === SourceHook, in
// arrival (line) order. Read+truncate happen under the append lock so no record
// written before the drain is lost and none is double-drained. A missing or
// empty spool drains to []. Corrupt/blank lines are skipped rather than
// aborting the drain.
export function drainSpool(spoolDir: string): ParsedEvent[] {
  const file = spoolFilePath(spoolDir)
  if (!existsSync(file)) return []
  return withLockedFile(file, () => {
    let raw: string
    try {
      raw = readFileSync(file, "utf8")
    } catch {
      return []
    }
    // Truncate in place — appenders re-create/extend the same path under lock.
    writeFileSync(file, "", { mode: 0o600 })
    return parseLines(raw)
  })
}

// toRecord projects a ParsedEvent to its JSONL record. parentSessionID is
// dropped when empty so the wire line stays minimal.
function toRecord(pe: ParsedEvent): SpoolRecord {
  const rec: SpoolRecord = { harnessSessionID: pe.harnessSessionID, event: pe.event }
  if (pe.parentSessionID) rec.parentSessionID = pe.parentSessionID
  return rec
}

// parseLines turns raw JSONL back into ParsedEvents, skipping blank/corrupt
// lines. Each event is rehydrated (Date timestamp) and re-stamped SourceHook.
function parseLines(raw: string): ParsedEvent[] {
  const out: ParsedEvent[] = []
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue
    let rec: SpoolRecord
    try {
      rec = JSON.parse(line) as SpoolRecord
    } catch {
      continue
    }
    if (!rec || typeof rec !== "object" || !rec.event) continue
    const pe: ParsedEvent = {
      harnessSessionID: rec.harnessSessionID ?? "",
      event: rehydrateEvent(rec.event),
    }
    if (rec.parentSessionID) pe.parentSessionID = rec.parentSessionID
    out.push(pe)
  }
  return out
}

// rehydrateEvent restores the JSON-serialized Event to the canonical model:
// converts an ISO-string timestamp back to a Date and forces source=SourceHook.
function rehydrateEvent(raw: Event): Event {
  const event: Event = { ...raw, source: SourceHook }
  const ts = raw.timestamp as unknown
  if (typeof ts === "string" || typeof ts === "number") {
    const d = new Date(ts)
    event.timestamp = Number.isNaN(d.getTime()) ? undefined : d
  }
  return event
}
