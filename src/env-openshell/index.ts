// OpenShell containment layer for meta-harness (ported from orche).
//
// Wraps the `openshell` CLI transport as an injectable CliRunner over the
// Containment interface (design §3, §5). The CLI transport manages sandbox
// create/exec/upload/download/delete operations with:
//
//  - injectable CliRunner for testability (scripted unit tests, no live gateway)
//  - policy generation (per-tier filesystem sets, landlock, per-binary egress)
//  - host-alias rewrite (docker/podman containers reaching the host)
//  - env crossing as in-guest `env K=V` argv PREFIX (0.0.53 exec has no --env)
//  - deterministic sandbox naming for crash recovery
//  - retention semantics mirroring orche's sandboxRetention

import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import type { Context } from "../async/index.ts"
import type {
  Containment,
  ContainmentLayer,
  ExecOpts,
  PolicySpec,
  Workspace,
} from "../env/types.ts"

/** CLI runner result shape. */
export interface CliResult {
  code: number
  stdout: string
  stderr: string
}

/** Injectable host runner for `openshell …` invocations. Tests script the daemon
 *  without a live gateway; default spawns via node:child_process. */
export type CliRunner = (argv: string[]) => CliResult

function spawnOpenShellCli(argv: string[]): CliResult {
  try {
    const p = spawnSync(argv[0]!, argv.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    })
    return {
      code: p.status ?? -1,
      stdout: p.stdout ?? "",
      stderr: p.stderr ?? "",
    }
  } catch (err) {
    return {
      code: -1,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Strip ANSI SGR color escapes from CLI output. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "")
}

/** Normalize an agentId into an OpenShell sandbox name: `openshell-` + lowercased,
 *  charset-bounded (`[a-z0-9-]`), length-bounded slug with hash suffix on
 *  truncation. Collision-resistant and deterministic for crash recovery. */
export function sandboxName(agentId: string): string {
  const slug = agentId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  const MAX = 40
  const prefix = "openshell-"
  if (slug.length + prefix.length <= MAX) return `${prefix}${slug}`
  const hash = createHash("sha256").update(agentId).digest("hex").slice(0, 8)
  const keep = MAX - prefix.length - 1 - hash.length
  return `${prefix}${slug.slice(0, Math.max(1, keep))}-${hash}`
}

/** Loopback hosts that cannot reach a host gateway. */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"])

/** Host-gateway aliases per container driver. */
function hostGatewayAlias(driver: string): string | undefined {
  switch (driver) {
    case "container":
    case "docker":
      return "host.docker.internal"
    case "podman":
      return "host.containers.internal"
    default:
      return undefined
  }
}

/** Rewrite a loopback URL to a guest-reachable address for the driver.
 *  Throws when loopback can't be routed and no override is configured. */
export function resolveGuestUrl(
  hostUrl: string,
  driver: string,
  guestOverride?: string,
): string {
  if (guestOverride?.trim()) return guestOverride.trim()
  let u: URL
  try {
    u = new URL(hostUrl)
  } catch {
    throw new Error(`invalid URL ${JSON.stringify(hostUrl)}`)
  }
  if (!LOOPBACK.has(u.hostname)) return hostUrl
  const alias = hostGatewayAlias(driver)
  if (!alias) {
    throw new Error(
      `URL is loopback (${u.hostname}) and driver ${JSON.stringify(driver)} ` +
        "cannot route it",
    )
  }
  u.hostname = alias
  // Remove trailing slash if pathname is empty or just "/"
  let result = u.toString()
  if (result.endsWith("/") && u.pathname === "/") {
    result = result.slice(0, -1)
  }
  return result
}

/** Policy generation: per-tier filesystem sets, landlock, per-binary egress.
 *  Pure function, no I/O. */
export interface PolicyScopes {
  tier: string
  modelHost: string
  modelPort?: number
  fleetHost: string
  fleetPort: number
  harnessPath: string
}

function tierKnobs(tier: string): {
  readOnly: string[]
  enforcement: "enforce" | "observe"
} {
  switch (tier) {
    case "untrusted":
      return {
        readOnly: ["/usr", "/lib", "/lib64", "/etc", "/bin", "/sbin", "/opt"],
        enforcement: "enforce",
      }
    case "semi-trusted":
      return {
        readOnly: ["/usr", "/lib", "/etc", "/bin"],
        enforcement: "enforce",
      }
    case "trusted-internal":
      return {
        readOnly: ["/usr", "/lib"],
        enforcement: "observe",
      }
    default:
      throw new Error(`unknown tier ${JSON.stringify(tier)}`)
  }
}

