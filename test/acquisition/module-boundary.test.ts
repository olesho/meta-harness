// Module-boundary + packaging closeout for the acquisition subsystem
// (META-HARNESS-59).
//
// The decision this test freezes: the acquisition subsystem exposes NO new
// public subpath. Every primitive (StreamTap, planAcquisition, YieldControl,
// the display/filter helpers) lands under src/acquisition/internal/** and is
// consumed ONLY via relative imports inside the package (chat, oneshot, cli).
// The single genuinely-public capability vocabulary — StreamParser and
// AcquisitionMode — is surfaced through the `turns` barrel (added by the types
// subtask), not through an acquisition subpath.
//
// Consequences, each asserted below so a future regression fails loudly:
//   1. package.json `exports` has no `./acquisition` entry, and there is no
//      src/acquisition public barrel (only src/acquisition/internal/**).
//   2. Because the primitives live under `internal/`, the generic exports-guard
//      (\binternal\b) already forbids any public barrel from re-exporting them;
//      here we additionally assert no public barrel names an `acquisition/` path.
//   3. The acquisition-internal-only symbols never leak onto ANY public barrel.
//   4. StreamParser / AcquisitionMode ARE reachable via the turns barrel — the
//      one sanctioned public path.

import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const srcRoot = join(root, "src");

// The public subpath barrels named in package.json `exports`, derived at runtime
// so this stays in sync with the packaging manifest. `.` maps to index.ts.
function publicBarrelRels(): string[] {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    exports?: Record<string, string | { bun?: string }>;
  };
  const rels: string[] = [];
  for (const entry of Object.values(pkg.exports ?? {})) {
    const bun = typeof entry === "string" ? entry : entry.bun;
    if (bun?.startsWith("./src/")) rels.push(bun.slice("./src/".length));
  }
  return rels;
}

// Every symbol exported from src/acquisition/internal/** that must stay private.
const ACQUISITION_INTERNAL_ONLY = [
  // planAcquisition.ts
  "planAcquisition",
  "replanAfterStreamFailure",
  "resolveProfile",
  "probeAdapter",
  "streamEligible",
  "defaultStreamVersionPredicate",
  // streamTap.ts
  "StreamTap",
  "adapterStreamParser",
  // display.ts
  "newDisplaySink",
  "displaySinkCap",
  // filter.ts
  "admitParent",
  "isParentConversationKind",
  "EventOutputChunk",
  // yield.ts
  "YieldControl",
  "checkYield",
  "hookEnv",
  "EnvSpool",
  "EnvHome",
  "EnvHookCwd",
  "EnvYieldFile",
];

describe("acquisition is internal-only: no new public subpath", () => {
  test("package.json exports has no ./acquisition subpath", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const subpaths = Object.keys(pkg.exports ?? {});
    expect(subpaths.some((s) => s.includes("acquisition"))).toBe(false);
  });

  test("there is no src/acquisition public barrel or api.ts", () => {
    // The primitives live under src/acquisition/internal/**; a bare barrel would
    // imply a public face this subsystem deliberately does not have.
    expect(existsSync(join(srcRoot, "acquisition", "index.ts"))).toBe(false);
    expect(existsSync(join(srcRoot, "acquisition", "api.ts"))).toBe(false);
  });
});

describe("no public barrel reaches the acquisition subsystem", () => {
  const barrels = publicBarrelRels();

  test("the packaging manifest yields a non-empty barrel set", () => {
    // Guards against a silently-empty derivation making the loops below vacuous.
    expect(barrels.length).toBeGreaterThan(0);
  });

  test.each(barrels)("%s names no acquisition/ import path", (rel) => {
    const src = readFileSync(join(srcRoot, rel), "utf8");
    // acquisition internals are reached only via relative imports from inside
    // the package (chat, oneshot, cli) — never re-exported by a public barrel.
    expect(/["'][^"']*\bacquisition\b[^"']*["']/.test(src)).toBe(false);
  });

  test("acquisition-internal-only symbols leak onto no public barrel", async () => {
    for (const rel of barrels) {
      const mod = (await import(join(srcRoot, rel))) as Record<string, unknown>;
      const names = new Set(Object.keys(mod));
      for (const forbidden of ACQUISITION_INTERNAL_ONLY) {
        expect(names.has(forbidden), `${forbidden} leaked into ${rel}`).toBe(
          false,
        );
      }
    }
  });
});

describe("the turns barrel is the one sanctioned public path to the vocabulary", () => {
  test("StreamParser and AcquisitionMode are exported type-only from turns", () => {
    // Both are type-only (erased at runtime), so assert on the barrel source.
    const src = readFileSync(join(srcRoot, "turns", "index.ts"), "utf8");
    const typeBlock = /export\s+type\s*\{([\s\S]*?)\}/g;
    const typeNames = new Set<string>();
    for (const m of src.matchAll(typeBlock)) {
      for (const raw of m[1].split(",")) {
        const name = raw
          .trim()
          .split(/\s+as\s+/)[0]
          .trim();
        if (name) typeNames.add(name);
      }
    }
    expect(typeNames.has("StreamParser")).toBe(true);
    expect(typeNames.has("AcquisitionMode")).toBe(true);
  });

  test("the acquisition-mode values + describeAcquisitionMode are exported from turns", async () => {
    const turns = (await import(join(srcRoot, "turns", "index.ts"))) as Record<
      string,
      unknown
    >;
    expect(turns.AcquisitionModeOff).toBe("off");
    expect(turns.AcquisitionModeStream).toBe("stream");
    expect(turns.AcquisitionModeHooks).toBe("hooks");
    expect(typeof turns.describeAcquisitionMode).toBe("function");
  });
});
