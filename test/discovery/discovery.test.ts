import { afterEach, describe, expect, test } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discover,
  lookup,
  probeFor,
  registerProbe,
  resetCache,
  _probes,
  type Probe,
} from "../../src/discovery/discovery.ts";
import { SemverDashVProbe, semverRe } from "../../src/discovery/probes.ts";
import { pinned } from "../../src/versions/versions.ts";

// Importing probes.ts above triggers the default-probe registration (init()).

// The pins these tests assert against are READ FROM THE CATALOG, not hardcoded.
// What is under test is the invariant "detected == pinned ⇒ no drift flag", not
// any particular version string — hardcoding the literals meant every routine
// version-pin bump (META-HARNESS-113 and its predecessors) had to hand-edit this
// file, and a stale literal here fails as a discovery bug rather than as drift.
const [codexPin] = pinned("codex");
const [claudePin] = pinned("claude-code");

interface NameContent {
  name: string;
  body?: string;
}

const origPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = origPath;
  resetCache();
});

/** Writes shims into a fresh temp dir and points PATH at it. Returns the dir. */
function setShimPath(...shims: NameContent[]): string {
  const dir = mkdtempSync(join(tmpdir(), "discovery-"));
  for (const s of shims) {
    const body = s.body && s.body !== "" ? s.body : "#!/bin/sh\nexit 0\n";
    const full = join(dir, s.name);
    writeFileSync(full, body);
    chmodSync(full, 0o755);
  }
  process.env.PATH = dir;
  return dir;
}

describe("discovery", () => {
  test("lookup: not installed", () => {
    process.env.PATH = mkdtempSync(join(tmpdir(), "discovery-"));
    const got = lookup("codex");
    expect(got.installed).toBe(false);
    expect(got.harness).toBe("codex");
    expect(got.binary).toBe("codex");
    expect(got.pinnedVersion).toBe(codexPin);
    expect(got.installHint).not.toBe("");
    expect(got.installHint).toContain("codex");
    expect(got.versionMatchesPin).toBe(true);
  });

  test("lookup: installed via harness key", () => {
    setShimPath({ name: "codex", body: `#!/bin/sh\necho ${codexPin}\n` });
    const got = lookup("codex");
    expect(got.installed).toBe(true);
    expect(got.harness).toBe("codex");
    expect(got.binary).toBe("codex");
    expect(got.detectedVersion).toBe(codexPin);
    expect(got.versionMatchesPin).toBe(true);
  });

  test("lookup: installed via binary name", () => {
    setShimPath({ name: "claude", body: `#!/bin/sh\necho ${claudePin}\n` });
    const got = lookup("claude");
    expect(got.installed).toBe(true);
    expect(got.harness).toBe("claude-code");
    expect(got.binary).toBe("claude");
    expect(got.detectedVersion).toBe(claudePin);
    expect(got.versionMatchesPin).toBe(true);
  });

  test("lookup: unknown name, not installed", () => {
    process.env.PATH = mkdtempSync(join(tmpdir(), "discovery-"));
    const got = lookup("xyzzy");
    expect(got.installed).toBe(false);
    expect(got.harness).toBe("");
    expect(got.pinnedVersion).toBe("");
    expect(got.npmPackage).toBe("");
    expect(got.installHint).toContain("xyzzy");
  });

  test("lookup: unknown name, installed", () => {
    setShimPath({ name: "xyzzy", body: "#!/bin/sh\necho irrelevant\n" });
    const got = lookup("xyzzy");
    expect(got.installed).toBe(true);
    expect(got.harness).toBe("");
    expect(got.detectedVersion).toBe("");
    expect(got.versionMatchesPin).toBe(true);
  });

  test("lookup: version mismatch flags drift", () => {
    setShimPath({ name: "codex", body: "#!/bin/sh\necho 9.9.9\n" });
    const got = lookup("codex");
    expect(got.detectedVersion).toBe("9.9.9");
    expect(got.pinnedVersion).toBe(codexPin);
    expect(got.versionMatchesPin).toBe(false);
  });

  test("lookup: version probe error does not flag drift", () => {
    setShimPath({ name: "codex", body: "#!/bin/sh\nexit 1\n" });
    const got = lookup("codex");
    expect(got.installed).toBe(true);
    expect(got.detectedVersion).toBe("");
    expect(got.versionProbeError).not.toBe("");
    expect(got.versionMatchesPin).toBe(true);
  });

  test("lookup: unpinned treated as compatible", () => {
    setShimPath({ name: "opencode", body: "#!/bin/sh\necho 0.1.0\n" });
    const got = lookup("opencode");
    expect(got.detectedVersion).toBe("0.1.0");
    expect(got.pinnedVersion).toBe("");
    expect(got.versionMatchesPin).toBe(true);
  });

  test("discover: returns all harnesses", () => {
    process.env.PATH = mkdtempSync(join(tmpdir(), "discovery-"));
    const all = discover();
    const want = new Map<string, boolean>([
      ["codex", false],
      ["claude-code", false],
      ["opencode", false],
      ["pi", false],
    ]);
    for (const info of all) {
      expect(want.has(info.harness)).toBe(true);
      want.set(info.harness, true);
      expect(info.installed).toBe(false);
    }
    for (const [h, seen] of want) {
      expect(seen).toBe(true);
    }
  });

  test("init ships default probes", () => {
    for (const h of ["codex", "claude-code", "opencode", "pi"]) {
      expect(probeFor(h)).toBeDefined();
    }
  });

  test("registerProbe with nil throws", () => {
    expect(() => {
      registerProbe("codex", null);
    }).toThrow();
  });

  test("resetCache is idempotent", () => {
    resetCache();
    resetCache();
  });

  test("semverRe matches various shapes", () => {
    const cases: [string, string][] = [
      ["0.140.0", "0.140.0"],
      ["codex-cli 0.140.0", "0.140.0"],
      ["Claude Code 2.1.141 (build abc)", "2.1.141"],
      ["v1.0.0-beta.3", "1.0.0-beta.3"],
      ["no version here", ""],
    ];
    for (const [input, want] of cases) {
      expect(input.match(semverRe)?.[0] ?? "").toBe(want);
    }
  });
});

// countingProbe wraps another probe and counts invocations, used to verify the
// cache short-circuits repeated detects.
class CountingProbe implements Probe {
  n = 0;
  constructor(private inner: Probe) {}
  detect(path: string): string {
    this.n += 1;
    return this.inner.detect(path);
  }
}

function swapCodexProbe(p: Probe): () => void {
  const prev = _probes.get("codex");
  _probes.set("codex", p);
  return () => {
    if (prev) _probes.set("codex", prev);
    else _probes.delete("codex");
  };
}

describe("discovery cache", () => {
  test("lookup caches by path and mtime", () => {
    const cp = new CountingProbe(new SemverDashVProbe());
    const restore = swapCodexProbe(cp);
    try {
      setShimPath({ name: "codex", body: "#!/bin/sh\necho 0.141.0\n" });
      lookup("codex");
      lookup("codex");
      expect(cp.n).toBe(1);
    } finally {
      restore();
      process.env.PATH = origPath;
      resetCache();
    }
  });

  test("lookup re-probes after resetCache", () => {
    const cp = new CountingProbe(new SemverDashVProbe());
    const restore = swapCodexProbe(cp);
    try {
      setShimPath({ name: "codex", body: "#!/bin/sh\necho 0.141.0\n" });
      lookup("codex");
      resetCache();
      lookup("codex");
      expect(cp.n).toBe(2);
    } finally {
      restore();
      process.env.PATH = origPath;
      resetCache();
    }
  });
});
