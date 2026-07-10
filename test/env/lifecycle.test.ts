// Tier-1: the env() lifecycle engine — acquisition order, retention default, and
// the setup-failure unwind matrix (§4). Uses controllable fakes so a failure can
// be injected at each acquisition stage.

import { describe, expect, test } from "vitest"
import { Context } from "../../src/async/index.ts"
import { env } from "../../src/env/index.ts"
import type {
  Containment,
  ContainmentLayer,
  PolicySpec,
  Provisioner,
  Workspace,
  WorkspaceSpec,
} from "../../src/env/index.ts"
import { none } from "../../src/env/index.ts"
import { FakeWorkspace, RecordingRedactor, ScriptedInjector } from "./fakes.ts"

const ctx = Context.background()
const spec: WorkspaceSpec = { image: "img", name: "run-1" }

function fakeProvisioner(opts: {
  log?: string[]
  ws?: FakeWorkspace
  failPreflight?: boolean
  failCreate?: boolean
}): Provisioner {
  return {
    name: () => "fake",
    async preflight() {
      opts.log?.push("provisioner.preflight")
      if (opts.failPreflight) throw new Error("preflight boom")
    },
    async create(): Promise<Workspace> {
      opts.log?.push("provisioner.create")
      if (opts.failCreate) throw new Error("create boom")
      return opts.ws ?? new FakeWorkspace({ log: opts.log, id: "inner" })
    },
  }
}

function fakeContainment(opts: { log?: string[]; failPreflight?: boolean }): Containment {
  const layer: ContainmentLayer = none().layer({} as PolicySpec)
  return {
    name: () => "fake-contain",
    async preflight() {
      opts.log?.push("containment.preflight")
      if (opts.failPreflight) throw new Error("containment preflight boom")
    },
    layer: () => layer,
  }
}

describe("env() — happy path ordering", () => {
  test("acquires in canonical order and registers redactions before apply", async () => {
    const log: string[] = []
    const redactor = new RecordingRedactor()
    const inj = new ScriptedInjector({ id: "cred", secrets: ["s3cr3t"], log, redactor })
    const e = await env(ctx, {
      provision: fakeProvisioner({ log }),
      contain: fakeContainment({ log }),
      spec,
      injectors: [inj],
      redactor,
    })
    expect(log).toEqual([
      "provisioner.preflight",
      "provisioner.create",
      "containment.preflight",
      "apply:cred",
    ])
    // Redaction was registered BEFORE apply ran.
    expect(inj.applyCalledAfterRedactions).toEqual(["s3cr3t"])
    expect(inj.applied).toBe(true)
    expect(e.workspace).toBeDefined()
  })

  test("destroy unwinds in reverse: injector cleanup then workspace destroy", async () => {
    const log: string[] = []
    const inner = new FakeWorkspace({ log, id: "inner" })
    const a = new ScriptedInjector({ id: "a", log })
    const b = new ScriptedInjector({ id: "b", log })
    const e = await env(ctx, {
      provision: fakeProvisioner({ log, ws: inner }),
      contain: fakeContainment({ log }),
      spec,
      injectors: [a, b],
    })
    log.length = 0
    await e.destroy(ctx, "success")
    // Reverse acquisition: last injector (b) cleans up first, then a, then inner.
    expect(log).toEqual(["cleanup:b", "cleanup:a", "destroy:inner"])
    expect(inner.lastOutcome).toBe("success")
  })
})

describe("env() — setup-failure unwind matrix (§4)", () => {
  test("create failure: nothing acquired, nothing destroyed", async () => {
    const log: string[] = []
    await expect(
      env(ctx, {
        provision: fakeProvisioner({ log, failCreate: true }),
        contain: fakeContainment({ log }),
        spec,
      }),
    ).rejects.toThrow(/create boom/)
    expect(log).toEqual(["provisioner.preflight", "provisioner.create"])
  })

  test("containment preflight failure: inner destroyed as setup-failure", async () => {
    const log: string[] = []
    const inner = new FakeWorkspace({ log, id: "inner" })
    await expect(
      env(ctx, {
        provision: fakeProvisioner({ log, ws: inner }),
        contain: fakeContainment({ log, failPreflight: true }),
        spec,
      }),
    ).rejects.toThrow(/containment preflight boom/)
    expect(inner.destroyCount).toBe(1)
    expect(inner.lastOutcome).toBe("setup-failure")
  })

  test("injector apply failure: redactions stay active, cleanup + destroy still run", async () => {
    const log: string[] = []
    const redactor = new RecordingRedactor()
    const inner = new FakeWorkspace({ log, id: "inner" })
    const ok = new ScriptedInjector({ id: "ok", secrets: ["A"], log, redactor })
    const bad = new ScriptedInjector({ id: "bad", secrets: ["B"], failApply: true, log, redactor })
    await expect(
      env(ctx, {
        provision: fakeProvisioner({ log, ws: inner }),
        contain: fakeContainment({ log }),
        spec,
        injectors: [ok, bad],
        redactor,
      }),
    ).rejects.toThrow(/apply failed: bad/)

    // Redactions for BOTH injectors were registered before the failing apply —
    // and are NEVER unregistered (a half-failed apply can't leak).
    expect(redactor.registered).toEqual(["A", "B"])
    // Reverse-order cleanup ran for every acquired injector (cleanup pushed
    // BEFORE apply, so the half-failed 'bad' still cleans up), then inner destroy.
    expect(log.slice(-3)).toEqual(["cleanup:bad", "cleanup:ok", "destroy:inner"])
    expect(inner.lastOutcome).toBe("setup-failure")
  })

  test("aggregated errors: setup failure AND a teardown failure both surface", async () => {
    const log: string[] = []
    const inner = new FakeWorkspace({ log, id: "inner", failDestroy: true })
    const bad = new ScriptedInjector({ id: "bad", failApply: true, log })
    await expect(
      env(ctx, {
        provision: fakeProvisioner({ log, ws: inner }),
        contain: fakeContainment({ log }),
        spec,
        injectors: [bad],
      }),
    ).rejects.toThrow(/setup failed and unwind hit errors/)
  })
})
