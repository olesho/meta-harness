// Tier-4 live e2e (docs/env/README.md §Testing Tiers): the REAL production path
// compose(local, openshell) against a live OpenShell gateway, at exec/file-
// conformance depth. Opt-in and backend-name-valued per
// docs/design/pluggable-environments.md §10:
//
//   META_HARNESS_ENV_LIVE=openshell npx vitest run test/env/openshell-live.test.ts
//
// Skips cleanly when the variable is unset/different or the gateway is not
// Connected. Creates real sandboxes named openshell-mh-live-*; an afterAll net
// sweeps any leak.

import { afterAll, describe, expect, test, vi } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "../../src/async/index.ts"
import { compose, local } from "../../src/env/index.ts"
import type { Workspace } from "../../src/env/index.ts"
import { openshell, sandboxName } from "../../src/env-openshell/index.ts"
import { runConformance } from "./conformance.ts"

// Live sandbox create/exec goes through the gateway — well past the default
// test timeout.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 })

/** Same ANSI-SGR strip discipline as openshell preflight (module-private there). */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "")
}

function osCli(argv: string[]): { code: number; stdout: string; stderr: string } {
  const p = spawnSync("openshell", argv, { encoding: "utf-8" })
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" }
}

// Gate: backend-name-valued (design §10: `META_HARNESS_ENV_LIVE=openshell` + a
// Connected gateway) — NOT the boolean "1" convention of LIVE_CLAUDE/LIVE_MODELS.
const live = process.env.META_HARNESS_ENV_LIVE === "openshell"
let connected = false
if (live) {
  const st = osCli(["status"])
  connected = st.code === 0 && /\bconnected\b/i.test(stripAnsi(st.stdout))
  if (!connected) {
    console.warn(
      "openshell-live: META_HARNESS_ENV_LIVE=openshell but gateway is not Connected — skipping",
    )
  }
}
const enabled = live && connected

const ctx = Context.background()
let n = 0

/** Live sandbox visible in `openshell sandbox list`? Parsed defensively:
 *  ANSI-stripped substring match, same discipline as preflight's status parse. */
function sandboxListed(name: string): boolean {
  const ls = osCli(["sandbox", "list"])
  return ls.code === 0 && stripAnsi(ls.stdout).includes(name)
}

describe.skipIf(!enabled)("openshell live (Tier-4)", () => {
  // Part A: the full Tier-2 conformance suite over the REAL lifecycle —
  // conformance's acquire() prefers Containment.acquire, so every test below
  // exercises real create/mkdir/exec/upload/download/delete via the gateway.
  runConformance({
    name: "local + openshell (live)",
    makeProvisioner: () => local({ root: mkdtempSync(join(tmpdir(), "os-live-")) }),
    // No `from`: the gateway's default image ships node (v22 at time of
    // writing) and a writable /sandbox — a bare `--from node:22-slim` dies at
    // provisioning because that image's entrypoint (node REPL) exits at once.
    makeContainment: () => openshell({ agentId: `mh-live-${++n}` }),
  })

  // Part B: openshell-specific lifecycle assertions.
  async function acquireLive(agentId: string): Promise<{ ws: Workspace; name: string }> {
    const prov = local({ root: mkdtempSync(join(tmpdir(), "os-live-b-")) })
    const contain = openshell({ agentId })
    const inner = await prov.create(ctx, { image: "img", name: `b-${agentId}` })
    const layer = await contain.acquire!(ctx, inner, {})
    return { ws: compose(inner, layer), name: sandboxName(agentId) }
  }

  test("acquire creates a listed sandbox; destroy removes it; second destroy resolves", async () => {
    const { ws, name } = await acquireLive(`mh-live-${++n}`)
    try {
      expect(sandboxListed(name)).toBe(true)
    } finally {
      await ws.destroy(ctx, "success")
    }
    expect(sandboxListed(name)).toBe(false)
    await expect(ws.destroy(ctx, "success")).resolves.toBeUndefined()
  })

  test("env crossing: printenv sees the crossed value, cwd is the guest repo", async () => {
    const { ws } = await acquireLive(`mh-live-${++n}`)
    try {
      const r = await ws.exec(ctx, ["printenv", "FOO"], { env: { FOO: "bar baz" } })
      expect(r.code).toBe(0)
      expect(r.stdout.trim()).toBe("bar baz")

      const pwd = await ws.exec(ctx, ["pwd"])
      expect(pwd.code).toBe(0)
      expect(pwd.stdout.trim()).toBe("/sandbox/repo")
    } finally {
      await ws.destroy(ctx, "success")
    }
  })

  test("raw CLI second delete of an already-gone sandbox (documents why teardown short-circuits)", async () => {
    const { ws, name } = await acquireLive(`mh-live-${++n}`)
    await ws.destroy(ctx, "success") // first (real) delete, via the layer
    // Bypass the layer's closure-state short-circuit: ask the CLI directly.
    const second = osCli(["sandbox", "delete", name])
    // Whatever the CLI does here is tolerated by acquire's best-effort deletes;
    // it must at least complete. Log the empirical behavior for the teardown()
    // comment's sake.
    expect(typeof second.code).toBe("number")
    console.warn(
      `openshell-live: redundant delete of ${name} exited ${second.code}: ` +
        stripAnsi(second.stderr || second.stdout).trim().slice(0, 200),
    )
  })

  afterAll(() => {
    // Leak-hygiene net: sweep anything this suite (or a crashed prior run) left.
    const ls = osCli(["sandbox", "list"])
    if (ls.code !== 0) return
    const leaked = stripAnsi(ls.stdout).match(/openshell-mh-live-[a-z0-9-]*/g) ?? []
    for (const name of new Set(leaked)) {
      console.warn(`openshell-live: sweeping leaked sandbox ${name}`)
      osCli(["sandbox", "delete", name])
    }
  })
})

// Keep the file non-empty for the default (skipped) run so vitest reports it.
test("openshell-live: Tier-4 checks are opt-in (META_HARNESS_ENV_LIVE=openshell)", () => {
  expect(true).toBe(true)
})
