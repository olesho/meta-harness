import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// META-HARNESS-98 regression guard.
//
// ORIGINALLY: the orche release gate picked its frozen-install command from
// whichever lockfile it found at the worktree root, in the order
// bun.lock -> pnpm-lock.yaml -> `npm ci`. This repo's real toolchain is pnpm,
// so a stale, unmaintained bun.lock left over from the abandoned Bun runner
// hijacked the gate: it ran `bun install --frozen-lockfile` against a lockfile
// that had drifted from package.json, exited 1, and blocked the dev -> main
// promotion — which is the very thing that would have shipped the fix, so it
// could not self-heal.
//
// SINCE THEN, orche's `frozenInstallCmd` (release.ts, commit 737ea45) resolves
// the install from the tree's DECLARED `packageManager` first, and only falls
// back to lockfile order when nothing is declared. package.json declares
// pnpm@*, so a stray root lockfile can no longer hijack the gate on its own.
//
// This guard is therefore defence-in-depth rather than the sole barrier: it
// keeps the tree honest (one maintained lockfile, no silent drift) and still
// catches the fallback path if the `packageManager` declaration is ever lost.
//
// The invariant: exactly ONE lockfile at the repo root, pnpm-lock.yaml. An
// extra root lockfile is a build-breaking condition, not a cosmetic one, so it
// fails the suite. Developer-facing note: if you run `bun install` (or
// `npm install`) locally, this test goes red until you delete the generated
// lockfile. That is the intended signal — both are also gitignored.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("release-gate lockfile toolchain", () => {
  test("pnpm-lock.yaml is present at the repo root", () => {
    expect(existsSync(join(repoRoot, "pnpm-lock.yaml"))).toBe(true);
  });

  // Mirrors frozenInstallCmd's lockfile-order fallback, so this fails for
  // precisely the condition that used to turn the gate RED — and would again
  // if the `packageManager` declaration were ever dropped.
  for (const stray of ["bun.lock", "package-lock.json"]) {
    test(`no stray ${stray} at the repo root`, () => {
      expect(existsSync(join(repoRoot, stray))).toBe(false);
    });
  }

  test("package.json declares pnpm as the package manager", () => {
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8"),
    ) as { packageManager?: string };
    expect(pkg.packageManager ?? "").toMatch(/^pnpm@/);
  });
});
