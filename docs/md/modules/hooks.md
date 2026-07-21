# `meta-harness/hooks`

Manage a harness's on-disk **hook configuration** — the settings entries that fire a
command on lifecycle events (`SessionStart`, `Stop`, `PostToolUse`, …) — and parse the
resulting native payloads into canonical [transcript](transcript.md) `Event`s. This is the
TS analogue of harness-wrapper's `pkg/harness` hook helpers (`EnsureSettingsJSONHooks`,
`RenderHookCommand`, `IsManagedHookCommand`, `WithLockedFile`).

The package is two layers. The **leaf utilities** are pure filesystem helpers with no
runtime/chat dependency — render a managed command, edit `settings.json` idempotently,
serialize edits under a portable lock, guard untrusted payload paths. The **provider
surface** (`HookProvider` + the concrete `ClaudeHookProvider`) builds on them to ensure a
harness's config and drain its payloads.

```ts
import {
  // command render + marker recognition
  hookMarkerPrefix,
  renderHookCommand,
  isManagedHookCommand,
  type RenderHookCommandOptions,
  // settings.json editor
  ensureSettingsJSONHooks,
  removeManagedHooks,
  type SettingsHookCmd,
  type SettingsHookMatcher,
  type ManagedHooks,
  // serialized-edit lock
  withLockedFile,
  atomicWriteFileSync,
  lockStaleTTLMs,
  type LockOptions,
  // path-traversal / session guards
  resolveWithinBase,
  isWithinBase,
  PathEscapeError,
  guardPath,
  sessionMatches,
  // event spool (out-of-process hook CLI ↔ runtime)
  appendSpool,
  drainSpool,
  spoolFileName,
  spoolFilePath,
  // provider surface + Claude concrete provider
  specFromProfile,
  ClaudeHookProvider,
  parseClaudeHookPayload,
  claudeHookOwner,
  type HookContext,
  type HookEntry,
  type HookProvider,
  type HookSpec,
  type StaticHookProfile,
  type ClaudeHookPayload,
  EventTurnBoundary,
  HookEventSessionStart,
  HookEventStop,
  HookEventSubagentStop,
  HookEventPostToolUse,
  HookEventPostTask,
} from "meta-harness/hooks";
```

---

## Managed commands

A hook command is **managed** when meta-harness itself installed it. Every rendered command
carries a stable trailing marker comment (`# meta-harness-hook:<event>`) so a later
ensure/remove pass rewrites **only** our own entries and never a co-tenant's block.

```ts
renderHookCommand(opts: RenderHookCommandOptions): string
isManagedHookCommand(command: string): boolean
hookMarkerPrefix: "meta-harness-hook"
```

`renderHookCommand` pins both the Node binary (`nodePath`) and the committed
`dist/cli/hooks.js` (`distDir`) — the hook CLI must launch under Node, not the ambient
runtime — and appends the marker. `isManagedHookCommand` recognizes the marker;
`hookMarkerPrefix` is the token it looks for.

```ts
interface RenderHookCommandOptions {
  nodePath: string; // absolute path to the Node binary
  distDir: string; // absolute path to committed dist/ (dist/cli/hooks.js is appended)
  event: string; // the hook event this command handles, e.g. "SessionStart"
  args?: string[]; // extra positional args after the event
}
```

---

## Editing `settings.json`

`ensureSettingsJSONHooks` models Claude Code's 2-level hook format:

```jsonc
{
  "hooks": {
    "<Event>": [
      {
        "matcher": "<glob>",
        "hooks": [{ "type": "command", "command": "<cmd>" }],
      },
    ],
  },
}
```

```ts
ensureSettingsJSONHooks(configPath: string, managed: ManagedHooks): void
removeManagedHooks(configPath: string): void
```

`ensureSettingsJSONHooks` is **idempotent and co-tenant-safe**: re-running leaves exactly
one managed block per event, preserves any block we do not own, and preserves unrelated
top-level keys verbatim. Every command inside `managed` MUST be marker-tagged (rendered via
`renderHookCommand`) so a later pass recognizes it as ours. `removeManagedHooks` is the
explicit teardown path — ordinary shutdown does **not** strip hooks (installs are cheap and
re-ensured each session). A malformed config is a hard error; an absent/empty file is
treated as `{}`.

```ts
interface SettingsHookCmd {
  type: "command";
  command: string;
  timeout?: number;
}
interface SettingsHookMatcher {
  matcher?: string;
  hooks: SettingsHookCmd[];
}
type ManagedHooks = Record<string, SettingsHookMatcher[]>;
```

---

## Serialized edits

Node and Bun ship no native `flock`, so edits serialize on an `O_EXCL` sentinel lock and
commit via a tmp-file + atomic rename — a concurrent reader never observes a half-written
config, even between lock windows. This is the portable replacement for Go's
`WithLockedFile`.

