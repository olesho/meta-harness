// Turn-detection adapter for Anthropic's Claude Code CLI.
//
// Detection signals (verified against 2.1.x):
//   - End of an assistant turn: a "✻ <verb> for Ns" thinking-summary line.
//   - User interrupt: a "⎿  Interrupted · What should Claude do instead?" line.
//   - Blocking startup dialogs (folder-trust, bypass acceptance).
//
// Embeds the generic adapter so wrapper-level status events keep flowing.
// Port of pkg/turns/harness/claudecode/{claudecode.go}.

import { createHash } from "node:crypto"
import type { Snapshot } from "../../screen/index.ts"
import { GenericAdapter } from "../generic.ts"
import type {
  Adapter,
  Event,
  InputOption,
  InputRequest,
  Turn,
} from "../types.ts"
import { Errored, InputRequested, InputResolved, TurnComplete } from "../types.ts"

const enc = new TextEncoder()

// thinkingRE matches the end-of-turn thinking-summary line, anchored to its own
// line so it does not mis-fire when the model echoes the marker shape in prose.
// The duration is one or more <number><unit> components (unit ∈ {h,m,s}).
const thinkingRE =
  /^[^\S\r\n]*(✻ \p{Lu}\p{L}+ for \d+[hms](?: \d+[hms])*)[^\S\r\n]*$/gmu