export function generatePolicy(scopes: PolicyScopes): string {
  const { readOnly, enforcement } = tierKnobs(scopes.tier)
  const modelPort = scopes.modelPort ?? 443

  const lines: string[] = []
  lines.push("version: 1")
  lines.push("filesystem_policy:")
  lines.push("  include_workdir: false")
  lines.push(`  read_only: [${readOnly.map((p) => `'${p}'`).join(", ")}]`)
  lines.push("  read_write: [/sandbox, /tmp]")
  lines.push("process: { run_as_user: sandbox, run_as_group: sandbox }")
  lines.push("landlock: { compatibility: best_effort }")
  lines.push("network_policies:")
  lines.push("  model:")
  lines.push(
    `    endpoints: [{ host: ${scopes.modelHost}, port: ${modelPort}, protocol: rest, access: full, enforcement: ${enforcement} }]`,
  )
  lines.push("    binaries: [{ path: /usr/local/bin/claude }]")
  lines.push("  fleet:")
  lines.push(
    `    endpoints: [{ host: ${scopes.fleetHost}, port: ${scopes.fleetPort}, protocol: rest, access: full, enforcement: ${enforcement} }]`,
  )
  lines.push(
    `    binaries: [{ path: ${scopes.harnessPath} }, { path: /usr/local/bin/orche }]`,
  )
  lines.push("  # git hub: bundle-out ⇒ NO network endpoint")
  return `${lines.join("\n")}\n`
}

/** OpenShell containment implementation. */
export class OpenShellContainment implements Containment {
  private driver: string
  private provider: string
  private guestPath: string

  constructor(
    private opts: {
      driver?: string
      provider?: string
      guestPath?: string
      /** Default agentId for sandbox naming when policy.agentId is absent. */
      agentId?: string
      /** Image/Dockerfile ref for `sandbox create --from` (e.g. a node-bearing
       *  image when the gateway's default image lacks node). */
      from?: string
    },
    private cli: CliRunner = spawnOpenShellCli,
  ) {
    this.driver = opts.driver ?? "container"
    this.provider = opts.provider ?? "anthropic"
    this.guestPath = opts.guestPath ?? "/sandbox/repo"
  }

  name(): string {
    return "openshell"
  }

  async preflight(_ctx: Context, _ws: Workspace): Promise<void> {
    // Check gateway connectivity
    const st = this.cli(["openshell", "status"])
    if (st.code !== 0) {
      throw new Error(
        `openshell gateway not available: ${(st.stderr || st.stdout).trim().slice(0, 300)}`,
      )
    }
    const statusText = stripAnsi(st.stdout)
    if (!/\bconnected\b/i.test(statusText)) {
      throw new Error(
        `openshell gateway not Connected: ${statusText.trim().slice(0, 300)}`,
      )
    }

    // Check provider registration
    const pr = this.cli(["openshell", "provider", "get", this.provider])
    if (pr.code !== 0) {
      throw new Error(
        `openshell provider ${JSON.stringify(this.provider)} not registered`,
      )
    }
  }

  layer(policy: PolicySpec): ContainmentLayer {
    // Unit-test seam: a caller that already owns a sandbox names it explicitly.
    // Production goes through acquire(), which creates the sandbox and returns
    // a layer closed over the real name.
    const name = policy.sandboxName
    if (typeof name !== "string" || name.length === 0) {
      throw new Error(
        "openshell.layer: no sandbox name — use acquire() (production path) or " +
          "pass policy.sandboxName (unit-test seam)",
      )
    }
    return buildLayer(name, this.guestPath, this.driver)
  }

