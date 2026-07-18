// CLI-facing harness allow-list for `meta-harness-wrapper`.
//
// This is a different concern from src/cli/run.ts's resolveHarnessName, which
// maps a CLI alias to the internal chat-adapter/classifier name for
// src/oneshot ("claude" -> "claude-code"). assertSupportedHarness instead
// validates the Go-parity CLI surface (cmd/harness-wrapper/harness_resolver.go)
// and passes the bare name straight through as both Config.harness and
// Config.binaryPath — start()/resolvePath() (src/discovery/discovery.ts) do the
// actual PATH lookup, so this module does not reimplement exec.LookPath.
//
// Gemini is out of scope (see HARNESS-WRAPPER-3 ticket Context): Go's table is
// codex/claude/gemini/opencode/pi; this allow-list drops gemini.
/** The Go-parity CLI harness names, minus gemini. Sorted for a stable error message. */
export const SUPPORTED_HARNESSES = [
    "claude",
    "codex",
    "opencode",
    "pi",
];
/**
 * Validates name against the CLI-facing allow-list. Returns the pass-through
 * Config.harness/Config.binaryPath pair on success, or an error listing the
 * supported names (mirrors Go's resolveHarness "unsupported harness" message,
 * harness_resolver.go:32-42) — but leaves the binary-path lookup itself to
 * start()'s resolvePath() call.
 */
export function assertSupportedHarness(name) {
    if (!SUPPORTED_HARNESSES.includes(name)) {
        return {
            result: null,
            err: new Error(`unsupported harness ${JSON.stringify(name)} (supported: ${SUPPORTED_HARNESSES.join(", ")})`),
        };
    }
    return { result: { harness: name, binaryPath: name }, err: null };
}
//# sourceMappingURL=harnessResolver.js.map