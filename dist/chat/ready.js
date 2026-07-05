// Send-readiness gating and per-harness submit keys — the TS port of
// pkg/chat/ready.go.
//
// In Go these delegate to the turns harness packages (codex.PromptReady,
// pi.PromptReady, claudecode.DetectInput). Those predicates are small and
// stable, so the few the chat readiness gate consumes are ported inline here
// rather than reaching across the (separately-owned) turns layer for them.
// --- codex interstitial / composer detection (port of codex/input.go) ---
const codexUpdateAnchor = "Update available!";
const codexMigrationAnchor = "Choose how you'd like Codex to proceed";
const codexContinueAnchor = "Press enter to continue";
// promptRE matches the idle composer prompt indicator on its own line — the "›"
// Codex prints at the start of the input box once it is ready for input.
const codexPromptRE = /^[^\S\r\n]*›/m;
function codexBlockingInterstitial(text) {
    return (text.includes(codexUpdateAnchor) ||
        text.includes(codexMigrationAnchor) ||
        text.includes(codexContinueAnchor));
}
function codexPromptReady(text) {
    return codexPromptRE.test(text);
}
// --- pi composer detection (port of pi/pi.go) ---
const piBusyTexts = ["Working...", "Working…", "Thinking...", "Thinking…"];
function piBusy(text) {
    return piBusyTexts.some((m) => text.includes(m));
}
// statusLineRE matches pi's idle status-line context-usage indicator, e.g.
// "0.0%/131k" or "12.3%/200K" — painted once pi's composer accepts input.
const piStatusLineRE = /\d+(?:\.\d+)?%\/\d+[kK]/;
function piPromptReady(text) {
    return !piBusy(text) && piStatusLineRE.test(text);
}
/** requiresPromptReadiness reports whether Send must wait for a ready prompt. */
export function requiresPromptReadiness(harness) {
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
export function readyForInput(harness, text) {
    switch (harness) {
        case "claude-code":
            // A blocking dialog renders its own "❯" selector + "Claude Code" header,
            // which would otherwise look ready; the header+selector heuristic alone is
            // used here (the turns adapter owns the full dialog detection).
            return text.includes("Claude Code") && text.includes("❯");
        case "codex":
            // A blocking startup interstitial renders its own "›" highlight and looks
            // ready — treat it as not-ready so Send waits for the auto-dismiss.
            if (codexBlockingInterstitial(text))
                return false;
            return codexPromptReady(text);
        case "pi":
            return piPromptReady(text);
        default:
            return true;
    }
}
/** submitKeyForHarness pins the per-harness Enter key. */
export function submitKeyForHarness(harness, _screenText) {
    switch (harness) {
        case "claude-code":
        case "codex":
            // Both run the kitty keyboard protocol unconditionally: a plain CR/LF from
            // a synthetic PTY writer is NOT a submit — CSI 13 u (unmodified Enter) is.
            return new TextEncoder().encode("\x1b[13u");
        case "pi":
            // pi submits on a plain carriage return; a bare "\n" leaves the prompt
            // unsent. pi does not enable the kitty protocol.
            return new TextEncoder().encode("\r");
        default:
            return new TextEncoder().encode("\n");
    }
}
//# sourceMappingURL=ready.js.map