  /** Create the sandbox (lifecycle step 4 — containment resources exist from
   *  here) and return a layer closed over its name. All commands run via the
   *  INNER workspace's exec (containment runs where inner runs, §5.1). */
  async acquire(ctx: Context, ws: Workspace, policy: PolicySpec): Promise<ContainmentLayer> {
    const agentId = (policy.agentId as string | undefined) ?? this.opts.agentId
    if (!agentId) {
      throw new Error(
        "openshell.acquire: no agentId — set policy.agentId or openshell({ agentId })",
      )
    }
    const name = sandboxName(agentId)

    // Crash recovery: best-effort delete of a leftover sandbox under the same
    // deterministic name from a crashed prior run.
    try {
      await ws.exec(ctx, ["openshell", "sandbox", "delete", name])
    } catch {
      // best-effort only
    }

    // Explicit tier ⇒ stage a generated policy file; absent ⇒ gateway default.
    let policyPath: string | undefined
    if (typeof policy.tier === "string") {
      const yaml = generatePolicy({
        tier: policy.tier,
        modelHost: (policy.modelHost as string) ?? "api.anthropic.com",
        modelPort: (policy.modelPort as number) ?? 443,
        fleetHost: (policy.fleetHost as string) ?? "localhost",
        fleetPort: (policy.fleetPort as number) ?? 53343,
        harnessPath: (policy.harnessPath as string) ?? "/usr/local/bin/harness-wrapper",
      })
      policyPath = `${ws.guestPath("tmp")}/openshell-policy-${name}.yaml`
      const staged = await ws.exec(ctx, ["sh", "-c", `cat > '${policyPath}'`], {
        stdin: yaml,
      })
      if (staged.code !== 0) {
        throw new Error(
          `openshell.acquire: staging policy file failed (exit ${staged.code}): ` +
            `${staged.stderr || staged.stdout}`,
        )
      }
    }

    const created = await ws.exec(ctx, [
      "openshell",
      "sandbox",
      "create",
      "--name",
      name,
      ...(this.opts.from ? ["--from", this.opts.from] : []),
      ...(policyPath ? ["--policy", policyPath] : []),
    ])
    if (created.code !== 0) {
      throw new Error(
        `openshell.acquire: sandbox create failed (exit ${created.code}): ` +
          `${created.stderr || created.stdout}`,
      )
    }

    // Anything fallible after create must not leak the sandbox: best-effort
    // delete before rethrowing.
    try {
      // Guest layout prep (default image layout is not guaranteed). One
      // multi-arg mkdir: fully succeeds or fully fails, no partial case.
      const prep = await ws.exec(ctx, [
        "openshell",
        "sandbox",
        "exec",
        "-n",
        name,
        "--no-tty",
        "--",
        "mkdir",
        "-p",
        this.guestPath,
        "/sandbox/.home",
      ])
      if (prep.code !== 0) {
        throw new Error(
          `openshell.acquire: guest layout prep failed (exit ${prep.code}): ` +
            `${prep.stderr || prep.stdout}`,
        )
      }
    } catch (err) {
      try {
        await ws.exec(ctx, ["openshell", "sandbox", "delete", name])
      } catch {
        // best-effort only
      }
      throw err
    }

    return buildLayer(name, this.guestPath, this.driver)
  }
}

/** Layer primitives closed over a REAL sandbox name. Module-scoped (not a class
 *  method) so the erased-at-runtime `private` keyword can't leak it onto the
 *  public class surface. */
function buildLayer(name: string, guestRepo: string, driver: string): ContainmentLayer {
  // The real openshell CLI errors on deleting an already-gone sandbox, and
  // compose() calls layer.teardown() unconditionally on every destroy —
  // idempotent double-destroy (conformance contract) therefore lives here:
  // emit the delete argv once, then [] ("nothing to tear down").
  let torndown = false

  return {
    execWrap(argv: string[], opts: ExecOpts): [string[], ExecOpts] {
      const envEntries = Object.entries(opts.env ?? {})
      const wrapped = [
        "openshell",
        "sandbox",
        "exec",
        "-n",
        name,
        "--no-tty",
        "--workdir",
        opts.cwd ?? guestRepo,
        "--",
        // 0.0.53 exec has no --env: cross env as an in-guest `env K=V` prefix,
        // omitted entirely when empty (a bare `env` would swallow argv[0]).
        ...(envEntries.length > 0
          ? ["env", ...envEntries.map(([k, v]) => `${k}=${v}`)]
          : []),
        ...argv,
      ]
      // cwd/env are CONSUMED into the wrapper (guest-side): passing them
      // through would set a guest path as the HOST cwd and leak guest env
      // (possibly secrets) into the host openshell process.
      const { cwd: _cwd, env: _env, ...rest } = opts
      return [wrapped, rest]
    },

    crossUpload(stagingPath: string, guestPath: string): string[] {
      return [
        "openshell",
        "sandbox",
        "upload",
        "--no-git-ignore",
        name,
        stagingPath,
        guestPath,
      ]
    },

    crossDownload(guestPath: string, stagingPath: string): string[] {
      return ["openshell", "sandbox", "download", name, guestPath, stagingPath]
    },

    pathMap(kind: "repo" | "home" | "tmp"): string {
      switch (kind) {
        case "repo":
          return guestRepo
        case "home":
          return "/sandbox/.home"
        case "tmp":
          return "/tmp"
      }
    },

    teardown(): string[] {
      if (torndown) return []
      torndown = true
      return ["openshell", "sandbox", "delete", name]
    },

    aliasMap: (hostUrl: string): string => {
      return resolveGuestUrl(hostUrl, driver)
    },
  }
}

export function openshell(opts?: {
  driver?: string
  provider?: string
  guestPath?: string
  agentId?: string
  from?: string
  cli?: CliRunner
}): Containment {
  return new OpenShellContainment(opts ?? {}, opts?.cli)
}
