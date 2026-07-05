// Send-readiness gating and per-harness submit keys — the TS port of
// pkg/chat/ready.go.
//
// In Go these delegate to the turns harness packages (codex.PromptReady,
// pi.PromptReady, claudecode.DetectInput). Those predicates are small and
// stable, so the few the chat readiness gate consumes are ported inline here
// rather than reaching across the (separately-owned) turns layer for them.

// --- claude-code composer / blocking-dialog detection ---

// Blocking-dialog anchors (mirrored inline from the turns claudecode adapter,
// per this file's convention — the chat layer stays turns-free). Each of these
// dialogs renders its own "❯" selector under the "Claude Code" header, which
// the old header+selector heuristic mistook for a ready composer.
const claudeTrustAnchor = "Do you trust the files in this folder?"
const claudeTrustAnchorAlt = "Is this a project you created or one you trust?"
const claudeBypassAnchor = "Bypass Permissions mode"

// claudeComposerRE matches the idle composer prompt line: a "❯" alone on its
// own line (only whitespace after). While a turn is in flight the composer is
// replaced by the spinner, past prompts render as "❯ <text>" (non-empty), and
// blocking dialogs render "❯ 1. Yes…" menu rows — none of which match.
const claudeComposerRE = /^[^\S\r\n]*❯[^\S\r\n]*$/m

function claudeBlockingDialog(text: string): boolean {
  return (
    text.includes(claudeTrustAnchor) ||
    text.includes(claudeTrustAnchorAlt) ||
    text.includes(claudeBypassAnchor)
  )
}

// --- codex interstitial / composer detection (port of codex/input.go) ---

const codexUpdateAnchor = "Update available!"
const codexMigrationAnchor = "Choose how you'd like Codex to proceed"
const codexContinueAnchor = "Press enter to continue"

// promptRE matches the idle composer prompt indicator on its own line — the "›"
// Codex prints at the start of the input box once it is ready for input.
const codexPromptRE = /^[^\S\r\n]*›/m

function codexBlockingInterstitial(text: string): boolean {
  return (
    text.includes(codexUpdateAnchor) ||
    text.includes(codexMigrationAnchor) ||
    text.includes(codexContinueAnchor)
  )
}

function codexPromptReady(text: string): boolean {
  return codexPromptRE.test(text)
}

// --- pi composer detection (port of pi/pi.go) ---

const piBusyTexts = ["Working...", "Working…", "Thinking...", "Thinking…"]

function piBusy(text: string): boolean {
  return piBusyTexts.some((m) => text.includes(m))
}

// statusLineRE matches pi's idle status-line context-usage indicator, e.g.
// "0.0%/131k" or "12.3%/200K" — painted once pi's composer accepts input.
const piStatusLineRE = /\d+(?:\.\d+)?%\/\d+[kK]/

function piPromptReady(text: string): boolean {
  return !piBusy(text) && piStatusLineRE.test(text)
}

/** requiresPromptReadiness reports whether Send must wait for a ready prompt. */
export function requiresPromptReadiness(harness: string): boolean {
  switch (harness) {
    case "claude-code":
    case "codex":
    case "pi":
      return true
    default:
      return false
  }
}

/** readyForInput reports whether the harness composer is ready for a message. */
export function readyForInput(harness: string, text: string): boolean {
  switch (harness) {
    case "claude-code":
      // A blocking dialog (folder trust, bypass acceptance) renders its own
      // "❯" selector + "Claude Code" header and would otherwise look ready —
      // reject those outright, mirroring the codex interstitial handling.
      if (claudeBlockingDialog(text)) return false
      // Positive signal: the EMPTY composer line ("❯" alone on its own line),
      // not merely header + "❯" anywhere — verified against the live 2.1.201
      // ready screen and the 2.1.185 corpus.
      return text.includes("Claude Code") && claudeComposerRE.test(text)
    case "codex":
      // A blocking startup interstitial renders its own "›" highlight and looks
      // ready — treat it as not-ready so Send waits for the auto-dismiss.
      if (codexBlockingInterstitial(text)) return false
      return codexPromptReady(text)
    case "pi":
      return piPromptReady(text)
    default:
      return true
  }
}

/** submitKeyForHarness pins the per-harness Enter key. */
export function submitKeyForHarness(harness: string, _screenText: string): Uint8Array {
  switch (harness) {
    case "claude-code":
    case "codex":
      // Both run the kitty keyboard protocol unconditionally: a plain CR/LF from
      // a synthetic PTY writer is NOT a submit — CSI 13 u (unmodified Enter) is.
      // Re-verified live against claude-code 2.1.201 (record-pty probe): the
      // prompt + CSI 13 u submits and assistant output follows, so no
      // per-version conditioning is needed here.
      return new TextEncoder().encode("\x1b[13u")
    case "pi":
      // pi submits on a plain carriage return; a bare "\n" leaves the prompt
      // unsent. pi does not enable the kitty protocol.
      return new TextEncoder().encode("\r")
    default:
      return new TextEncoder().encode("\n")
  }
}
