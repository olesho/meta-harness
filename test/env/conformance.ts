// Tier-2 conformance suite (design §10): one shared spec every Provisioner ×
// Containment pairing must pass, parameterized over implementations. This is
// what makes "swap X for Y" safe. Runs against local + none here; against
// backend fakes / live backends in later phases.

import { describe, expect, test } from "vitest"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "../../src/async/index.ts"
import { compose, env } from "../../src/env/index.ts"
import type {
  Containment,
  Provisioner,
  Workspace,
  WorkspaceSpec,
} from "../../src/env/index.ts"
import { RecordingRedactor, ScriptedInjector } from "./fakes.ts"

export interface ConformanceTarget {
  name: string
  /** A fresh provisioner per call (hermetic root). */
  makeProvisioner(): Provisioner
  makeContainment(): Containment
  /** Strip backend-inherent stderr noise before fidelity assertions (e.g. the
   *  openshell guest image's node emits an UNDICI proxy warning on every run).
   *  Identity when omitted — local+none stays strict. */
  filterStderr?(stderr: string): string
}

let seq = 0
function specFor(retention?: WorkspaceSpec["retention"]): WorkspaceSpec {
  return { image: "test-image", name: `conf-${++seq}`, retention }
}

const ctx = Context.background()

/** Acquire a composed Workspace directly (no injectors) for behavioral checks. */
async function acquire(t: ConformanceTarget, spec: WorkspaceSpec): Promise<Workspace> {
  const prov = t.makeProvisioner()
  const contain = t.makeContainment()
  await prov.preflight(ctx)
  const inner = await prov.create(ctx, spec)
  await contain.preflight(ctx, inner)
  // Mirror env() step 4: a containment with an acquire hook creates its
  // resources here and hands back a layer closed over them.
  const layer = contain.acquire ? await contain.acquire(ctx, inner, {}) : contain.layer({})
  return compose(inner, layer)
}

