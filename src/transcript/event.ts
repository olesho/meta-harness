// Canonical, harness-agnostic transcript event model — the TS port of
// harness-wrapper's pkg/transcript event.go. Per-harness readers translate
// native formats into Event[] so consumers handle one shape.

import { createHash } from "node:crypto"

// SchemaVersion is the current canonical Event wire-schema version. Bump only
// on a breaking change; add fields additively otherwise.
export const SchemaVersion = 1

// Canonical role constants.
export const RoleUser = "user"
export const RoleAssistant = "assistant"
export const RoleTool = "tool"
export const RoleSystem = "system"

// Canonical event type constants (the public Type values).
export const EventText = "text"
export const EventToolUse = "tool_use"
export const EventToolResult = "tool_result"
export const EventSessionMeta = "session_meta"

// Event provenance (Source) — which acquisition produced the event.
export const SourceLive = "live"
export const SourceFile = "file"

// Event is the canonical representation of a single moment in a session's
// transcript. The PUBLIC fields mirror loomcli's DTO; the INTERNAL fields
// (schemaVersion, source, nativeID) live on the durable store row / envelope,
// never the public DTO (see toPublicJSON).
export interface Event {
  seq?: number
  timestamp?: Date
  role?: string // user, assistant, tool, system
  type?: string // text, tool_use, tool_result, session_meta
  text?: string
  toolName?: string
  toolUseID?: string
  toolInput?: string // raw JSON
  output?: string // tool_result text
  uuid?: string // native message UUID when available

  // --- INTERNAL metadata: durable store row only, NOT public DTO ---
  schemaVersion?: number
  source?: string // SourceLive | SourceFile
  nativeID?: string // PRIMARY identity (parser-owned); see eventID
}

// unixNanoStr renders a timestamp the way Go's Timestamp.UnixNano() feeds the
// content hash. Exact value is unimportant — only stability matters.
function unixNanoStr(ts: Date | undefined): string {
  if (!ts) return "0"
  return `${ts.getTime()}000000`
}

// eventID returns the stable dedup identity for the event. Identity is
// PARSER-OWNED: a kind-qualified nativeID wins. Falling back to a content hash
// (which must be cross-source-stable) excludes seq and arrival time.
export function eventID(e: Event): string {
  if (e.nativeID) return e.nativeID
  if (e.uuid) return "msg:" + e.uuid
  if (e.toolUseID) {
    // Kind-qualified so a tool-use and its tool-result never collapse.
    return (e.type ?? "") + ":" + e.toolUseID
  }
  const h = createHash("sha256")
  h.update(
    [
      e.type ?? "",
      e.role ?? "",
      unixNanoStr(e.timestamp),
      e.text ?? "",
      e.toolInput ?? "",
      e.output ?? "",
    ].join("\x00"),
  )
  return "h:" + h.digest("hex").slice(0, 32)
}

// Turn is the lossy chat view (Role/Text/Timestamp) of an Event.
export interface Turn {
  role: string
  text: string
  timestamp?: Date
}

// turnsFromEvents projects canonical Events down to the chat Turn view.
// Tool-only events without renderable text are dropped.
export function turnsFromEvents(events: Event[]): Turn[] {
  const out: Turn[] = []
  for (const e of events) {
    if (!e.text) continue
    out.push({ role: e.role || RoleSystem, text: e.text, timestamp: e.timestamp })
  }
  return out
}

// ParsedEvent is what a per-harness parser returns: an Event tagged with the
// native session it belongs to.
export interface ParsedEvent {
  harnessSessionID: string
  parentSessionID?: string // empty for the top session; set for subagent/nested
  event: Event
}

// EventEnvelope is the durable, routable unit stamped with run-level identity.
export interface EventEnvelope {
  runID: string
  harness: string
  harnessSessionID: string
  parentSessionID?: string
  event: Event
}

// envelope stamps run-level identity onto a ParsedEvent.
export function envelope(pe: ParsedEvent, runID: string, harness: string): EventEnvelope {
  return {
    runID,
    harness,
    harnessSessionID: pe.harnessSessionID,
    parentSessionID: pe.parentSessionID,
    event: pe.event,
  }
}

// toPublicJSON renders the byte-identical Runs-tab DTO: PUBLIC fields only, with
// the internal source/nativeID/schemaVersion omitted (the analogue of Event's
// public json tags). Empty optional fields are dropped (json:"...,omitempty").
export function toPublicJSON(e: Event): Record<string, unknown> {
  const o: Record<string, unknown> = {
    seq: e.seq ?? 0,
    timestamp: (e.timestamp ?? new Date(0)).toISOString(),
    role: e.role ?? "",
    type: e.type ?? "",
  }
  if (e.text) o.text = e.text
  if (e.toolName) o.tool_name = e.toolName
  if (e.toolUseID) o.tool_use_id = e.toolUseID
  if (e.toolInput) o.tool_input = JSON.parse(e.toolInput)
  if (e.output) o.output = e.output
  if (e.uuid) o.uuid = e.uuid
  return o
}
