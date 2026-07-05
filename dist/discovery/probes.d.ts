import { type Probe } from "./discovery.ts";
/**
 * Matches the first X.Y.Z (optionally followed by -pre.release or +build
 * metadata) substring. Used by `semverDashVProbe`. The shape is reused
 * verbatim from the Go discovery package.
 */
export declare const semverRe: RegExp;
/** Returns the first semver-shaped substring in `s`, or "" when none. */
export declare function findSemver(s: string): string;
/**
 * Runs `<binary> --version` and extracts the first semver-shaped substring
 * from the combined output. Suitable for harnesses whose --version line
 * contains a clean X.Y.Z[-suffix] token (codex, claude-code, opencode,
 * and pi at the time of writing).
 */
export declare class SemverDashVProbe implements Probe {
    detect(path: string): string;
}
//# sourceMappingURL=probes.d.ts.map