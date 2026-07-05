import { spawnSync } from "node:child_process";
import { defaultProbeTimeoutMs, registerProbe } from "./discovery.js";
/**
 * Matches the first X.Y.Z (optionally followed by -pre.release or +build
 * metadata) substring. Used by `semverDashVProbe`. The shape is reused
 * verbatim from the Go discovery package.
 */
export const semverRe = /\d+\.\d+\.\d+(?:[-+][\w.]+)?/;
/** Returns the first semver-shaped substring in `s`, or "" when none. */
export function findSemver(s) {
    return s.match(semverRe)?.[0] ?? "";
}
/**
 * Runs `<binary> --version` and extracts the first semver-shaped substring
 * from the combined output. Suitable for harnesses whose --version line
 * contains a clean X.Y.Z[-suffix] token (codex, claude-code, opencode,
 * and pi at the time of writing).
 */
export class SemverDashVProbe {
    detect(path) {
        const res = spawnSync(path, ["--version"], {
            timeout: defaultProbeTimeoutMs,
            encoding: "utf8",
        });
        if (res.error) {
            throw new Error(`${path} --version: ${res.error.message}`);
        }
        const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
        if (res.signal) {
            throw new Error(`${path} --version: signal: ${res.signal}`);
        }
        if (res.status !== 0) {
            throw new Error(`${path} --version: exit status ${res.status}`);
        }
        const m = findSemver(out);
        if (m === "") {
            throw new Error(`${path} --version: no semver in ${JSON.stringify(out.trim())}`);
        }
        return m;
    }
}
// Ship default probes for every harness whose --version line is a clean semver.
const p = new SemverDashVProbe();
registerProbe("codex", p);
registerProbe("claude-code", p);
registerProbe("opencode", p);
registerProbe("pi", p);
//# sourceMappingURL=probes.js.map