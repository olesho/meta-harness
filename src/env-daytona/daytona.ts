// Daytona provisioner (design §3, §4).
//
// Provisions elastic remote sandboxes via the Daytona SDK (@daytonaio/sdk,
// optional peer dependency). The SDK is loaded lazily at preflight/create time
// so this module stays SDK-free and can be imported by consumers without the
// peer being installed.
//
// Ported from loomcli DaytonaSandboxApi (daytona-task-runner.ts:373-434).

import type { Context } from "../async/index.ts"
import type { Provisioner, Workspace, WorkspaceSpec } from "../env/types.ts"

export interface DaytonaConfig {
  /** Daytona API key (from environment or credential store). */
  apiKey?: string
  /** Daytona API URL override (default: public Daytona SaaS endpoint). */
  apiUrl?: string
  /** Daytona region/target override (default: auto-selected by Daytona). */
  target?: string
  /** Optional SDK import override for testing (defaults to @daytonaio/sdk). */
  sdkImport?: string
}

interface DaytonaSdkClient {
  create(opts: {
    labels?: Record<string, string>
    autoStopInterval?: number
    autoDeleteInterval?: number
  }): Promise<DaytonaSandbox>
}

interface DaytonaSandbox {
  id?: string
  sandboxId?: string
  process: {
    executeCommand(
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeout?: number,
    ): Promise<{
      result: string
      exitCode: number
    }>
  }
  fs: {
    uploadFile(buffer: Buffer, filePath: string): Promise<void>
    downloadFile(filePath: string): Promise<Buffer>
    getFileDetails(filePath: string): Promise<{
      isDir: boolean
      size: number
      modTime?: string
    }>
    listFiles(filePath: string): Promise<Array<{ name: string }>>
    createFolder(filePath: string, mode: string): Promise<void>
    deleteFile(filePath: string, recursive?: boolean): Promise<void>
  }
  getWorkDir?(): Promise<string>
  delete(timeoutSeconds: number): Promise<void>
}

export function daytona(config: DaytonaConfig = {}): Provisioner {
  return new DaytonaProvisioner(config)
}

class DaytonaProvisioner implements Provisioner {
  constructor(private config: DaytonaConfig) {}

  name(): string {
    return "daytona"
  }

  async preflight(ctx: Context): Promise<void> {
    // Load SDK dynamically; if it fails, the provisioner cannot be used
    await this.loadSdk()
  }

  async create(ctx: Context, spec: WorkspaceSpec): Promise<Workspace> {
    // The public npm package is @daytonaio/sdk, but allow override for testing
    const sdkImport = this.config.sdkImport || "@daytonaio/sdk"
    let DaytonaClass: any
    try {
      const mod = await import(sdkImport)
      DaytonaClass = mod.Daytona || (mod.default && mod.default.Daytona)
      if (typeof DaytonaClass !== "function") {
        throw new Error(
          `${sdkImport} did not expose Daytona as a constructor`,
        )
      }
    } catch (error) {
      throw new Error(
        `Failed to load Daytona SDK from ${sdkImport}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    const clientConfig: Record<string, unknown> = {
      apiKey: this.config.apiKey,
    }
    if (this.config.apiUrl) {
      clientConfig.apiUrl = this.config.apiUrl
    }
    if (this.config.target) {
      clientConfig.target = this.config.target
    }

    const client = new DaytonaClass(clientConfig)
    const sandbox = await client.create({
      labels: spec.labels || {},
      autoStopInterval: spec.autoStopInterval ?? 15,
      autoDeleteInterval: spec.autoDeleteInterval ?? 0,
    })

    return new DaytonaWorkspace(sandbox, spec)
  }

  private async loadSdk(): Promise<void> {
    const sdkImport = this.config.sdkImport || "@daytonaio/sdk"
    try {
      await import(sdkImport)
    } catch (error) {
      throw new Error(
        `Daytona SDK (@daytonaio/sdk) not available: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

class DaytonaWorkspace implements Workspace {
  private spec: WorkspaceSpec

  constructor(
    private sandbox: DaytonaSandbox,
    spec: WorkspaceSpec,
  ) {
    this.spec = spec
  }

  async exec(
    ctx: Context,
    argv: string[],
    opts?: { env?: Record<string, string>; cwd?: string; stdin?: string },
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const command = argv.join(" ")
    const result = await this.sandbox.process.executeCommand(
      command,
      opts?.cwd,
      opts?.env,
      /* timeout */ undefined,
    )
    return {
      code: result.exitCode || 0,
      stdout: result.result || "",
      stderr: "",
    }
  }

  async upload(
    ctx: Context,
    hostPath: string,
    guestPath: string,
  ): Promise<void> {
    const fs = await import("node:fs/promises")
    const buffer = await fs.readFile(hostPath)
    await this.sandbox.fs.uploadFile(buffer, guestPath)
  }

  async download(
    ctx: Context,
    guestPath: string,
    hostPath: string,
  ): Promise<void> {
    const fs = await import("node:fs/promises")
    const buffer = await this.sandbox.fs.downloadFile(guestPath)
    await fs.writeFile(hostPath, buffer)
  }

  guestPath(kind: "repo" | "home" | "tmp"): string {
    switch (kind) {
      case "repo":
        return "/home/daytona/repo"
      case "home":
        return "/home/daytona/.home"
      case "tmp":
        return "/tmp"
    }
  }

  hostAlias(hostUrl: string): string {
    // Daytona sandboxes can reach the host via localhost without special handling
    return hostUrl
  }

  async destroy(ctx: Context, outcome?: string): Promise<void> {
    try {
      if (this.sandbox.delete) {
        await this.sandbox.delete(60)
      }
    } catch (error) {
      // Best-effort cleanup; errors are logged by the caller
      const msg =
        error instanceof Error ? error.message : String(error)
      console.error(
        `Warning: failed to delete Daytona sandbox: ${msg}`,
      )
    }
  }
}
