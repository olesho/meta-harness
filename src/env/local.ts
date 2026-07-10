// The `local` provisioner (design §3 shipped implementations).
//
// The degenerate provisioner: host == guest. exec is `node:child_process`;
// upload/download are `node:fs` copies. No image is booted — a per-workspace
// base directory (named by the DETERMINISTIC spec.name for crash recovery)
// stands in for the machine, with repo / .home / tmp subdirs.

import type { Context } from "../async/index.ts"
import { spawn } from "node:child_process"
import { cpSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  ExecOpts,
  ExecResult,
  Provisioner,
  Workspace,
  WorkspaceSpec,
  Outcome,
} from "./types.ts"
import { shouldKeep } from "./retention.ts"

const SUBDIR: Record<"repo" | "home" | "tmp", string> = {
  repo: "repo",
  home: ".home",
  tmp: "tmp",
}

class LocalWorkspace implements Workspace {
  private destroyed = false
  constructor(
    private readonly base: string,
    private readonly spec: WorkspaceSpec,
  ) {}

  exec(ctx: Context, argv: string[], opts?: ExecOpts): Promise<ExecResult> {
    if (argv.length === 0) return Promise.reject(new Error("local.exec: empty argv"))
    const [cmd, ...rest] = argv
    const cwd = opts?.cwd ?? this.guestPath("repo")
    // Overlay the caller's env onto the host env — env crosses via opts.env.
    const env = opts?.env ? { ...process.env, ...opts.env } : process.env

    return new Promise<ExecResult>((resolve, reject) => {
      // argv is passed as a list to spawn (no shell), so no argument can inject
      // an extra command — no shell metacharacter is ever interpreted here.
      const child = spawn(cmd, rest, { cwd, env, stdio: ["pipe", "pipe", "pipe"] })
      let stdout = ""
      let stderr = ""
      let settled = false

      const onCancel = () => {
        if (settled) return
        child.kill("SIGKILL")
        settled = true
        reject(ctx.err() ?? new Error("local.exec: context cancelled"))
      }
      // Fire onCancel if the context is (or becomes) done during the run.
      if (ctx.isDone()) {
        onCancel()
        return
      }
      void ctx.done().then(() => onCancel())

      child.stdout.on("data", (d) => (stdout += d.toString()))
      child.stderr.on("data", (d) => (stderr += d.toString()))
      child.on("error", (err) => {
        if (settled) return
        settled = true
        reject(err)
      })
      child.on("close", (code) => {
        if (settled) return
        settled = true
        resolve({ code: code ?? 0, stdout, stderr })
      })

      if (opts?.stdin !== undefined) child.stdin.end(opts.stdin)
      else child.stdin.end()
    })
  }

  async upload(_ctx: Context, hostPath: string, guestPath: string): Promise<void> {
    // Recursive copy preserving mode bits (executable flags) and directory trees
    // such as `.git`. cpSync copies file modes by default.
    mkParent(guestPath)
    cpSync(hostPath, guestPath, { recursive: true, preserveTimestamps: true })
  }

  async download(_ctx: Context, guestPath: string, hostPath: string): Promise<void> {
    mkParent(hostPath)
    cpSync(guestPath, hostPath, { recursive: true, preserveTimestamps: true })
  }

  guestPath(kind: "repo" | "home" | "tmp"): string {
    return join(this.base, SUBDIR[kind])
  }

  hostAlias(hostUrl: string): string {
    // Degenerate host == guest: host URLs are already guest-reachable.
    return hostUrl
  }

  async destroy(_ctx: Context, outcome: Outcome = "success"): Promise<void> {
    if (this.destroyed) return // idempotent: double-destroy is a no-op.
    this.destroyed = true
    if (shouldKeep(this.spec.retention, outcome)) return // kept for debugging.
    rmSync(this.base, { recursive: true, force: true })
  }
}

function mkParent(p: string): void {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"))
  if (i > 0) mkdirSync(p.slice(0, i), { recursive: true })
}

class LocalProvisioner implements Provisioner {
  constructor(private readonly root: string) {}

  name(): string {
    return "local"
  }

  async preflight(_ctx: Context): Promise<void> {
    // Host-side, zero resources: the base root must be creatable. mkdir is
    // idempotent and cheap; a permission error surfaces here, before create().
    mkdirSync(this.root, { recursive: true })
  }

  async create(_ctx: Context, spec: WorkspaceSpec): Promise<Workspace> {
    const base = join(this.root, spec.name)
    // Crash recovery: a leftover from a crashed run under the SAME deterministic
    // name is removed before recreate (orche sandboxName pattern).
    rmSync(base, { recursive: true, force: true })
    for (const kind of ["repo", "home", "tmp"] as const) {
      mkdirSync(join(base, SUBDIR[kind]), { recursive: true })
    }
    return new LocalWorkspace(base, spec)
  }
}

/** Construct the `local` provisioner. `root` defaults to an OS-temp subdir; pass
 *  an explicit root for hermetic tests. */
export function local(opts?: { root?: string }): Provisioner {
  return new LocalProvisioner(opts?.root ?? join(tmpdir(), "meta-harness-env"))
}
