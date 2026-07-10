// Layer 0 of the test pyramid: freeze the ENTIRE public TypeScript surface — the
// exported names/shapes of each public subpath barrel (screen, wrapper, turns,
// transcript, chat, discovery, versions) plus the root — against a committed
// golden. A rename, a removed export, a changed const value, or a type→value
// reclassification fails loudly here and forces a conscious golden update.
//
// Regenerate after an INTENTIONAL change with:
//   UPDATE_GOLDEN=1 bun test test/contract.test.ts
//
// This is the TS analogue of pkg/chat/contract_test.go's go_api.golden, widened
// from one package to the whole public surface. It also freezes the Phase-0
// guard: NO internal/** symbol may leak into any public barrel.

import { describe, expect, test } from "vitest"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const srcRoot = join(here, "..", "src")
const goldenPath = join(here, "testdata", "ts_surface.golden")

// The eight public subpath barrels named in package.json `exports` (root last).
const PUBLIC_BARRELS = [
  "screen/index.ts",
  "wrapper/index.ts",
  "turns/index.ts",
  "transcript/index.ts",
  "chat/index.ts",
  "discovery/index.ts",
  "versions/index.ts",
  "index.ts",
]

// Names exported type-only from a barrel — erased at runtime, so scraped from
// source rather than reflected. Captures `export type { A, B }` blocks and the
// `type X` members inside a mixed `export { type X, Y }` block.
function typeOnlyExports(src: string): Set<string> {
  const out = new Set<string>()
  // `export type { ... }` — every name in the block is type-only.
  for (const m of src.matchAll(/export\s+type\s*\{([^}]*)\}/g)) {
    for (const raw of m[1].split(",")) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim()
      if (name) out.add(name)
    }
  }
  // `export { ... }` — only members prefixed with `type ` are type-only.
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const raw of m[1].split(",")) {
      const t = raw.trim()
      const mm = /^type\s+(\w+)/.exec(t)
      if (mm) out.add(mm[1])
    }
  }
  return out
}

// Serializes one barrel's frozen surface: sorted lines, one per export, tagged
// with its runtime kind (function/class, string/number const value, object
// shape) or `type` for type-only exports.
async function serializeBarrel(rel: string): Promise<string> {
  const src = readFileSync(join(srcRoot, rel), "utf8")
  const typeOnly = typeOnlyExports(src)
  const mod = (await import(join(srcRoot, rel))) as Record<string, unknown>

  const lines: string[] = []
  const seen = new Set<string>()

  for (const name of Object.keys(mod)) {
    if (name === "default") continue
    seen.add(name)
    lines.push(`  ${name}: ${describeValue(mod[name])}`)
  }
  // Type-only exports never appear at runtime — add them from source.
  for (const name of typeOnly) {
    if (seen.has(name)) continue
    seen.add(name)
    lines.push(`  ${name}: type`)
  }

  lines.sort()
  return `${rel}\n${lines.join("\n")}`
}

function describeValue(v: unknown): string {
  switch (typeof v) {
    case "function":
      // A class (has a non-trivial prototype method set) vs a plain function.
      return isClass(v as Function)
        ? `class{${classMembers(v as Function).join(",")}}`
        : "function"
    case "string":
      return `string=${JSON.stringify(v)}`
    case "number":
      return `number=${v}`
    case "boolean":
      return `boolean=${v}`
    case "object":
      if (v === null) return "null"
      return `object{${Object.keys(v as object).sort().join(",")}}`
    default:
      return typeof v
  }
}

function isClass(fn: Function): boolean {
  const names = Object.getOwnPropertyNames(fn.prototype ?? {}).filter((n) => n !== "constructor")
  return names.length > 0 || /^class\s/.test(Function.prototype.toString.call(fn))
}

// The exported class's public instance members (methods + accessors), sorted.
// This freezes the method set the way the Go contract froze a type's method set.
function classMembers(fn: Function): string[] {
  const proto = fn.prototype
  if (!proto) return []
  return Object.getOwnPropertyNames(proto)
    .filter((n) => n !== "constructor" && !n.startsWith("_"))
    .sort()
}

async function buildSurface(): Promise<string> {
  const blocks: string[] = []
  for (const rel of PUBLIC_BARRELS) {
    blocks.push(await serializeBarrel(rel))
  }
  return blocks.join("\n\n") + "\n"
}

describe("public TS surface contract", () => {
  test("frozen surface matches the committed golden", async () => {
    const got = await buildSurface()
    if (process.env.UPDATE_GOLDEN === "1") {
      writeFileSync(goldenPath, got)
      return
    }
    const want = readFileSync(goldenPath, "utf8")
    expect(got).toBe(want)
  })

  // Freeze the Phase-0 guard: NO internal/** runtime symbol leaks into a barrel.
  test("no internal/** symbol leaks into any public barrel", async () => {
    const internalNames = new Set(Object.keys(await import("../src/internal/async/index.ts")))
    for (const rel of PUBLIC_BARRELS) {
      const mod = (await import(join(srcRoot, rel))) as Record<string, unknown>
      for (const name of Object.keys(mod)) {
        if (name === "default") continue
        expect(internalNames.has(name)).toBe(false)
      }
    }
  })

  // And no barrel re-exports from an internal path at the source level.
  test("no barrel imports from src/internal/**", () => {
    const INTERNAL_IMPORT = /(from|import)\s*\(?\s*["'][^"']*\binternal\b[^"']*["']/
    for (const rel of PUBLIC_BARRELS) {
      const src = readFileSync(join(srcRoot, rel), "utf8")
      expect(INTERNAL_IMPORT.test(src)).toBe(false)
    }
  })
})
