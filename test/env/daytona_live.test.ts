// Live e2e test for the Daytona provisioner (Tier-4, design doc's Tier-4 bullet
// at docs/design/pluggable-environments.md:329 — LIFECYCLE + CONFORMANCE
// subset only; the "fakeharness turn" variant is deliberately deferred to a
// follow-up ticket, per the user-agreed scope in META-HARNESS-45).
//
// Opt-in, skipped by default:
//
//   META_HARNESS_ENV_LIVE=daytona npx vitest run test/env/daytona_live.test.ts
//
// Requires DAYTONA_API_KEY, either in the real process env or in a
// gitignored repo-root .env file (parsed below — no dotenv dependency).
//
// Cost note: the full conformance suite creates a FRESH sandbox per test
// (~12 sandboxes/run) rather than reusing one, because several tests assert
// destroy/retention behavior that would be invalidated by sharing a sandbox
// across tests. Billing is bounded by: (1) short autoStopInterval/
// autoDeleteInterval vendor-side backstops on every spec created here, (2) the
// afterAll sweep reaping everything labeled with this run's RUN_ID (including
// the sandbox a keep-on-failure test deliberately leaves alive), and (3) the
// sweep dryRun/live pair proving the reaper itself works end-to-end.

import { afterAll, describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Context } from "../../src/async/index.ts";
import { none } from "../../src/env/index.ts";
import { sweep as daytonaSweep } from "../../src/env-daytona/sweep.ts";
import { daytona as daytonaProvisioner } from "../../src/env-daytona/daytona.ts";
import { runConformance } from "./conformance.ts";

// --- 6-line .env parser: no dotenv dependency, doesn't override real env. ---
function loadDotEnv(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
loadDotEnv(join(repoRoot, ".env"));

const live =
  process.env.META_HARNESS_ENV_LIVE === "daytona" &&
  !!process.env.DAYTONA_API_KEY;
const RUN_ID = `live-${process.pid}-${Math.random().toString(16).slice(2)}`;
const ctx = Context.background();

describe.skipIf(!live)("Daytona provisioner (live)", () => {
  const config = { apiKey: process.env.DAYTONA_API_KEY };

  runConformance({
    name: "daytona (live) + none",
    makeProvisioner: () => daytonaProvisioner(config),
    makeContainment: () => none(),
    specDefaults: {
      labels: { "meta-harness-test": "1", "meta-harness-run": RUN_ID },
      autoStopInterval: 5,
      autoDeleteInterval: 30,
    },
    probeAlive: async (ws) => {
      try {
        const r = await ws.exec(ctx, ["true"]);
        return r.code === 0;
      } catch {
        return false;
      }
    },
    timeoutMs: 180_000,
  });

  test("sweep(): a labeled-but-not-destroyed sandbox is reaped and probes dead afterward", async () => {
    const prov = daytonaProvisioner(config);
    await prov.preflight(ctx);
    const ws = await prov.create(ctx, {
      image: "ubuntu:22.04",
      name: `sweep-${RUN_ID}`,
      labels: {
        "meta-harness-test": "1",
        "meta-harness-run": RUN_ID,
        "meta-harness-sweep-target": "1",
      },
      autoStopInterval: 5,
      autoDeleteInterval: 30,
    });
    // Deliberately do NOT call ws.destroy() — sweep() is the thing under test.
    const before = await ws.exec(ctx, ["true"]);
    expect(before.code).toBe(0);

    const result = await daytonaSweep(ctx, config, {
      labels: { "meta-harness-run": RUN_ID, "meta-harness-sweep-target": "1" },
    });
    expect(result.swept.length).toBe(1);
    expect(result.failed).toEqual([]);

    await expect(ws.exec(ctx, ["true"])).rejects.toThrow();
  }, 180_000);

  test("sweep(): dryRun reports the match without deleting", async () => {
    const prov = daytonaProvisioner(config);
    await prov.preflight(ctx);
    const ws = await prov.create(ctx, {
      image: "ubuntu:22.04",
      name: `sweep-dry-${RUN_ID}`,
      labels: {
        "meta-harness-test": "1",
        "meta-harness-run": RUN_ID,
        "meta-harness-sweep-dry": "1",
      },
      autoStopInterval: 5,
      autoDeleteInterval: 30,
    });
    try {
      const dry = await daytonaSweep(ctx, config, {
        labels: { "meta-harness-run": RUN_ID, "meta-harness-sweep-dry": "1" },
        dryRun: true,
      });
      expect(dry.kept.length).toBe(1);
      expect(dry.swept).toEqual([]);
      const r = await ws.exec(ctx, ["true"]);
      expect(r.code).toBe(0); // still alive: dryRun deleted nothing
    } finally {
      await ws.destroy(ctx, "success");
    }
  }, 180_000);
});

afterAll(async () => {
  if (!live) return;
  // Reap everything this run created, INCLUDING the sandbox the
  // keep-on-failure conformance test deliberately leaves alive.
  await daytonaSweep(
    ctx,
    { apiKey: process.env.DAYTONA_API_KEY },
    {
      labels: { "meta-harness-run": RUN_ID },
    },
  );
}, 300_000);
