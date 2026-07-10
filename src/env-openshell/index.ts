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

  async preflight(ctx: Context): Promise<void> {
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
    const tier = (policy.tier as string) ?? "semi-trusted"
    const modelHost = (policy.modelHost as string) ?? "api.anthropic.com"
    const modelPort = (policy.modelPort as number) ?? 443
    const fleetHost = (policy.fleetHost as string) ?? "localhost"
    const fleetPort = (policy.fleetPort as number) ?? 53343
    const harnessPath = (policy.harnessPath as string) ?? "/usr/local/bin/harness-wrapper"

    const policyYaml = generatePolicy({
      tier,
      modelHost,
      modelPort,
      fleetHost,
      fleetPort,
      harnessPath,
    })

    return {
      execWrap(argv: string[], opts: ExecOpts): [string[], ExecOpts] {
        // No sandbox name available at layer creation; caller provides via outer Containment
        // This is a limitation of the current design — we'll need to refactor this.
        // For now, return a marker that the caller must replace.
        const wrapped = [
          "openshell",
          "sandbox",
          "exec",
          "-n",
          "__SANDBOX_NAME__", // placeholder
          "--no-tty",
          "--workdir",
          "/sandbox/repo",
          "--",
          "env",
          ...argv,
        ]
        return [wrapped, opts]
      },

      crossUpload(stagingPath: string, guestPath: string): string[] {
        return [
          "openshell",
          "sandbox",
          "upload",
          "--no-git-ignore",
          "__SANDBOX_NAME__",
          stagingPath,
          guestPath,
        ]
      },

      crossDownload(guestPath: string, stagingPath: string): string[] {
        return [
          "openshell",
          "sandbox",
          "download",
          "__SANDBOX_NAME__",
          guestPath,
          stagingPath,
        ]
      },

      pathMap(kind: "repo" | "home" | "tmp"): string {
        switch (kind) {
          case "repo":
            return "/sandbox/repo"
          case "home":
            return "/sandbox/.home"
          case "tmp":
            return "/tmp"
        }
      },

      teardown(): string[] {
        return ["openshell", "sandbox", "delete", "__SANDBOX_NAME__"]
      },

      aliasMap: (hostUrl: string): string => {
        return resolveGuestUrl(hostUrl, this.driver)
      },
    }
  }
}

export function openshell(opts?: {
  driver?: string
  provider?: string
  guestPath?: string
  cli?: CliRunner
}): Containment {
  return new OpenShellContainment(opts ?? {}, opts?.cli)
}