```ts
withLockedFile(path: string, fn: () => T, opts?: LockOptions): T
atomicWriteFileSync(path: string, data: string): void
lockStaleTTLMs: 30000
```

A lock held longer than `lockStaleTTLMs` (30 s — comfortably longer than any real edit
window) is presumed abandoned by a crashed writer and reclaimed. `LockOptions` tunes the
contended-acquisition window:

```ts
interface LockOptions {
  acquireTimeoutMs?: number; // max time contending before giving up (default 10_000)
  staleTTLMs?: number; // age past which a sentinel is reclaimed (default lockStaleTTLMs)
}
```

---

## Guarding untrusted payloads

Hook payloads are untrusted, so a payload-supplied path is checked to stay within its
expected base before its contents are trusted, and a stray hook from an unrelated session
sharing the same `settings.json` is dropped.

```ts
resolveWithinBase(baseDir: string, candidate: string): string // throws PathEscapeError on escape
isWithinBase(baseDir: string, candidate: string): boolean
guardPath(baseDir: string, candidate: string): string | null // null on escape
sessionMatches(expected: string | undefined, payloadID: string): boolean
class PathEscapeError extends Error // .baseDir, .candidate
```

Both endpoints are canonicalized (symlinks resolved via [`transcript`](transcript.md)'s
`pathutil`, then lexically cleaned), so `../` escapes and symlink escapes are rejected and
`/tmp/x` compares equal to the macOS-resolved `/private/tmp/x`. `sessionMatches` with an
empty `expected` is disarmed (any id passes) until the launch session id is known.

---

## The event spool

The hook CLI (`meta-harness-hooks`) runs **out of process** — one short-lived Node process
per hook fire — and hands events to the in-process runtime through an on-disk JSONL spool.

```ts
appendSpool(spoolDir: string, rec: ParsedEvent): void
drainSpool(spoolDir: string): ParsedEvent[]
spoolFilePath(spoolDir: string): string
spoolFileName: "events.jsonl"
```

Many hook processes may `appendSpool` concurrently; `drainSpool` reads then truncates under
the same [lock](#serialized-edits), so an append and a drain never interleave. Arrival
order (line order) is preserved, and every drained event is re-stamped `source=SourceHook`.

---

## Provider surface

A `HookProvider` unifies the two responsibilities — **config-ensure** and
**payload-parsing** — behind one shape. `HookContext` threads the ambient locations a
provider needs; `HookSpec` is the resolved on-disk configuration it ensures.

```ts
interface HookContext {
  cwd: string;
  home: string;
  configDir: string;
  spoolDir: string;
  harnessSessionID?: string; // expected launch session id; empty = no expectation
}
interface HookEntry {
  event: string;
  command: string;
  matcher?: string;
}
interface HookSpec {
  configPath: string;
  events: HookEntry[];
  yield?: HookEntry;
  owner: string; /* … */
}
```

`specFromProfile` derives a `HookSpec` from a `StaticHookProfile` — the declarative
description of which events a harness binds. This is the TS substitute for Go's Profile
registry; the registry abstraction itself has no TS analogue.

```ts
specFromProfile(profile: StaticHookProfile, ctx: HookContext): HookSpec
```

---

## The Claude provider

`ClaudeHookProvider` is the concrete provider for Claude Code. It ensures Claude's
`settings.json` hooks and parses Claude's native payloads (`Stop`, `SessionStart`,
`SubagentStop`, `PostToolUse`/`PostTask`) into canonical `Event`s stamped
`source=SourceHook`.

```ts
class ClaudeHookProvider { ensureConfig(…); parsePayload(…) }
parseClaudeHookPayload(payload: ClaudeHookPayload, ctx: HookContext): ParsedEvent[]
claudeHookOwner: "harness/claude"
// native event-name constants:
HookEventStop, HookEventSessionStart, HookEventSubagentStop,
HookEventPostToolUse, HookEventPostTask
EventTurnBoundary: "turn_boundary" // Event.type on the lifecycle markers payloads emit
```

These payloads are primarily lifecycle/session signals, so they emit as their own event
kinds (`session_meta` / turn-boundary markers) rather than as per-message text duplicates
of the `SourceFile` transcript. Where a payload carries message text it is `SourceHook` and
treated as **provisional** — the authoritative `SourceFile` text event supersedes it
downstream.

---

## Relationship to the rest of the package

`hooks` is consumed internally by [`turns`](turns.md)'s Claude adapter
(`turns/harness/claudecode.ts`), which calls `ensureSettingsJSONHooks` and
`renderHookCommand` at launch. The `meta-harness-hooks` CLI (`src/cli/hooks.ts`) is a thin
wrapper over `ClaudeHookProvider`. Parsed events feed the [`transcript`](transcript.md)
model, where the hook-sourced spool events are deduped against the authoritative on-disk
transcript.
