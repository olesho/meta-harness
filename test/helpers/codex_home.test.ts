// Unit cover for the seeded-CODEX_HOME helper. Everything here is offline: the
// real credential is never read (the two facts that need one are asserted only
// when it happens to exist, and are skipped otherwise), and no codex process is
// launched. The live probe that USES this helper lives in the corpus recordings
// under test/corpus/codex/permissions-approve-current/.

import { describe, expect, test } from "vitest";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  hasCodexAuth,
  realCodexAuthPath,
  seedIsolatedCodexHome,
} from "./codex_home.ts";

describe("realCodexAuthPath", () => {
  test("points at ~/.codex/auth.json", () => {
    expect(realCodexAuthPath()).toBe(join(homedir(), ".codex", "auth.json"));
  });
});

describe("hasCodexAuth", () => {
  test("agrees with the filesystem", () => {
    expect(hasCodexAuth()).toBe(existsSync(realCodexAuthPath()));
  });
});

describe("seedIsolatedCodexHome", () => {
  const skip = !hasCodexAuth();

  test.skipIf(skip)("seeds auth.json 0600 and NO config.toml", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-home-helper-"));
    const dir = join(root, "home");
    const seeded = seedIsolatedCodexHome(dir);
    try {
      expect(seeded).not.toBeNull();
      if (!seeded) return;

      expect(existsSync(join(dir, "auth.json"))).toBe(true);
      // The deliberate omission: a home with no config.toml renders codex's
      // DEFAULTS, which is what makes "(current)" deterministic.
      expect(existsSync(join(dir, "config.toml"))).toBe(false);
      expect(statSync(join(dir, "auth.json")).mode & 0o777).toBe(0o600);

      // CODEX_HOME overrides last-wins (envToRecord in
      // src/wrapper/internal/run.ts is last-wins), so the override must be the
      // final CODEX_HOME entry in the list.
      const homes = seeded.env.filter((e) => e.startsWith("CODEX_HOME="));
      expect(homes.at(-1)).toBe(`CODEX_HOME=${dir}`);
    } finally {
      seeded?.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(skip)(
    "cleanup removes the copied credential and is idempotent",
    () => {
      const root = mkdtempSync(join(tmpdir(), "codex-home-helper-"));
      const dir = join(root, "home");
      const seeded = seedIsolatedCodexHome(dir);
      expect(seeded).not.toBeNull();
      if (!seeded) return;
      try {
        // A codex run would leave a config.toml behind; cleanup must take the
        // whole tree, credential included, not just the files it wrote.
        writeFileSync(
          join(dir, "config.toml"),
          'approvals_reviewer = "auto_review"\n',
        );
        seeded.cleanup();
        expect(existsSync(join(dir, "auth.json"))).toBe(false);
        expect(existsSync(dir)).toBe(false);
        // Idempotent: an afterEach that also ran on the skip path must not throw.
        expect(() => {
          seeded.cleanup();
        }).not.toThrow();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test("the real credential is never mutated by seeding", () => {
    // Holds on both branches: with no credential seeding is a no-op returning
    // null, and with one the helper only ever READS the source.
    const before = hasCodexAuth()
      ? statSync(realCodexAuthPath()).mtimeMs
      : null;
    const root = mkdtempSync(join(tmpdir(), "codex-home-helper-"));
    const seeded = seedIsolatedCodexHome(join(root, "home"));
    try {
      expect(seeded === null).toBe(!hasCodexAuth());
    } finally {
      seeded?.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
    if (before !== null) {
      expect(statSync(realCodexAuthPath()).mtimeMs).toBe(before);
    }
  });
});
