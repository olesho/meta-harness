// Go-duration timeout parsing shared by BOTH CLIs (src/cli/run.ts and
// src/cli/structured-runner.ts). Lives in turnproto — the dependency-light
// shared home — so neither CLI has to import the other to agree on how
// HARNESS_WRAPPER_RUN_TIMEOUT is read or what the default deadline is.
//
// Parity note: this is a deliberate SUBSET of Go's time.ParseDuration. It
// rejects degenerate forms Go accepts (bare "0", signed durations); parity
// with the Go wrapper is scoped to valid positive durations, with invalid
// values falling through to the default on both sides.
/** Default one-shot deadline when HARNESS_WRAPPER_RUN_TIMEOUT is unset (Go: 15m). */
export const DEFAULT_RUN_TIMEOUT_MS = 15 * 60 * 1000;
/** parseTimeoutMs reads a HARNESS_WRAPPER_RUN_TIMEOUT value (Go duration) → ms. */
export function parseTimeoutMs(raw, defaultMs = DEFAULT_RUN_TIMEOUT_MS) {
    if (!raw || raw.trim() === "")
        return defaultMs;
    const ms = parseGoDuration(raw.trim());
    return ms === null || ms <= 0 ? defaultMs : ms;
}
/** parseGoDuration parses a subset of Go durations ("15m", "90s", "1h30m", "500ms"). */
export function parseGoDuration(s) {
    const re = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g;
    const units = {
        ns: 1e-6,
        us: 1e-3,
        µs: 1e-3,
        ms: 1,
        s: 1000,
        m: 60_000,
        h: 3_600_000,
    };
    let total = 0;
    let matched = false;
    let lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
        if (m.index !== lastIndex)
            return null; // gap → malformed
        total += parseFloat(m[1]) * units[m[2]];
        lastIndex = re.lastIndex;
        matched = true;
    }
    if (!matched || lastIndex !== s.length)
        return null;
    return total;
}
//# sourceMappingURL=duration.js.map