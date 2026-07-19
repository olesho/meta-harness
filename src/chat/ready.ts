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
const claudeTrustAnchor = "Do you trust the files in this folder?";
const claudeTrustAnchorAlt = "Is this a project you created or one you trust?";
const claudeBypassAnchor = "Bypass Permissions mode";

// claudeComposerRE matches the idle composer prompt line: a "❯" alone on its
// own line (only whitespace after). While a turn is in flight the composer is
// replaced by the spinner, past prompts render as "❯ <text>" (non-empty), and
// blocking dialogs render "❯ 1. Yes…" menu rows — none of which match.
const claudeComposerRE = /^[^\S\r\n]*❯[^\S\r\n]*$/m;

function claudeBlockingDialog(text: string): boolean {
  return (
    text.includes(claudeTrustAnchor) ||
    text.includes(claudeTrustAnchorAlt) ||
    text.includes(claudeBypassAnchor)
  );
}

// --- codex interstitial / composer detection (port of codex/input.go) ---

const codexUpdateAnchor = "Update available!";
const codexMigrationAnchor = "Choose how you'd like Codex to proceed";
const codexContinueAnchor = "Press enter to continue";

// Genuine command / apply-patch approval anchors (mirrored from the turns codex
// adapter — full sentences captured live from codex-cli 0.144.4).
const codexApprovalAnchors = [
  "Would you like to run the following command?",
  "Would you like to make the following edits?",
];

// promptRE matches the idle composer prompt indicator on its own line — the "›"
// Codex prints at the start of the input box once it is ready for input.
const codexPromptRE = /^[^\S\r\n]*›/m;

// codexMenuHighlightRE matches a "›"-highlighted numbered menu row anywhere on
// screen. Used ONLY inside codexBlockingDialog, gated by an approval anchor.
const codexMenuHighlightRE = /^[^\S\r\n]*›[^\S\r\n]*\d+\./m;

function codexBlockingInterstitial(text: string): boolean {
  return (
    text.includes(codexUpdateAnchor) ||
    text.includes(codexMigrationAnchor) ||
    text.includes(codexContinueAnchor)
  );
}

// codexBlockingDialog gates a genuine approval dialog (command / apply-patch).
//
// It diverges STRUCTURALLY from the bare-includes() codexBlockingInterstitial on
// purpose: the interstitial anchors ("Update available!", …) are not prose-like,
// so a bare substring match is safe. The approval anchors are plausible
// assistant prose ("Would you like to run the tests?"), and a bare-includes()
// match on an ordinary idle reply would pin readyForInput false forever —
// awaitPromptReady would block sends indefinitely and maybeIdleComplete would
// never complete the turn (a silent hang). So this predicate additionally
// requires a "›"-highlighted numbered menu row, which ordinary prose lacks.
//
// The turns adapter (src/turns/harness/codex.ts) uses a strict per-row highlight
// flag; ready.ts cannot reach its parsed options, so the screen-wide regex here
// is acceptable — a scrollback-echo false positive additionally needs the anchor
// text on the same idle screen, and its blast radius is one conservative
// not-ready beat, not the detection deadlock the per-row flag guards against.
function codexBlockingDialog(text: string): boolean {
  if (!codexApprovalAnchors.some((a) => text.includes(a))) return false;
  return codexMenuHighlightRE.test(text);
}

function codexPromptReady(text: string): boolean {
  return codexPromptRE.test(text);
}

// --- pi composer detection (port of pi/pi.go) ---

const piBusyTexts = ["Working...", "Working…", "Thinking...", "Thinking…"];

function piBusy(text: string): boolean {
  return piBusyTexts.some((m) => text.includes(m));
}

// statusLineRE matches pi's idle status-line context-usage indicator, e.g.
// "0.0%/131k" or "12.3%/200K" — painted once pi's composer accepts input.
const piStatusLineRE = /\d+(?:\.\d+)?%\/\d+[kK]/;

function piPromptReady(text: string): boolean {
  return !piBusy(text) && piStatusLineRE.test(text);
}

