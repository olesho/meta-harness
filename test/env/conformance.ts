// Tier-2 conformance suite (design §10): one shared spec every Provisioner ×
// Containment pairing must pass, parameterized over implementations. This is
// what makes "swap X for Y" safe. Runs against local + none here; against
// backend fakes / live backends in later phases.

import { describe, expect, test } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "../../src/async/index.ts";
import { compose, env } from "../../src/env/index.ts";
import type {
  Containment,
  Provisioner,
  Workspace,
  WorkspaceSpec,
} from "../../src/env/index.ts";
import { RecordingRedactor, ScriptedInjector } from "./fakes.ts";

export interface ConformanceTarget {
  name: string;
  /** A fresh provisioner per call (hermetic root). */
  makeProvisioner(): Provisioner;
  makeContainment(): Containment;
  /** Overlaid onto every spec built by this suite (e.g. Daytona labels/auto-*
   *  billing backstops). */
  specDefaults?: Partial<WorkspaceSpec>;
  /** Aliveness probe for the retention/unwind tests, given the acquired
   *  Workspace. Defaults to a host-side statSync on guestPath("repo") — valid
   *  only for local-filesystem-backed provisioners (local, none-over-local). */
  probeAlive?(ws: Workspace): Promise<boolean>;
  /** Per-test timeout override (ms). Defaults to vitest's own default. */
  timeoutMs?: number;
  /** Strip backend-inherent stderr noise before fidelity assertions (e.g. the
   *  openshell guest image's node emits an UNDICI proxy warning on every run).
   *  Identity when omitted — local+none stays strict. */
  filterStderr?(stderr: string): string;
}

let seq = 0;
function specFor(
  t: ConformanceTarget,
  retention?: WorkspaceSpec["retention"],
): WorkspaceSpec {
  return {
    image: "test-image",
    name: `conf-${++seq}`,
    retention,
    ...t.specDefaults,
  };
}

async function defaultProbeAlive(ws: Workspace): Promise<boolean> {
  const { statSync } = await import("node:fs");
  try {
    return statSync(ws.guestPath("repo")).isDirectory();
  } catch {
    return false;
  }
}

function probeFor(t: ConformanceTarget): (ws: Workspace) => Promise<boolean> {
  return t.probeAlive ?? defaultProbeAlive;
}

const ctx = Context.background();

/** Acquire a composed Workspace directly (no injectors) for behavioral checks. */
async function acquire(
  t: ConformanceTarget,
  spec: WorkspaceSpec,
): Promise<Workspace> {
  const prov = t.makeProvisioner();
  const contain = t.makeContainment();
  await prov.preflight(ctx);
  const inner = await prov.create(ctx, spec);
  await contain.preflight(ctx, inner);
  // Mirror env() step 4: a containment with an acquire hook creates its
  // resources here and hands back a layer closed over them.
  const layer = contain.acquire
    ? await contain.acquire(ctx, inner, {})
    : contain.layer({});
  return compose(inner, layer);
}

