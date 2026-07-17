// Unit tests for the registry-drift sentry (src/drift/sentry.ts) and the thin
// check-versions CLI (src/cli/check-versions.ts). The Node global `fetch` is
// mocked so no test touches the real npm registry.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import {
  fetchLatest,
  checkEntry,
  checkAll,
  hasDrift,
  errFetch,
  errParse,
  type Row,
} from "../../src/drift/sentry.ts"
import {
  main as checkVersionsMain,
  ExitOK,
  ExitError,
  ExitDrift,
} from "../../src/cli/check-versions.ts"
import { isSentinel, type Sentinel } from "../../src/internal/async/index.ts"

/** A minimal Response-like stand-in for a mocked fetch. */
function okJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response
}

function status(code: number): Response {
  return {
    ok: false,
    status: code,
    json: async () => ({}),
  } as unknown as Response
}

/** Abbreviated-packument body: latest under dist-tags. */
function packument(latest: string): unknown {
  return { "dist-tags": { latest } }
}

/** /latest document: version at body.version (NOT dist-tags). */
function latestDoc(version: string): unknown {
  return { version }
}

async function expectSentinel(p: Promise<unknown>, sentinel: Sentinel): Promise<void> {
  let thrown: unknown
  try {
    await p
  } catch (err) {
    thrown = err
  }
  expect(thrown).toBeDefined()
  expect(isSentinel(thrown, sentinel)).toBe(true)
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("fetchLatest — scoped-package URL encoding", () => {
  test("scoped name is percent-encoded and dist-tags.latest is read (primary path)", async () => {
    const fetchMock = vi.fn(async (_url: string) => okJson(packument("0.142.5")))
    vi.stubGlobal("fetch", fetchMock)

    const latest = await fetchLatest("@openai/codex")
    expect(latest).toBe("0.142.5")

    // The `/` in the scope must never land raw in the URL path.
    const url = fetchMock.mock.calls[0]![0]
    expect(url).toBe("https://registry.npmjs.org/%40openai%2Fcodex")
    expect(url).not.toContain("@openai/codex")
  })

  test("falls back to /latest and reads body.version when dist-tags is absent", async () => {
    const wrapped = vi.fn(async (url: string) => {
      if (url.endsWith("/latest")) return okJson(latestDoc("0.142.5"))
      return okJson({}) // primary lacks dist-tags → forces fallback
    })
    vi.stubGlobal("fetch", wrapped)

    const latest = await fetchLatest("@openai/codex")
    expect(latest).toBe("0.142.5")

    const primaryUrl = wrapped.mock.calls[0]![0] as string
    const fallbackUrl = wrapped.mock.calls[1]![0] as string
    expect(primaryUrl).toBe("https://registry.npmjs.org/%40openai%2Fcodex")
    expect(fallbackUrl).toBe("https://registry.npmjs.org/%40openai%2Fcodex/latest")
  })

  test("bare name uses the same single encoded code path", async () => {
    const fetchMock = vi.fn(async (_url: string) => okJson(packument("1.2.3")))
    vi.stubGlobal("fetch", fetchMock)

    const latest = await fetchLatest("opencode-ai")
    expect(latest).toBe("1.2.3")
    expect(fetchMock.mock.calls[0]![0]).toBe("https://registry.npmjs.org/opencode-ai")
  })
})

describe("checkEntry — three states", () => {
  test("match — pinned equals npm latest", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okJson(packument("0.142.5"))))
    const row = await checkEntry("codex", "@openai/codex", "0.142.5")
    expect(row.status).toBe("match")
    expect(row.latest).toBe("0.142.5")
  })

  test("drift — pinned differs from npm latest (exact string equality)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okJson(packument("0.143.0"))))
    const row = await checkEntry("codex", "@openai/codex", "0.142.5")
    expect(row.status).toBe("drift")
    expect(row.latest).toBe("0.143.0")
  })

  test("unpinned — empty pin is skipped and never hits the network", async () => {
    const fetchMock = vi.fn(async () => okJson(packument("9.9.9")))
    vi.stubGlobal("fetch", fetchMock)
    const row = await checkEntry("opencode", "opencode-ai", "")
    expect(row.status).toBe("unpinned")
    expect(row.latest).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("error paths — distinct sentinel, never false match/drift", () => {
  test("fetch rejects → errFetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED")
      }),
    )
    await expectSentinel(fetchLatest("@openai/codex"), errFetch)
  })

  test("404 → errFetch", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => status(404)))
    await expectSentinel(fetchLatest("@openai/codex"), errFetch)
  })

  test("unparseable JSON → errParse", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("Unexpected token")
        },
      })),
    )
    await expectSentinel(fetchLatest("@openai/codex"), errParse)
  })

  test("valid JSON without a version field → errParse", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okJson({ "dist-tags": {} })))
    await expectSentinel(fetchLatest("@openai/codex"), errParse)
  })
})

describe("checkAll + hasDrift against the embedded catalog", () => {
  test("all packages latest == pinned → all match, opencode unpinned", async () => {
    // Return each package's pinned value as latest so nothing drifts.
    const pins: Record<string, string> = {
      "%40openai%2Fcodex": "0.142.5",
      "%40anthropic-ai%2Fclaude-code": "2.1.201",
      "%40earendil-works%2Fpi-coding-agent": "0.76.0",
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const enc = url.slice("https://registry.npmjs.org/".length)
        const latest = pins[enc]
        return okJson(packument(latest ?? "0.0.0"))
      }),
    )
    const rows = await checkAll()
    const byName = new Map(rows.map((r) => [r.name, r]))
    expect(byName.get("codex")!.status).toBe("match")
    expect(byName.get("claude-code")!.status).toBe("match")
    expect(byName.get("pi")!.status).toBe("match")
    expect(byName.get("opencode")!.status).toBe("unpinned")
    expect(hasDrift(rows)).toBe(false)
  })
})

describe("CLI exit-code contract", () => {
  let exitCode: number | undefined
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    exitCode = undefined
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    void exitCode
    void stdoutSpy
    void stderrSpy
  })

  test("exit 0 — everything matches / unpinned", async () => {
    const pins: Record<string, string> = {
      "%40openai%2Fcodex": "0.142.5",
      "%40anthropic-ai%2Fclaude-code": "2.1.201",
      "%40earendil-works%2Fpi-coding-agent": "0.76.0",
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const enc = url.slice("https://registry.npmjs.org/".length)
        return okJson(packument(pins[enc] ?? "0.0.0"))
      }),
    )
    expect(await checkVersionsMain()).toBe(ExitOK)
  })

  test("exit 2 — drift detected", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okJson(packument("999.999.999"))))
    expect(await checkVersionsMain()).toBe(ExitDrift)
  })

  test("exit 1 — probe/network/parse error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down")
      }),
    )
    expect(await checkVersionsMain()).toBe(ExitError)
  })
})
