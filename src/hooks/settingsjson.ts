// settings.json editor (Go analogue: pkg/harness/settingsjson.go).
//
// Models Claude Code's settings.json 2-level hook format:
//
//   { "hooks": { "<Event>": [ { "matcher": "<glob>",
//                               "hooks": [ { "type": "command",
//                                            "command": "<cmd>" } ] } ] } }
//
// ensureSettingsJSONHooks is idempotent and co-tenant-safe: re-running leaves
// exactly one managed block per event and preserves any block we do not own.
// removeManagedHooks is the explicit teardown path (ordinary shutdown does NOT
// strip hooks — installs are cheap and re-ensured each session).

import { readFileSync } from "node:fs"
import { atomicWriteFileSync, withLockedFile } from "./lock.ts"
import { isManagedHookCommand } from "./command.ts"

// SettingsHookCmd is the leaf of the format — one command invocation.
export interface SettingsHookCmd {
  type: "command"
  command: string
  timeout?: number
}

// SettingsHookMatcher groups commands under an optional tool/event matcher.
export interface SettingsHookMatcher {
  matcher?: string
  hooks: SettingsHookCmd[]
}

// ManagedHooks maps a hook event name to the managed matcher entries that
// should exist for it. Every command within MUST be marker-tagged (rendered via
// renderHookCommand) so a later ensure/remove recognises it as ours.
export type ManagedHooks = Record<string, SettingsHookMatcher[]>

interface SettingsJSON {
  hooks?: Record<string, SettingsHookMatcher[]>
  // Any other top-level keys are preserved verbatim.
  [key: string]: unknown
}

// readSettings loads and parses the config, tolerating an absent or empty file
// (both yield `{}`). A malformed file is a hard error — we refuse to clobber it.
function readSettings(configPath: string): SettingsJSON {
  let raw: string
  try {
    raw = readFileSync(configPath, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw err
  }
  if (raw.trim() === "") return {}
  const parsed = JSON.parse(raw)
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`settings.json is not a JSON object: ${configPath}`)
  }
  return parsed as SettingsJSON
}

// stripManaged drops every marker-tagged command from the given matcher list,
// preserving co-tenant commands. A matcher left with no commands is removed.
function stripManaged(matchers: SettingsHookMatcher[]): SettingsHookMatcher[] {
  const out: SettingsHookMatcher[] = []
  for (const m of matchers) {
    const kept = (m.hooks ?? []).filter((h) => !isManagedHookCommand(h.command))
    if (kept.length > 0) out.push({ ...m, hooks: kept })
  }
  return out
}

function serialize(settings: SettingsJSON): string {
  return `${JSON.stringify(settings, null, 2)}\n`
}

// ensureSettingsJSONHooks installs `managed` into `configPath` under the O_EXCL
// lock, atomically. For each event it strips any previously-managed block and
// appends the desired managed matchers, so the result is exactly-once and
// leaves co-tenant blocks intact.
export function ensureSettingsJSONHooks(
  configPath: string,
  managed: ManagedHooks,
): void {
  withLockedFile(configPath, () => {
    const settings = readSettings(configPath)
    const hooks: Record<string, SettingsHookMatcher[]> = settings.hooks ?? {}

    for (const [event, desired] of Object.entries(managed)) {
      const existing = Array.isArray(hooks[event]) ? hooks[event] : []
      const preserved = stripManaged(existing)
      const next = [...preserved, ...desired]
      if (next.length > 0) hooks[event] = next
      else delete hooks[event]
    }

    if (Object.keys(hooks).length > 0) settings.hooks = hooks
    else delete settings.hooks

    atomicWriteFileSync(configPath, serialize(settings))
  })
}

// removeManagedHooks strips meta-harness's managed blocks from `configPath`,
// leaving co-tenant blocks untouched. When `events` is omitted every event is
// swept; the file is rewritten atomically under the lock.
export function removeManagedHooks(configPath: string, events?: string[]): void {
  withLockedFile(configPath, () => {
    const settings = readSettings(configPath)
    const hooks = settings.hooks
    if (!hooks) return

    const targets = events ?? Object.keys(hooks)
    for (const event of targets) {
      const existing = hooks[event]
      if (!Array.isArray(existing)) continue
      const preserved = stripManaged(existing)
      if (preserved.length > 0) hooks[event] = preserved
      else delete hooks[event]
    }

    if (Object.keys(hooks).length > 0) settings.hooks = hooks
    else delete settings.hooks

    atomicWriteFileSync(configPath, serialize(settings))
  })
}