export function runConformance(t: ConformanceTarget): void {
  const tm = t.timeoutMs;
  describe(`conformance: ${t.name}`, () => {
    test(
      "exec: exit code, stdout and stderr fidelity",
      async () => {
        const clean = t.filterStderr ?? ((s: string) => s);
        const ws = await acquire(t, specFor(t));
        const ok = await ws.exec(ctx, [
          "node",
          "-e",
          "process.stdout.write('hi')",
        ]);
        expect({ ...ok, stderr: clean(ok.stderr) }).toEqual({
          code: 0,
          stdout: "hi",
          stderr: "",
        });

        const err = await ws.exec(ctx, [
          "node",
          "-e",
          "process.stderr.write('boom'); process.exit(3)",
        ]);
        expect(err.code).toBe(3);
        expect(clean(err.stderr)).toBe("boom");
        await ws.destroy(ctx, "success");
      },
      tm,
    );

    test(
      "exec: argv is not shell-interpreted (injection-safe)",
      async () => {
        const ws = await acquire(t, specFor(t));
        // A metacharacter-laden single arg must reach the program verbatim, not
        // spawn a subshell.
        const r = await ws.exec(ctx, [
          "node",
          "-e",
          "process.stdout.write(process.argv[1])",
          "; rm -rf /",
        ]);
        expect(r.stdout).toBe("; rm -rf /");
        await ws.destroy(ctx, "success");
      },
      tm,
    );

    test(
      "upload/download: binary-safe round-trip with .git dir and exec bits",
      async () => {
        const ws = await acquire(t, specFor(t));
        const host = mkdtempSync(join(tmpdir(), "conf-host-"));
        // A tree with binary content, a .git subdir, and an executable script.
        const srcDir = join(host, "src");
        mkdirSync(join(srcDir, ".git"), { recursive: true });
        const binary = Buffer.from([0, 1, 2, 255, 254, 10, 0]);
        writeFileSync(join(srcDir, "data.bin"), binary);
        writeFileSync(join(srcDir, ".git", "HEAD"), "ref: refs/heads/main\n");
        const script = join(srcDir, "run.sh");
        writeFileSync(script, "#!/bin/sh\necho hi\n");
        chmodSync(script, 0o755);

        const guest = ws.guestPath("repo") + "/tree";
        await ws.upload(ctx, srcDir, guest);

        const back = join(host, "back");
        await ws.download(ctx, guest, back);

        expect(readFileSync(join(back, "data.bin"))).toEqual(binary);
        expect(readFileSync(join(back, ".git", "HEAD"), "utf8")).toBe(
          "ref: refs/heads/main\n",
        );
        // Executable bit survived the round-trip.
        expect(statSync(join(back, "run.sh")).mode & 0o111).not.toBe(0);
        await ws.destroy(ctx, "success");
      },
      tm,
    );

    test(
      "guestPath: repo/home/tmp are distinct absolute paths",
      async () => {
        const ws = await acquire(t, specFor(t));
        const repo = ws.guestPath("repo");
        const home = ws.guestPath("home");
        const tmp = ws.guestPath("tmp");
        expect(new Set([repo, home, tmp]).size).toBe(3);
        for (const p of [repo, home, tmp]) expect(p.startsWith("/")).toBe(true);
        await ws.destroy(ctx, "success");
      },
      tm,
    );

    test(
      "destroy: idempotent (double-destroy is a no-op)",
      async () => {
        const ws = await acquire(t, specFor(t));
        await ws.destroy(ctx, "success");
        await expect(ws.destroy(ctx, "success")).resolves.toBeUndefined();
      },
      tm,
    );

    test(
      "retention: absent ⇒ destroyed on success AND failure",
      async () => {
        const probe = probeFor(t);
        for (const outcome of ["success", "failure"] as const) {
          const spec = specFor(t, undefined);
          const prov = t.makeProvisioner();
          const inner = await prov.create(ctx, spec);
          expect(await probe(inner)).toBe(true);
          await inner.destroy(ctx, outcome);
          expect(await probe(inner)).toBe(false); // gone
        }
      },
      tm,
    );

    test(
      "retention: keep-on-failure keeps a failed run, destroys a clean one",
      async () => {
        const probe = probeFor(t);
        // failed run → kept
        {
          const prov = t.makeProvisioner();
          const inner = await prov.create(ctx, specFor(t, "keep-on-failure"));
          await inner.destroy(ctx, "failure");
          expect(await probe(inner)).toBe(true);
        }
        // clean run → destroyed
        {
          const prov = t.makeProvisioner();
          const inner = await prov.create(ctx, specFor(t, "keep-on-failure"));
          await inner.destroy(ctx, "success");
          expect(await probe(inner)).toBe(false);
        }
      },
      tm,
    );

    test(
      "retention: keep-on-failure does NOT keep on setup-failure (always destroys)",
      async () => {
        const probe = probeFor(t);
        const prov = t.makeProvisioner();
        const inner = await prov.create(ctx, specFor(t, "keep-on-failure"));
        await inner.destroy(ctx, "setup-failure");
        expect(await probe(inner)).toBe(false);
      },
      tm,
    );

    // Regression (META-HARNESS-45): destroy() must set `destroyed = true`
    // unconditionally on its FIRST call, not only on the deletion path — else a
    // first destroy() that hits the "keep" branch leaves the flag unflipped, and
    // a later destroy() with a DIFFERENT outcome (e.g. a caller retry defaulting
    // to "success") can still delete a sandbox meant to be kept. Destroying twice
    // with the SAME outcome (the existing idempotency test above) would not catch
    // this ordering bug.
    test(
      "retention: keep-then-retry-with-different-outcome still keeps (destroy-flag ordering)",
      async () => {
        const probe = probeFor(t);
        const prov = t.makeProvisioner();
        const inner = await prov.create(ctx, specFor(t, "keep-on-failure"));
        await inner.destroy(ctx, "failure"); // kept
        expect(await probe(inner)).toBe(true);
        await inner.destroy(ctx, "success"); // retry with a different outcome
        expect(await probe(inner)).toBe(true); // must STILL be kept
      },
      tm,
    );

    // The setup-failure unwind matrix, driven through the real env() engine with
    // a scripted injector failing at apply.
    describe("setup-failure unwind matrix", () => {
      test(
        "injector apply failure: reverse cleanup, redactions active, resource destroyed",
        async () => {
          const probe = probeFor(t);
          const redactor = new RecordingRedactor();
          const log: string[] = [];
          const prov = t.makeProvisioner();
          const spec = specFor(t, "keep-on-failure"); // even keep-on-failure must destroy on setup failure
          // Capture the created inner so we can assert it was cleaned up.
          let created: Workspace | undefined;
          const wrapped: Provisioner = {
            name: prov.name.bind(prov),
            preflight: prov.preflight.bind(prov),
            async create(c, s) {
              const w = await prov.create(c, s);
              created = w;
              return w;
            },
          };
          const bad = new ScriptedInjector({
            id: "bad",
            secrets: ["SECRET"],
            failApply: true,
            log,
            redactor,
          });
          await expect(
            env(ctx, {
              provision: wrapped,
              contain: t.makeContainment(),
              spec,
              injectors: [bad],
              redactor,
            }),
          ).rejects.toThrow(/apply failed: bad/);

          expect(redactor.registered).toContain("SECRET"); // registered before apply, still active
          expect(log).toContain("cleanup:bad"); // half-failed apply still cleaned up
          expect(await probe(created!)).toBe(false); // setup failure destroyed the resource
        },
        tm,
      );

      test(
        "containment preflight failure: resource destroyed, error surfaced",
        async () => {
          const probe = probeFor(t);
          const prov = t.makeProvisioner();
          let created: Workspace | undefined;
          const wrapped: Provisioner = {
            name: prov.name.bind(prov),
            preflight: prov.preflight.bind(prov),
            async create(c, s) {
              const w = await prov.create(c, s);
              created = w;
              return w;
            },
          };
          const base = t.makeContainment();
          const failing: Containment = {
            name: base.name.bind(base),
            async preflight() {
              throw new Error("preflight rejected");
            },
            layer: base.layer.bind(base),
          };
          await expect(
            env(ctx, {
              provision: wrapped,
              contain: failing,
              spec: specFor(t),
            }),
          ).rejects.toThrow(/preflight rejected/);
          expect(await probe(created!)).toBe(false);
        },
        tm,
      );
    });
  });
}