export function runConformance(t: ConformanceTarget): void {
  describe(`conformance: ${t.name}`, () => {
    test("exec: exit code, stdout and stderr fidelity", async () => {
      const clean = t.filterStderr ?? ((s: string) => s)
      const ws = await acquire(t, specFor())
      const ok = await ws.exec(ctx, ["node", "-e", "process.stdout.write('hi')"])
      expect({ ...ok, stderr: clean(ok.stderr) }).toEqual({ code: 0, stdout: "hi", stderr: "" })

      const err = await ws.exec(ctx, [
        "node",
        "-e",
        "process.stderr.write('boom'); process.exit(3)",
      ])
      expect(err.code).toBe(3)
      expect(clean(err.stderr)).toBe("boom")
      await ws.destroy(ctx, "success")
    })

    test("exec: argv is not shell-interpreted (injection-safe)", async () => {
      const ws = await acquire(t, specFor())
      // A metacharacter-laden single arg must reach the program verbatim, not
      // spawn a subshell.
      const r = await ws.exec(ctx, ["node", "-e", "process.stdout.write(process.argv[1])", "; rm -rf /"])
      expect(r.stdout).toBe("; rm -rf /")
      await ws.destroy(ctx, "success")
    })

    test("upload/download: binary-safe round-trip with .git dir and exec bits", async () => {
      const ws = await acquire(t, specFor())
      const host = mkdtempSync(join(tmpdir(), "conf-host-"))
      // A tree with binary content, a .git subdir, and an executable script.
      const srcDir = join(host, "src")
      mkdirSync(join(srcDir, ".git"), { recursive: true })
      const binary = Buffer.from([0, 1, 2, 255, 254, 10, 0])
      writeFileSync(join(srcDir, "data.bin"), binary)
      writeFileSync(join(srcDir, ".git", "HEAD"), "ref: refs/heads/main\n")
      const script = join(srcDir, "run.sh")
      writeFileSync(script, "#!/bin/sh\necho hi\n")
      chmodSync(script, 0o755)

      const guest = ws.guestPath("repo") + "/tree"
      await ws.upload(ctx, srcDir, guest)

      const back = join(host, "back")
      await ws.download(ctx, guest, back)

      expect(readFileSync(join(back, "data.bin"))).toEqual(binary)
      expect(readFileSync(join(back, ".git", "HEAD"), "utf8")).toBe("ref: refs/heads/main\n")
      // Executable bit survived the round-trip.
      expect(statSync(join(back, "run.sh")).mode & 0o111).not.toBe(0)
      await ws.destroy(ctx, "success")
    })

    test("guestPath: repo/home/tmp are distinct absolute paths", async () => {
      const ws = await acquire(t, specFor())
      const repo = ws.guestPath("repo")
      const home = ws.guestPath("home")
      const tmp = ws.guestPath("tmp")
      expect(new Set([repo, home, tmp]).size).toBe(3)
      for (const p of [repo, home, tmp]) expect(p.startsWith("/")).toBe(true)
      await ws.destroy(ctx, "success")
    })

    test("destroy: idempotent (double-destroy is a no-op)", async () => {
      const ws = await acquire(t, specFor())
      await ws.destroy(ctx, "success")
      await expect(ws.destroy(ctx, "success")).resolves.toBeUndefined()
    })

    test("retention: absent ⇒ destroyed on success AND failure", async () => {
      for (const outcome of ["success", "failure"] as const) {
        const spec = specFor(undefined)
        const prov = t.makeProvisioner()
        const inner = await prov.create(ctx, spec)
        const repo = inner.guestPath("repo")
        expect(statSync(repo).isDirectory()).toBe(true)
        await inner.destroy(ctx, outcome)
        expect(() => statSync(repo)).toThrow() // gone
      }
    })

    test("retention: keep-on-failure keeps a failed run, destroys a clean one", async () => {
      // failed run → kept
      {
        const prov = t.makeProvisioner()
        const inner = await prov.create(ctx, specFor("keep-on-failure"))
        const repo = inner.guestPath("repo")
        await inner.destroy(ctx, "failure")
        expect(statSync(repo).isDirectory()).toBe(true)
      }
      // clean run → destroyed
      {
        const prov = t.makeProvisioner()
        const inner = await prov.create(ctx, specFor("keep-on-failure"))
        const repo = inner.guestPath("repo")
        await inner.destroy(ctx, "success")
        expect(() => statSync(repo)).toThrow()
      }
    })

    test("retention: keep-on-failure does NOT keep on setup-failure (always destroys)", async () => {
      const prov = t.makeProvisioner()
      const inner = await prov.create(ctx, specFor("keep-on-failure"))
      const repo = inner.guestPath("repo")
      await inner.destroy(ctx, "setup-failure")
      expect(() => statSync(repo)).toThrow()
    })

    // The setup-failure unwind matrix, driven through the real env() engine with
    // a scripted injector failing at apply.
    describe("setup-failure unwind matrix", () => {
      test("injector apply failure: reverse cleanup, redactions active, resource destroyed", async () => {
        const redactor = new RecordingRedactor()
        const log: string[] = []
        const prov = t.makeProvisioner()
        const spec = specFor("keep-on-failure") // even keep-on-failure must destroy on setup failure
        // Capture the created inner so we can assert it was cleaned up.
        let repoPath = ""
        const wrapped: Provisioner = {
          name: prov.name.bind(prov),
          preflight: prov.preflight.bind(prov),
          async create(c, s) {
            const w = await prov.create(c, s)
            repoPath = w.guestPath("repo")
            return w
          },
        }
        const bad = new ScriptedInjector({ id: "bad", secrets: ["SECRET"], failApply: true, log, redactor })
        await expect(
          env(ctx, {
            provision: wrapped,
            contain: t.makeContainment(),
            spec,
            injectors: [bad],
            redactor,
          }),
        ).rejects.toThrow(/apply failed: bad/)

        expect(redactor.registered).toContain("SECRET") // registered before apply, still active
        expect(log).toContain("cleanup:bad") // half-failed apply still cleaned up
        expect(() => statSync(repoPath)).toThrow() // setup failure destroyed the resource
      })

      test("containment preflight failure: resource destroyed, error surfaced", async () => {
        const prov = t.makeProvisioner()
        let repoPath = ""
        const wrapped: Provisioner = {
          name: prov.name.bind(prov),
          preflight: prov.preflight.bind(prov),
          async create(c, s) {
            const w = await prov.create(c, s)
            repoPath = w.guestPath("repo")
            return w
          },
        }
        const base = t.makeContainment()
        const failing: Containment = {
          name: base.name.bind(base),
          async preflight() {
            throw new Error("preflight rejected")
          },
          layer: base.layer.bind(base),
        }
        await expect(
          env(ctx, { provision: wrapped, contain: failing, spec: specFor() }),
        ).rejects.toThrow(/preflight rejected/)
        expect(() => statSync(repoPath)).toThrow()
      })
    })
  })
}
