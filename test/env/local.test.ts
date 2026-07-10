// Tier-1: local-provisioner specifics not covered by the shared conformance run.

import { describe, expect, test } from "vitest"
import { mkdtempSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "../../src/async/index.ts"
import { local } from "../../src/env/index.ts"
import type { WorkspaceSpec } from "../../src/env/index.ts"

const ctx = Context.background()
function root() {
  return mkdtempSync(join(tmpdir(), "local-test-"))
}
const spec: WorkspaceSpec = { image: "img", name: "det-name" }

describe("local provisioner", () => {
  test("exec honors opts.env and opts.cwd", async () => {
    const prov = local({ root: root() })
    const ws = await prov.create(ctx, spec)
    const r = await ws.exec(ctx, ["node", "-e", "process.stdout.write(process.env.FOO + ':' + process.cwd())"], {
      env: { FOO: "bar" },
      cwd: ws.guestPath("home"),
    })
    // (realpath may resolve /var → /private/var on macOS, so match loosely).
    expect(r.stdout.startsWith("bar:")).toBe(true)
    expect(r.stdout.endsWith("/.home")).toBe(true)
    await ws.destroy(ctx, "success")
  })

  test("exec feeds opts.stdin", async () => {
    const prov = local({ root: root() })
    const ws = await prov.create(ctx, spec)
    const r = await ws.exec(
      ctx,
      ["node", "-e", "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(s.toUpperCase()))"],
      { stdin: "hello" },
    )
    expect(r.stdout).toBe("HELLO")
    await ws.destroy(ctx, "success")
  })

  test("create reaps a leftover under the same deterministic name (crash recovery)", async () => {
    const r = root()
    const prov = local({ root: r })
    const ws1 = await prov.create(ctx, spec)
    const stale = join(ws1.guestPath("repo"), "stale.txt")
    writeFileSync(stale, "leftover")
    expect(statSync(stale).isFile()).toBe(true)
    // Recreate under the same name: the leftover is gone.
    await prov.create(ctx, spec)
    expect(() => statSync(stale)).toThrow()
  })

  test("empty argv rejects", async () => {
    const prov = local({ root: root() })
    const ws = await prov.create(ctx, spec)
    await expect(ws.exec(ctx, [])).rejects.toThrow(/empty argv/)
    await ws.destroy(ctx, "success")
  })

  test("exec rejects on an already-cancelled context", async () => {
    const prov = local({ root: root() })
    const ws = await prov.create(ctx, spec)
    const { ctx: cctx, cancel } = Context.withCancel(ctx)
    cancel()
    await expect(ws.exec(cctx, ["node", "-e", "0"])).rejects.toBeDefined()
    await ws.destroy(ctx, "success")
  })
})
