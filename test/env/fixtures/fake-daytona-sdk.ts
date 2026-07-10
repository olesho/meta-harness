// Fake @daytonaio/sdk module for Tier-1 hermetic tests (META-HARNESS-45).
//
// Exercised via `daytona({ sdkImport: <url of this file> })` /
// `sweep(ctx, { sdkImport: ... }, ...)`. `state` is a module-level singleton —
// dynamic `import()` of the same specifier always resolves to the same
// instance, so tests configure `state` before invoking the code under test and
// call `resetFakeDaytonaSdk()` in `beforeEach` to avoid cross-test leakage.

export interface FakeSandboxSpec {
  id: string
  labels?: Record<string, string>
}

export const state: {
  /** Scripts process.executeCommand's response for a given raw shell command. */
  execResult: (command: string) => { result?: string; exitCode: number }
  /** Sandboxes visible to Daytona.list(). */
  sandboxes: FakeSandboxSpec[]
  executedCommands: string[]
  uploads: Array<{ buffer: Buffer; path: string }>
  downloads: string[]
  deletedIds: string[]
  createCalls: Array<Record<string, unknown>>
  clientConfigs: Array<Record<string, unknown>>
  /** When set, a sandbox whose id this returns true for throws on delete(). */
  deleteShouldFail: (id: string) => boolean
} = {
  execResult: () => ({ result: "", exitCode: 0 }),
  sandboxes: [],
  executedCommands: [],
  uploads: [],
  downloads: [],
  deletedIds: [],
  createCalls: [],
  clientConfigs: [],
  deleteShouldFail: () => false,
}

export function resetFakeDaytonaSdk(): void {
  state.execResult = () => ({ result: "", exitCode: 0 })
  state.sandboxes = []
  state.executedCommands = []
  state.uploads = []
  state.downloads = []
  state.deletedIds = []
  state.createCalls = []
  state.clientConfigs = []
  state.deleteShouldFail = () => false
}

class FakeSandbox {
  labels: Record<string, string>
  process = {
    executeCommand: async (
      command: string,
      _cwd?: string,
      _env?: Record<string, string>,
      _timeout?: number,
    ) => {
      state.executedCommands.push(command)
      return state.execResult(command)
    },
  }
  fs = {
    uploadFile: async (buffer: Buffer, path: string) => {
      state.uploads.push({ buffer, path })
    },
    downloadFile: async (_path: string) => {
      state.downloads.push(_path)
      return Buffer.from("")
    },
  }

  constructor(public id: string) {
    this.labels = {}
  }

  async delete(_timeoutSeconds: number): Promise<void> {
    if (state.deleteShouldFail(this.id)) {
      throw new Error(`fake delete failure for ${this.id}`)
    }
    state.deletedIds.push(this.id)
  }
}

export class Daytona {
  constructor(private config: Record<string, unknown>) {
    state.clientConfigs.push(config)
  }

  async create(opts: Record<string, unknown>): Promise<FakeSandbox> {
    state.createCalls.push(opts)
    const sandbox = new FakeSandbox(`fake-sandbox-${state.createCalls.length}`)
    sandbox.labels = (opts.labels as Record<string, string>) ?? {}
    return sandbox
  }

  async *list(_query?: { labels?: Record<string, string> }): AsyncIterableIterator<FakeSandbox> {
    for (const spec of state.sandboxes) {
      const sandbox = new FakeSandbox(spec.id)
      sandbox.labels = spec.labels ?? {}
      yield sandbox
    }
  }
}
