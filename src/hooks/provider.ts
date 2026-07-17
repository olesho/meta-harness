// Provider surface for harness hook streams. A HookProvider knows how to
// (a) ensure a harness's on-disk hook configuration exists (config-ensure) and
// (b) parse the harness's native hook payloads into canonical transcript
// Event[] (payload-parsing). These are the shared shapes the adapter-capability
// and CLI subtasks build on; the Claude concrete provider lives in claude.ts.

import type { ParsedEvent } from "../transcript/event.ts"

// HookContext threads the ambient locations a provider needs when ensuring
// config or parsing a payload. Cwd is the harness working dir; Home is the
// user home; ConfigDir is where the harness keeps its settings (e.g.
// ~/.claude); SpoolDir is where hook processes drop payloads for draining.
//
// harnessSessionID is the expected session id minted at launch (see
// turns/harness/claudecode.ts initSession → chat pins it via --session-id and
// tracks it as Conversation.session.harnessSessionID). It is threaded in here
// — NOT reached out of Conversation — so the payload parser can drop a stray
// hook fired by an unrelated session that shares the same settings.json. Empty
// means "no expectation": the session-mismatch guard is not applied.
export interface HookContext {
  cwd: string
  home: string
  configDir: string
  spoolDir: string
  harnessSessionID?: string
}

// HookEntry is a single hook registration: the native hook event it binds to
// (e.g. "Stop", "PostToolUse"), the command the harness runs, and an optional
// matcher (tool-name glob for tool-scoped events).
export interface HookEntry {
  event: string
  command: string
  matcher?: string
}

// HookSpec is the resolved, on-disk hook configuration a provider ensures.
// ConfigPath is the settings file the entries live in; Events are the hook
// registrations to install; Yield, when present, is the single entry whose
// output the runtime drains (the "yield point" hook); Owner identifies who
// installed the spec so foreign entries are never clobbered.
export interface HookSpec {
  configPath: string
  events: HookEntry[]
  yield?: HookEntry
  owner: string
}

// StaticHookProfile is a fixed, code-defined set of hook entries a provider
// installs verbatim (no per-session templating beyond the config path). It is
// the simplest HookSpec source: an owner tag, the entries, and an optional
// yield entry. Providers build a HookSpec from it via toSpec().
export interface StaticHookProfile {
  owner: string
  entries: HookEntry[]
  yield?: HookEntry
}

// specFromProfile resolves a StaticHookProfile against a concrete config path
// into an installable HookSpec.
export function specFromProfile(profile: StaticHookProfile, configPath: string): HookSpec {
  return {
    configPath,
    events: profile.entries.slice(),
    yield: profile.yield,
    owner: profile.owner,
  }
}

// HookProvider is the per-harness surface: ensureConfig resolves the on-disk
// hook configuration (config-ensure) and parsePayload turns one native hook
// payload into canonical Events (payload-parsing). parsePayload returns an
// empty array when a payload is dropped by a guard (session mismatch,
// path-traversal, or unrecognized shape).
export interface HookProvider {
  ensureConfig(ctx: HookContext): HookSpec
  parsePayload(raw: string, ctx: HookContext): ParsedEvent[]
}
