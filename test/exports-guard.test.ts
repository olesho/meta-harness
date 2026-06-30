import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

// The seven public subpath barrels named in package.json `exports`, plus the
// root. None of them may re-export anything from src/internal/**.
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
