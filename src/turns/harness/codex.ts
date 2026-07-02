// Turn-detection adapter for the Codex CLI (github.com/openai/codex).
//
// Legacy (≤0.141): every turn ended with a "Token usage:" footer — a per-turn
// fingerprint that drove TurnComplete. Codex 0.142+ removed that footer (and the
// "codex resume <uuid>" hint), so OnScreen stays silent on current Codex and the
// session id is recovered from disk (LocateSessionID). The legacy path is kept
// for any codex still emitting the footer and is locked in by the corpus tests.
//
// Port of pkg/turns/harness/codex/{codex.go,input.go} + the LocateLatestSession
// disk fallback from pkg/transcript/codex/locate.go.

import { createHash } from "node:crypto"
import { readFileSync, realpathSync, statSync } from "node:fs"
import { readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import type { Snapshot } from "../../screen/index.ts"
import { GenericAdapter } from "../generic.ts"
import type {
  Adapter,
  Event,
  InputOption,
  InputRequest,
  Turn,
} from "../types.ts"
import { InputRequested, InputResolved, TurnComplete } from "../types.ts"

const enc = new TextEncoder()

// tokenUsageRE matches the per-turn Token usage footer Codex printed on ≤0.141.
// Kept strict (anchored full footer) so it cannot false-fire on reply prose.
const tokenUsageRE =
  /Token usage: total=[\d,]+ input=[\d,]+ \(\+ [\d,]+ cached\) output=[\d,]+(?: \(reasoning \d+\))?/g

// resumeRE matches the "codex resume <uuid>" hint Codex printed on ≤0.141.
const resumeRE =
  /codex resume ([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/

/** Adapter implements turns.Adapter for Codex CLI. */
export class CodexAdapter extends GenericAdapter implements Adapter {
  /** Overrides ~/.codex/sessions for the on-disk session-id fallback. */
  sessionsRoot = ""

  private lastFingerprint = ""
  private lastInputID = ""
  private lastInput: InputRequest | null = null

  override name(): string {
    return "codex"
  }

  override onScreen(snap: Snapshot): Event[] {
    const out: Event[] = []

    // Turn-complete detection — newest Token usage footer differs from last.
    const matches = snap.text.match(tokenUsageRE)
    if (matches && matches.length > 0) {
      const latest = matches[matches.length - 1]!
      if (latest !== this.lastFingerprint) {
        this.lastFingerprint = latest
        out.push({ kind: TurnComplete, reason: "codex: " + latest })
      }
    }

    // Blocking startup interstitial — transition on the request ID.
    const req = DetectInput(snap.text)
    if (req) {
      if (req.id !== this.lastInputID) {
        this.lastInputID = req.id
        this.lastInput = req
        out.push({
          kind: InputRequested,
          reason: "codex: " + req.prompt,
          input: req,
        })
      }
    } else if (this.lastInputID !== "") {
      const resolved = this.lastInput ?? {
        id: this.lastInputID,
        kind: "",
        prompt: "",
      }
      this.lastInputID = ""
      this.lastInput = null
      out.push({
        kind: InputResolved,
        reason: "codex: input resolved",
        input: resolved,
      })
    }

    return out
  }

  /** Implements turns.SessionIDExtractor (legacy ≤0.141 screen scrape). */
  extractSessionID(snap: Snapshot): [string, boolean] {
    const m = resumeRE.exec(snap.text)
    if (!m) return ["", false]
    return [m[1]!, true]
  }

  /** Implements turns.SessionIDLocator (disk fallback for 0.142+). */
  locateSessionID(workingDir: string): [string, boolean] {
    return locateLatestSession(this.sessionsRoot, workingDir)
  }

  /** Implements turns.TranscriptReader. */
  readTranscript(_harnessSessionID: string, _workingDir: string): Turn[] {
    throw new Error("codex transcript reader not yet ported")
  }
}

/** Constructs a Codex adapter. */
export function New(): CodexAdapter {
  return new CodexAdapter()
}

// ── Interstitial detection (input.go) ────────────────────────────────────────

const updateAnchor = "Update available!"
const migrationAnchor = "Choose how you'd like Codex to proceed"
const continueAnchor = "Press enter to continue"

export const KindUpdateNotice = "codex_update_notice"
export const KindModelMigration = "codex_model_migration"
export const KindNotice = "codex_notice"

// menuRE matches a Codex numbered menu row, with optional "›" highlight marker.
const menuRE = /^[^\S\r\n]*(?:›[^\S\r\n]*)?(\d+)\.[^\S\r\n]+(.+?)[^\S\r\n]*$/gm

// promptRE matches the idle composer prompt indicator — the "›" glyph alone.
const promptRE = /^[^\S\r\n]*›/m

/**
 * DetectInput recognizes a blocking startup interstitial in the rendered screen
 * text and returns the structured request, or null when none is present.
 */
export function DetectInput(text: string): InputRequest | null {
  if (text.includes(updateAnchor)) {
    const opts = parseMenuOptions(text)
    const req: InputRequest = {
      id: "",
      kind: KindUpdateNotice,
      prompt: updateAnchor,
      options: opts,
    }
    // Require a parsed "Skip" row to confirm this is the live update menu.
    if (findByAlias(req, "skip") === null) return null
    req.id = inputID(req)
    return req
  }
  if (text.includes(migrationAnchor)) {
    const req: InputRequest = {
      id: "",
      kind: KindModelMigration,
      prompt: migrationAnchor,
      options: continueOption(),
    }
    req.id = inputID(req)
    return req
  }
  if (text.includes(continueAnchor)) {
    let opts = parseMenuOptions(text)
    if (opts.length === 0) opts = continueOption()
    const req: InputRequest = {
      id: "",
      kind: KindNotice,
      prompt: continueAnchor,
      options: opts,
    }
    req.id = inputID(req)
    return req
  }
  return null
}

/** Reports whether the idle composer prompt is on screen (gate behind DetectInput). */
export function PromptReady(text: string): boolean {
  return promptRE.test(text)
}

/**
 * AutoDismissKeys returns the keystrokes that safely dismiss an interstitial
 * without triggering a destructive action, and whether it is auto-dismissable.
 */
export function AutoDismissKeys(
  req: InputRequest | null,
): [Uint8Array | null, boolean] {
  if (!req) return [null, false]
  switch (req.kind) {
    case KindUpdateNotice: {
      const o = findByAlias(req, "skip")
      if (o) return [o.keys, true]
      return [null, false]
    }
    case KindNotice:
      // A KindNotice is classified only when the screen shows the "Press enter
      // to continue" anchor and is neither an update notice nor a model
      // migration (both are matched earlier in DetectInput and carry their own
      // safe dismissal). Enter is the continuation codex itself advertises, so a
      // bare CR clears the notice regardless of how many numbered body lines
      // parseMenuOptions happened to extract — a multi-option notice with no
      // safe-token menu row is exactly the case that previously surfaced and
      // blocked the codex plan-critic on its first send (ORCHE-68). Genuine
      // command-approval prompts are a different kind and are never classified as
      // KindNotice, so they still surface and are not auto-answered.
      return [enc.encode("\r"), true]
    case KindModelMigration:
      return [enc.encode("\r"), true]
    default:
      return [null, false]
  }
}

function continueOption(): InputOption[] {
  return [
    { id: "continue", alias: "continue", label: "Continue", keys: enc.encode("\r") },
  ]
}

function parseMenuOptions(text: string): InputOption[] {
  const opts: InputOption[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(menuRE)) {
    const num = m[1]!
    const label = cleanLabel(m[2]!)
    if (seen.has(num) || label === "") continue
    seen.add(num)
    opts.push({
      id: num,
      alias: aliasForLabel(label),
      label,
      keys: enc.encode(num + "\r"),
    })
  }
  return opts
}

function cleanLabel(s: string): string {
  const i = s.indexOf("  ")
  if (i >= 0) s = s.slice(0, i)
  return s.trim()
}

function aliasForLabel(label: string): string {
  const l = label.toLowerCase()
  if (l.includes("skip")) return "skip"
  if (l.includes("update")) return "update"
  return ""
}

function findByAlias(req: InputRequest, alias: string): InputOption | null {
  for (const o of req.options ?? []) {
    if (o.alias === alias) return o
  }
  return null
}

function inputID(req: InputRequest): string {
  const parts = [req.kind, req.prompt, ...(req.options ?? []).map((o) => o.label)]
  const sum = createHash("sha256").update(parts.join("\0")).digest()
  return sum.subarray(0, 8).toString("hex")
}

// ── Disk-based session-id fallback (locate.go) ───────────────────────────────

/**
 * Returns the session UUID of the most recently modified rollout whose
 * session_meta cwd matches workingDir, or ["", false]. Paths are compared after
 * resolving symlinks so a symlinked workingDir still matches the recorded cwd.
 */
export function locateLatestSession(
  sessionsRoot: string,
  workingDir: string,
): [string, boolean] {
  if (workingDir === "") return ["", false]
  const want = canonicalDir(workingDir)
  const root = resolveSessionsRoot(sessionsRoot)
  if (root === null) return ["", false]

  let bestID = ""
  let bestMod = 0
  let found = false

  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // skip unreadable subtrees
    }
    for (const e of entries) {
      const path = join(dir, e.name)
      if (e.isDirectory()) {
        walk(path)
        continue
      }
      if (!e.name.endsWith(".jsonl")) continue
      const meta = readSessionMeta(path)
      if (!meta || meta.sessionID === "" || canonicalDir(meta.cwd) !== want) {
        continue
      }
      let mod: number
      try {
        mod = statSync(path).mtimeMs
      } catch {
        continue
      }
      if (!found || mod > bestMod) {
        bestID = meta.sessionID
        bestMod = mod
        found = true
      }
    }
  }
  walk(root)
  return [bestID, found]
}

function resolveSessionsRoot(sessionsRoot: string): string | null {
  if (sessionsRoot !== "") return sessionsRoot
  const home = process.env.HOME
  if (!home) return null
  return join(home, ".codex", "sessions")
}

function canonicalDir(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

interface SessionMeta {
  sessionID: string
  cwd: string
}

function readSessionMeta(path: string): SessionMeta | null {
  let content: string
  try {
    content = readFileSync(path, "utf8")
  } catch {
    return null
  }
  const nl = content.indexOf("\n")
  const firstLine = nl >= 0 ? content.slice(0, nl) : content
  if (firstLine.trim() === "") return null
  let env: { type?: string; payload?: { session_id?: string; cwd?: string } }
  try {
    env = JSON.parse(firstLine)
  } catch {
    return null
  }
  if (env.type !== "session_meta" || !env.payload) return null
  return {
    sessionID: env.payload.session_id ?? "",
    cwd: env.payload.cwd ?? "",
  }
}
