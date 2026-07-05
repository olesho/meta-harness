# `meta-harness/transcript`

Low-level parsers that turn a harness's **own on-disk session log** into a canonical
[`Event`](#the-canonical-event-model) stream. Independent of the live [screen](screen.md)
and [chat](chat.md) layers: give a reader a harness session id and a working directory,
and it locates and parses that session's log file (Claude Code / Codex / pi JSONL) into
one uniform event shape, with stable per-event identity and a durable wire codec.

This is the authoritative source of conversation history once a harness has flushed its
log — the [`chat`](../concepts.md#transcript-vs-store-history) layer prefers it over its own
store when available.

```ts
import {
  SchemaVersion, RoleUser, RoleAssistant, RoleTool, RoleSystem,
  EventText, EventToolUse, EventToolResult, EventSessionMeta, SourceLive, SourceFile,
  eventID, turnsFromEvents, envelope, toPublicJSON,
  type Event, type Turn, type ParsedEvent, type EventEnvelope,
  marshalParsedEvents, unmarshalParsedEvents,
  type Reader, ErrEmptySessionID, ErrEmptyWorkingDir, ErrSessionNotFound,
  ClaudeCodeReader, encodedCWD, claudecodeEvents,
  CodexReader, codexEvents, parseRollout, locateLatestSession, readSessionMeta,
  PiReader, slugForCwd,
} from "meta-harness/transcript"
```

---

## The canonical Event model

```ts
interface Event {
  seq?: number
  timestamp?: Date
  role?: string        // RoleUser | RoleAssistant | RoleTool | RoleSystem
  type?: string        // EventText | EventToolUse | EventToolResult | EventSessionMeta
  text?: string
  toolName?: string
  toolUseID?: string
  toolInput?: string   // raw JSON
  output?: string      // tool_result text

  // internal metadata — present in the durable wire form, omitted from the public DTO:
  uuid?: string        // native message UUID when available
  schemaVersion?: number
  source?: string      // SourceLive ("live") | SourceFile ("file")
  nativeID?: string    // parser-owned primary identity
}
```

Constants: roles `RoleUser`/`RoleAssistant`/`RoleTool`/`RoleSystem`; kinds
`EventText`/`EventToolUse`/`EventToolResult`/`EventSessionMeta`; sources
`SourceLive`/`SourceFile`; `SchemaVersion` (currently `1`, bumped only on a breaking
change).

### Identity & deduplication

```ts
eventID(e: Event): string
```
A time-stable dedup key, chosen in priority order: parser-owned `nativeID` → `"msg:" +
uuid` → a **kind-qualified** `toolUseID` (so a `tool_use` and its `tool_result` never
collapse) → a SHA-256 content hash of `(type, role, timestamp, text, toolInput, output)`.
The hash excludes `seq` and `source`, so the same event is stable across live-vs-file
acquisition.

### Turns projection

```ts
turnsFromEvents(events: Event[]): Turn[]
interface Turn { role: string; text: string; timestamp?: Date }
```
Projects the event stream to the lossy chat view, dropping tool-only events (those with no
renderable text). This is how the Claude Code and Codex adapters turn `Event[]` into the
`Turn[]` that [`chat.historyWithSource()`](chat.md#history-source) consumes.

### Wrappers

```ts
interface ParsedEvent  { harnessSessionID: string; parentSessionID?: string; event: Event }
interface EventEnvelope{ runID: string; harness: string; harnessSessionID: string; parentSessionID?: string; event: Event }

envelope(pe: ParsedEvent, runID: string, harness: string): EventEnvelope   // stamp run-level identity
toPublicJSON(e: Event): Record<string, unknown>                            // DTO with public fields only
```

`parentSessionID` is empty for a top session and set for nested/subagent sessions.
`toPublicJSON` strips the internal metadata (`source`, `nativeID`, `schemaVersion`).

---

## The Reader interface

```ts
interface Reader {
  read(harnessSessionID: string, workingDir: string): Event[]
}
```

- `harnessSessionID` — the UUID the harness assigned its own session.
- `workingDir` — where the chat session opened; some harnesses (Claude Code) index logs
  by it, others (Codex) ignore it.
- **Throws** on missing/malformed input, including the sentinels
  [`ErrEmptySessionID`](#errors), [`ErrEmptyWorkingDir`](#errors), and
  [`ErrSessionNotFound`](#errors) (wrapped in a cause chain).

> **Note:** `ClaudeCodeReader` and `CodexReader` satisfy this interface (`read → Event[]`).
> `PiReader.read` returns `Turn[]` **directly** — it skips the event model and yields the
> lossy chat view, so it is *not* structurally a `Reader`. Adapters must not call
> `turnsFromEvents()` on pi's result.

---

## Per-harness readers

### `ClaudeCodeReader`

```ts
new ClaudeCodeReader(projectsRoot = "")   // "" → ~/.claude/projects
reader.read(harnessSessionID, workingDir): Event[]
encodedCWD(workingDir: string): string     // Claude Code project-dir encoding
```

Reads `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`. `encodedCWD` replaces every
non-alphanumeric char with `-`; the reader also tries the realpath of `workingDir` (to
resolve symlinks). JSONL, one message per line; each content block becomes an event
(tool-aware: `tool_use`/`tool_result` unpacked), tagged `SourceFile`. `claudecodeEvents`
is the raw line parser.

### `CodexReader`

```ts
new CodexReader(sessionsRoot = "")   // "" → ~/.codex/sessions
reader.read(harnessSessionID, _workingDir = ""): Event[]   // workingDir ignored
codexEvents(...)                     // rollout JSONL parser (exported as `events`)
parseRollout(data: string): Envelope[]
locateLatestSession(sessionsRoot: string, workingDir: string): string | undefined
readSessionMeta(path: string): SessionMetaPayload | undefined
```

Reads `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`, located by matching the
filename suffix `-<sessionID>.jsonl`. Only `response_item` envelopes are surfaced
(messages → text events, `function_call`/`function_call_output` → tool events).
`locateLatestSession` is a disk fallback that reads each session's `session_meta` to match
a working directory; `readSessionMeta` extracts the `session_id`/`cwd` from a log's first
line.

### `PiReader`

```ts
new PiReader(opts: string | { root?: string; sessionsDir?: string } = "")
reader.read(harnessSessionID, workingDir = ""): Turn[]   // ← Turn[], not Event[]
slugForCwd(cwd: string): string
```

Reads `<config>/sessions/--<cwd-slug>--/<ts>_<uuid>.jsonl`, where `<config>` honors
`PI_CODING_AGENT_DIR` (default `~/.pi/agent`) and `slugForCwd` maps a cwd to
`--<slashes-to-hyphens>--`. It probes the per-cwd slug directory first, then walks all
session dirs and confirms the match against each file's header `id`. Pass `sessionsDir` to
pin the exact directory resolved at launch (the pi adapter does this via its launch-env
binding). Returns `Turn[]` directly.

> **No OpenCode reader.** Only Claude Code, Codex, and pi have transcript readers;
> OpenCode history is always [store-backed](../concepts.md#transcript-vs-store-history).

---

## Wire codec

```ts
marshalParsedEvents(events: ParsedEvent[]): string
unmarshalParsedEvents(data: string): ParsedEvent[]
```

Durable serialization for persisting parsed events. Unlike [`toPublicJSON`](#wrappers),
the wire form **preserves the internal metadata** (`source`, `nativeID`, `schemaVersion`)
because downstream consumers key authority filters on `source` and dedup on `nativeID`.
`unmarshal` throws on malformed input.

---

## Errors

[Sentinels](../concepts.md#sentinel-errors) — match by identity, not message.

| Sentinel | Meaning |
| --- | --- |
| `ErrEmptySessionID` | The requested session id was empty. |
| `ErrEmptyWorkingDir` | A reader that needs a working dir got none. |
| `ErrSessionNotFound` | No transcript file could be located for the session. |

The chat layer treats `ErrSessionNotFound` and `ErrEmptySessionID` as *"not yet flushed"*
and [falls back to the store](chat.md#history-source); genuine parse/permission errors
propagate.

---

## Relationship to other layers

- The [`turns`](turns.md) adapters own the reader instances and expose them via their
  `TranscriptReader` capability (`readTranscript`).
- [`chat.historyWithSource()`](chat.md#history-source) calls that capability, projects
  the result with `turnsFromEvents` (except pi, which is already `Turn[]`), and tags the
  history `HistorySourceTranscript`.
- Malformed JSONL lines are skipped rather than fatal — matching the Go readers — so a
  partially-written log still yields the events it can.