// resumeRE matches the "claude --resume <uuid>" hint Claude Code prints on exit.
const resumeRE =
  /claude --resume ([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/

// interruptMarker is the literal text after the user interrupts a reply.
// Note the NBSP (U+00A0) between the two spaces — matched exactly.
const interruptMarker = "⎿  Interrupted · What should Claude do instead?"

// Blocking-dialog anchors.
const trustAnchor = "Do you trust the files in this folder?"
const trustAnchorAlt = "Is this a project you created or one you trust?"
const bypassAnchor = "Bypass Permissions mode"

// menuRE matches a numbered menu item line, e.g. "❯ 1. Yes, proceed".
const menuRE = /^[^\dA-Za-z\n]*(\d)\.[^\S\n]+(\S[^\n]*)$/gm

// bulletRE matches the start of a rendered assistant/tool message ("⏺ <text>").
const bulletRE = /^[^\S\r\n]*⏺ (.*)$/u
// toolResultRE matches a tool-result continuation line ("⎿").
const toolResultRE = /^[^\S\r\n]*⎿/u
// boxOrRuleRE matches a horizontal rule / box border line.
const boxOrRuleRE = /^[^\S\r\n]*[─━╭╮╰╯│┌┐└┘]/u

// busyMarker is shown ONLY while a turn is in flight.
const busyMarker = "esc to interrupt"

// workingRE matches Claude Code's in-progress spinner line by its structural
// signature: an ellipsis, a parenthesized elapsed duration, then " · ".
const workingRE = /(?:…|\.\.\.)[^\S\r\n]*\(\d+[hms][^)\r\n]*·/u

// quitCommand is "/quit" + Claude's enhanced Enter (CSI 13 u).
const quitCommand = enc.encode("/quit\x1b[13u")

/** Adapter implements turns.Adapter for Claude Code. */
export class ClaudeCodeAdapter extends GenericAdapter implements Adapter {
  private lastFingerprint = ""
  private lastInterruptSeen = false
  private lastInputID = ""
  private lastInput: InputRequest | null = null

  override name(): string {
    return "claude-code"
  }

  override onScreen(snap: Snapshot): Event[] {
    const out: Event[] = []

    // Interrupt detection — transition not-seen → seen.
    const interruptNow = snap.text.includes(interruptMarker)
    if (interruptNow && !this.lastInterruptSeen) {
      out.push({ kind: Errored, reason: "claude-code: " + interruptMarker })
    }
    this.lastInterruptSeen = interruptNow

    // Turn-complete detection — newest thinking marker differs from last fired.
    // Gated on Busy(): an intermediate marker (still working) must not complete.
    const matches = [...snap.text.matchAll(thinkingRE)]
    if (matches.length > 0 && !this.busy(snap)) {
      const latest = matches[matches.length - 1]![1]!
      if (latest !== this.lastFingerprint) {
        this.lastFingerprint = latest
        out.push({ kind: TurnComplete, reason: "claude-code: " + latest })
      }
    }

    // Blocking interactive prompt — transition on the request ID.
    const req = DetectInput(snap.text)
    if (req) {
      if (req.id !== this.lastInputID) {
        this.lastInputID = req.id
        this.lastInput = req
        out.push({
          kind: InputRequested,
          reason: "claude-code: " + req.prompt,
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
        reason: "claude-code: input resolved",
        input: resolved,
      })
    }

    return out
  }

  /** Implements turns.MessageExtractor. */
  extractMessage(snap: Snapshot): [string, boolean] {
    const lines = snap.text.split("\n")

    // Scope to the most-recently-completed turn: its "✻ … for Ns" footer is the
    // lower bound. The final assistant message is the last "⏺" block above it.
    let limit = lines.length
    for (let i = 0; i < lines.length; i++) {
      if (matchLine(thinkingRE, lines[i]!)) limit = i
    }

    let start = -1
    for (let i = 0; i < limit; i++) {
      if (bulletRE.test(lines[i]!)) start = i
    }
    if (start < 0) {
      for (let i = 0; i < lines.length; i++) {
        if (bulletRE.test(lines[i]!)) start = i
      }
    }
    if (start < 0) return ["", false]

    const m = bulletRE.exec(lines[start]!)!
    const block: string[] = [trimRight(m[1]!, " ")]

    // Consume indented continuation lines until a boundary.
    for (let i = start + 1; i < lines.length; i++) {
      const ln = lines[i]!
      if (bulletRE.test(ln) || toolResultRE.test(ln) || boxOrRuleRE.test(ln)) {
        break
      }
      if (matchLine(thinkingRE, ln)) break
      if (trimLeft(ln, " ").startsWith("❯")) break
      if (ln.trim() === "") {
        // A blank line is a paragraph break within the message, not its end.
        block.push("")
        continue
      }
      block.push(trimRight(ln, " "))
    }
    // Drop trailing blank lines.
    while (block.length > 1 && block[block.length - 1]!.trim() === "") {
      block.pop()
    }

    let msg = block[0]!
    if (block.length > 1) {
      const tail = dedent(block.slice(1))
      if (tail !== "") msg += "\n" + tail
    }
    if (msg.trim() === "") return ["", false]
    return [msg, true]
  }

  /** Implements turns.BusyDetector. */
  busy(snap: Snapshot): boolean {
    return snap.text.includes(busyMarker) || workingRE.test(snap.text)
  }

  /** Implements turns.Quitter. */
  quitSequence(): Uint8Array {
    return quitCommand
  }

  /** Implements turns.SessionResumer — `claude --resume <uuid>`. */
  resumeArgs(harnessSessionID: string): string[] {
    return ["--resume", harnessSessionID]
  }

  /** Implements turns.RawSessionIDExtractor. */
  extractSessionIDFromLine(line: string): [string, boolean] {
    const m = resumeRE.exec(line)
    if (!m) return ["", false]
    return [m[1]!, true]
  }

  /** Implements turns.TranscriptReader. */
  readTranscript(_harnessSessionID: string, _workingDir: string): Turn[] {
    throw new Error("claude-code transcript reader not yet ported")
  }
}

/** Constructs a Claude Code adapter. */
export function New(): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter()
}

/**
 * DetectInput recognizes a blocking interactive dialog in the rendered screen
 * text and returns the structured request, or null when none is present.
 */
export function DetectInput(text: string): InputRequest | null {
  let prompt: string
  if (text.includes(trustAnchor)) prompt = trustAnchor
  else if (text.includes(trustAnchorAlt)) prompt = trustAnchorAlt
  else if (text.includes(bypassAnchor)) prompt = bypassAnchor
  else return null

  const opts = parseMenuOptions(text)
  if (opts.length === 0) return null // anchor visible but menu not rendered yet
  const req: InputRequest = {
    id: "",
    kind: "trust_prompt",
    prompt,
    options: opts,
  }
  req.id = inputID(req)
  return req
}

function parseMenuOptions(text: string): InputOption[] {
  const opts: InputOption[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(menuRE)) {
    const num = m[1]!
    const label = cleanLabel(m[2]!)
    if (num === "0" || seen.has(num) || label === "") continue
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
  if (containsAny(l, "proceed", "accept", "trust", "yes", "continue")) {
    return "proceed"
  }
  if (
    containsAny(l, "exit", "deny", "reject", "cancel", "no,", "no ", "don't", "do not")
  ) {
    return "deny"
  }
  return ""
}

function containsAny(s: string, ...subs: string[]): boolean {
  return subs.some((sub) => s.includes(sub))
}

function inputID(req: InputRequest): string {
  const parts = [req.kind, req.prompt, ...(req.options ?? []).map((o) => o.label)]
  const sum = createHash("sha256").update(parts.join("\0")).digest()
  return sum.subarray(0, 8).toString("hex")
}

function dedent(lines: string[]): string {
  let minIndent = -1
  for (const ln of lines) {
    if (ln.trim() === "") continue
    const n = ln.length - trimLeft(ln, " ").length
    if (minIndent < 0 || n < minIndent) minIndent = n
  }
  if (minIndent <= 0) return trimRight(lines.join("\n"), "\n")
  const out = lines.map((ln) =>
    ln.length >= minIndent ? ln.slice(minIndent) : trimLeft(ln, " "),
  )
  return trimRight(out.join("\n"), "\n")
}

// matchLine tests a single line against a /g regex without leaking lastIndex.
function matchLine(re: RegExp, line: string): boolean {
  re.lastIndex = 0
  const ok = re.test(line)
  re.lastIndex = 0
  return ok
}

function trimRight(s: string, cut: string): string {
  let end = s.length
  while (end > 0 && cut.includes(s[end - 1]!)) end--
  return s.slice(0, end)
}

function trimLeft(s: string, cut: string): string {
  let start = 0
  while (start < s.length && cut.includes(s[start]!)) start++
  return s.slice(start)
}
