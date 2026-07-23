// Shared CODEX_HOME isolation helper — the seeded throwaway home every live
// codex test needs before it may touch anything that WRITES codex state.
//
// Why seeding is mandatory. `$CODEX_HOME` is not just `sessions/` and
// `config.toml`: it also holds `auth.json`, the credential file (see
// docs/design/pluggable-environments.md, which names "codex ~/.codex/auth.json"
// as THE credential, and src/env-daytona/leak-probe.ts, which lists CODEX_HOME
// in CREDENTIAL_SENSITIVE_ENV_NAMES for exactly that reason). Point CODEX_HOME
// at a bare empty directory and codex lands on the first-run sign-in wall —
// which src/turns/harness/codex.ts's signinWallRE deliberately excludes from
// DetectInput and which src/chat/ready.ts's onboardingWall holds as NOT ready.
// readyForInput() then never goes true and the test cannot run at all.
//
// Why `config.toml` is deliberately NOT copied. Without one, codex renders its
// defaults — for the /permissions dialog that means `› 1. Ask for approval
// (current)`, the exact state test/corpus/codex/permissions-dialog recorded.
// Copying the developer's real config.toml would import whatever approval
// settings they already carry (`approvals_reviewer`, a `approval_policy.granular`
// variant, …) and make which row reads "(current)" non-deterministic. It would
// also put the suite one keystroke away from writing those settings.
//
// This is the same reasoning test/conformance.test.ts's check 4 already runs
// inline (isolatedCodexHome); this module is the reusable, skip-gated form for
// tests that need the seed AND a teardown that removes the copied credential.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Absolute path of the developer's real codex credential file. */
export function realCodexAuthPath(): string {
  return join(homedir(), ".codex", "auth.json");
}

/**
 * hasCodexAuth reports whether the real `~/.codex/auth.json` exists, i.e.
 * whether an isolated home can be seeded at all. Callers gate on this the same
 * way test/conformance.test.ts gates on `info.installed` — a missing credential
 * is a SKIP, not a failure: CI has no logged-in codex and must stay green.
 */
export function hasCodexAuth(): boolean {
  return existsSync(realCodexAuthPath());
}

/** What seedIsolatedCodexHome hands back to the caller. */
export interface IsolatedCodexHome {
  /** The isolated home; pass as `CODEX_HOME=<dir>`. */
  dir: string;
  /** `process.env` flattened to `KEY=value`, with `CODEX_HOME` overridden. */
  env: string[];
  /**
   * Deletes the isolated home INCLUDING the copied credential. Idempotent —
   * safe to call from an `afterEach` that also ran on the skip path.
   */
  cleanup: () => void;
}

/**
 * seedIsolatedCodexHome creates `dir`, copies the real `~/.codex/auth.json`
 * into it with mode 0600, and copies NO `config.toml`.
 *
 * Returns `null` when the real credential is absent, so the caller can skip
 * rather than fail (mirroring the binary gate in test/conformance.test.ts).
 * Check {@link hasCodexAuth} first when the skip decision must be made before
 * any directory is created.
 *
 * The copy is a real credential on disk. Always run {@link IsolatedCodexHome.cleanup}
 * in a `finally`/`afterEach`, even on the failure path.
 */
export function seedIsolatedCodexHome(dir: string): IsolatedCodexHome | null {
  const auth = realCodexAuthPath();
  if (!existsSync(auth)) return null;

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = join(dir, "auth.json");
  copyFileSync(auth, dest);
  // copyFileSync does not carry the source mode across; the credential is
  // chmod'd explicitly so the copy is never wider than the original.
  chmodSync(dest, 0o600);

  return {
    dir,
    env: [
      ...Object.entries(process.env).map(([k, v]) => `${k}=${v ?? ""}`),
      `CODEX_HOME=${dir}`,
    ],
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
