import { describe, expect, test } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

// The public subpath barrels named in package.json `exports`, plus the root.
// None of them may re-export anything from src/internal/**.
const here = dirname(fileURLToPath(import.meta.url))
const srcRoot = join(here, "..", "src")

const PUBLIC_BARRELS = [
  "index.ts",
  "screen/index.ts",
  "wrapper/index.ts",
  "turns/index.ts",
  "transcript/index.ts",
  "chat/index.ts",
  "discovery/index.ts",
  "versions/index.ts",
  "oneshot/index.ts",
  "env/index.ts",
  "env-openshell/index.ts",
]

// Matches `from "...internal..."` / `import("...internal...")` in any barrel.
const INTERNAL_IMPORT = /(from|import)\s*\(?\s*["'][^"']*\binternal\b[^"']*["']/

describe("public barriers never re-export src/internal/**", () => {
  for (const rel of PUBLIC_BARRELS) {
    test(`${rel} has no internal import`, () => {
      const src = readFileSync(join(srcRoot, rel), "utf8")
      expect(INTERNAL_IMPORT.test(src)).toBe(false)
    })
  }

  test("internal async symbols are not reachable from any public barrel", async () => {
    const internalNames = new Set(
      Object.keys(await import("../src/internal/async/index.ts")),
    )
    for (const rel of PUBLIC_BARRELS) {
      const mod = (await import(join(srcRoot, rel))) as Record<string, unknown>
      for (const name of Object.keys(mod)) {
        if (name === "default") continue
        expect(internalNames.has(name)).toBe(false)
      }
    }
  })
})

// `meta-harness/async` is the deliberate exception to the rule above: the ONE
// sanctioned bridge that re-exports the Context cancellation primitive (which
// chat.send / chat.acquireControl demand) from src/internal/**. It is therefore
// NOT in PUBLIC_BARRELS — but it is still governed: it may surface EXACTLY the
// cancellation surface and nothing else from the internal toolkit.
describe("meta-harness/async is the sanctioned public cancellation seam", () => {
  // Runtime (value) exports the async barrel is allowed to surface. CancelFn is
  // type-only (erased at runtime) so it does not appear here.
  const ALLOWED = ["Context", "ctxCanceled", "ctxDeadlineExceeded", "fromAbortSignal"]

  test("surfaces exactly the cancellation primitive", async () => {
    const mod = (await import("../src/async/index.ts")) as Record<string, unknown>
    const names = Object.keys(mod).filter((n) => n !== "default")
    expect(names.sort()).toEqual([...ALLOWED].sort())
  })

  test("does not leak the rest of the internal async toolkit", async () => {
    const internalNames = Object.keys(
      await import("../src/internal/async/index.ts"),
    )
    const forbidden = internalNames.filter((n) => !ALLOWED.includes(n))
    const mod = (await import("../src/async/index.ts")) as Record<string, unknown>
    for (const name of forbidden) {
      expect(name in mod).toBe(false)
    }
    // Sanity: the toolkit really does carry names we expect to stay private.
    expect(forbidden).toContain("Channel")
    expect(forbidden).toContain("Mutex")
    expect(forbidden).toContain("isSentinel")
  })
})