/** requiresPromptReadiness reports whether Send must wait for a ready prompt. */
export function requiresPromptReadiness(harness: string): boolean {
  switch (harness) {
    case "claude-code":
    case "codex":
    case "pi":
      return true;
    default:
      return false;
  }
}

/** readyForInput reports whether the harness composer is ready for a message. */
export function readyForInput(harness: string, text: string): boolean {
  switch (harness) {
    case "claude-code":
      // A blocking dialog (folder trust, bypass acceptance) renders its own
      // "❯" selector + "Claude Code" header and would otherwise look ready —
      // reject those outright, mirroring the codex interstitial handling.
      if (claudeBlockingDialog(text)) return false;
      // Positive signal: the EMPTY composer line ("❯" alone on its own line),
      // not merely header + "❯" anywhere — verified against the live 2.1.201
      // ready screen and the 2.1.185 corpus.
      return text.includes("Claude Code") && claudeComposerRE.test(text);
    case "codex":
      // A blocking startup interstitial renders its own "›" highlight and looks
      // ready — treat it as not-ready so Send waits for the auto-dismiss.
      if (codexBlockingInterstitial(text)) return false;
      // A genuine approval dialog (anchor + highlighted menu row) is likewise
      // not-ready while it is up, even though its highlighted menu row satisfies
      // codexPromptReady.
      if (codexBlockingDialog(text)) return false;
      return codexPromptReady(text);
    case "pi":
      return piPromptReady(text);
    default:
      return true;
  }
}

// --- logged-out / re-authentication detection (both harnesses) ---
//
// A harness whose CLI login has expired or was never established produces NO
// assistant output for the turn. The observed terminal-screen banners (grounded
// in real CLI output, not invented):
//   - claude-code: "Not logged in · Please run /login" (printed then exit), and
//     the "run /login" family of re-auth banners.
//   - codex:       the turn fails with "401 Unauthorized: missing bearer or basic
//     authentication" on screen; `codex login status` / a logged-out TUI say
//     "Not logged in"; codex's own remediation is "run `codex login`".
//
// These anchors are matched ONLY at a turn's terminal point, and ONLY once it has
// yielded no clean assistant output (see conversation.ts) — they EXPLAIN a failed
// turn, they never complete one. That gating is what keeps a genuine reply merely
// mentioning logins, or a benign "your login expires in N days" WARNING on a
// still-valid session, from ever being scanned and mislabeled.
const claudeAuthRE = [/\brun \/login\b/i, /\bnot logged in\b/i];
const codexAuthRE = [
  /\b401 unauthorized\b/i,
  /missing bearer or basic authentication/i,
  /\bnot logged in\b/i,
  /\b(?:re-?run|run) ['"`]?codex(?: mcp)? login/i,
];

/**
 * authRequired reports whether the rendered screen shows a harness login-expiry /
 * logged-out banner. Callers MUST gate this on a turn that produced no clean
 * assistant output — it is a failure EXPLANATION, not a turn-completion signal.
 * Returns false for any harness without a known banner set.
 */
export function authRequired(harness: string, text: string): boolean {
  switch (harness) {
    case "claude-code":
      return claudeAuthRE.some((re) => re.test(text));
    case "codex":
      return codexAuthRE.some((re) => re.test(text));
    default:
      return false;
  }
}

/** submitKeyForHarness pins the per-harness Enter key. */
export function submitKeyForHarness(
  harness: string,
  _screenText: string,
): Uint8Array {
  switch (harness) {
    case "claude-code":
    case "codex":
      // Both run the kitty keyboard protocol unconditionally: a plain CR/LF from
      // a synthetic PTY writer is NOT a submit — CSI 13 u (unmodified Enter) is.
      // Re-verified live against claude-code 2.1.201 (record-pty probe): the
      // prompt + CSI 13 u submits and assistant output follows, so no
      // per-version conditioning is needed here.
      return new TextEncoder().encode("\x1b[13u");
    case "pi":
      // pi submits on a plain carriage return; a bare "\n" leaves the prompt
      // unsent. pi does not enable the kitty protocol.
      return new TextEncoder().encode("\r");
    default:
      return new TextEncoder().encode("\n");
  }
}
