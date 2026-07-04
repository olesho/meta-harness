// Turn-detection adapter for the Codex CLI (github.com/openai/codex).
//
// Legacy (≤0.141): every turn ended with a "Token usage:" footer — a per-turn
// fingerprint that drove TurnComplete. Codex 0.142+ removed that footer, so
// OnScreen stays silent on current Codex. The legacy path is kept for any codex
// still emitting the footer and is locked in by the corpus tests.
//
// Session-id capture is an own-output `/status` scrape: the chat layer primes
// the session at first idle by writing `/status`, which renders a box containing
// `│ Session: <uuid> │`; extractSessionID reads that (and the legacy / `/quit`
// `codex resume <uuid>` hint). Reading a process's own output cannot collide
// with another process, so capture is race-free by construction — the old
// disk-locate fallback (racy across sessions sharing a cwd) was removed. The
// transcript reader (readTranscript / CodexReader) still reads disk, but that is
// keyed on an already-captured id and is a separate concern.

import { createHash } from "node:crypto"
import type { TranscriptTurn } from "../../chat/deps.ts"
import type { Snapshot } from "../../screen/index.ts"
import { CodexReader, turnsFromEvents } from "../../transcript/index.ts"
import { GenericAdapter } from "../generic.ts"
import type {
  Adapter,
  Event,
  InputOption,
  InputRequest,
} from "../types.ts"
import { InputRequested, InputResolved, TurnComplete } from "../types.ts"

const enc = new TextEncoder()

// tokenUsageRE matches the per-turn Token usage footer Codex printed on ≤0.141.
// Kept strict (anchored full footer) so it cannot false-fire on reply prose.
const tokenUsageRE =
  /Token usage: total=[\d,]+ input=[\d,]+ \(\+ [\d,]+ cached\) output=[\d,]+(?: \(reasoning \d+\))?/g

// resumeRE matches the "codex resume <uuid>" hint — the legacy ≤0.141 footer AND
// the 0.142+ `/quit` / `/exit` hint ("To continue this session, run codex resume
// <uuid>"). Already-specific text, low spoof risk, so it is scanned ungated.
const resumeRE =
  /codex resume ([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/

const UUID_RE_SRC =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"

// statusSessionRE matches the `Session: <uuid>` row INSIDE the `/status` box,
// anchored on the vertical box borders (│ … │) on the SAME physical row. Only the
// rendered `/status` box draws those borders around the label, so this excludes a
// bare `Session: <uuid>` string appearing in reply prose. It assumes the row
// renders unwrapped on one screen line — see CODEX_STATUS_MIN_COLS.
const statusSessionRE = new RegExp(
  "│[^\\S\\r\\n]*Session:[^\\S\\r\\n]+(" +
    UUID_RE_SRC +
    ")[^\\S\\r\\n]*│",
)

// statusBoxHeaderRE gates statusSessionRE on the `/status` box header so a lone
// spoofed box row (borders around a "Session:" line in some other context) cannot
// match. The header is the Codex banner the `/status` box renders above the rows.
const statusBoxHeaderRE = />_ OpenAI Codex \(v/

/**
 * CODEX_STATUS_MIN_COLS is the minimum terminal width at which the `/status` box
 * renders the `│ Session: <uuid> │` row unwrapped on a single line. The UUID (36
 * chars) plus the "Session: " label, the two `│` borders, and box padding needs
 * ~50 columns; the observed real 0.142.5 `/status` box is wider still, so the
 * primer requires at least this many columns before writing `/status`. Below it
 * the row wraps and the scrape silently fails, so the primer skips the write
 * (records a `too_narrow` outcome) and leaves the `/quit` hint as the backstop.
 * Set from the observed box width during the manual smoke.
 */
export const CODEX_STATUS_MIN_COLS = 60

/** Adapter implements turns.Adapter for Codex CLI. */
export class CodexAdapter extends GenericAdapter implements Adapter {
  /** Overrides ~/.codex/sessions for the transcript reader (readTranscript). */
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

  /**
   * Implements turns.SessionIDExtractor — an own-output screen scrape.
   *
   * Two signals, tried in order:
   *   1. resumeRE — the `codex resume <uuid>` hint (legacy footer AND the 0.142+
   *      `/quit` hint). Already specific text, scanned ungated.
   *   2. statusSessionRE — the `│ Session: <uuid> │` row inside the `/status`
   *      box. Gated on statusBoxHeaderRE so a lone spoofed box row cannot match.
   *
   * Called on arbitrary later snapshots too (the TurnComplete path), so the
   * status match is border-anchored AND header-gated to avoid mis-capturing a
   * `Session: <uuid>`-shaped string in reply prose.
   */
  extractSessionID(snap: Snapshot): [string, boolean] {
    const m = resumeRE.exec(snap.text)
    if (m) return [m[1]!, true]
    if (statusBoxHeaderRE.test(snap.text)) {
      const s = statusSessionRE.exec(snap.text)
      if (s) return [s[1]!, true]
    }
    return ["", false]
  }

  /**
   * Implements turns.SessionIDPrimer — the keystrokes that make Codex print its
   * session id on screen: the `/status` slash command followed by the CSI 13 u
   * submit key (unmodified Enter under the kitty keyboard protocol; mirrors
   * submitKeyForHarness("codex") and the quit sequence's hardcoded submit).
   */
  primeSessionIDKeys(): Uint8Array {
    return enc.encode("/status" + "\x1b[13u")
  }

  /** Implements turns.SessionResumer — `codex resume <uuid>`. */
  resumeArgs(harnessSessionID: string): string[] {
    return ["resume", harnessSessionID]
  }

  /**
   * Implements turns.SessionForkResumer. False: `codex resume <uuid>` continues
   * the same session id — VERIFIED against codex-cli 0.142.5 (2026-07-03): the
   * resume banner reports the same "session id: <uuid>" and the migrated rollout
   * envelope keeps the original session_id. Because the id is preserved on
   * resume, the chat layer must NOT arm its one-shot provisional id refresh.
   */
  resumeForksSessionID(): boolean {
    return false
  }

  /** Implements turns.TranscriptReader. */
  readTranscript(
    harnessSessionID: string,
    workingDir: string,
  ): TranscriptTurn[] {
    const events = new CodexReader(this.sessionsRoot).read(
      harnessSessionID,
      workingDir,
    )
    return turnsFromEvents(events).map((t) => ({
      role: t.role,
      text: t.text,
      timestamp: t.timestamp ?? new Date(0),
    }))
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
      // blocked the codex plan-critic on its first send. Genuine
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
