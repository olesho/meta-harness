import { afterEach, describe, expect, test } from "vitest"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  lookup,
  resolvePath,
  WELL_KNOWN_DIRS,
} from "../../src/discovery/discovery.ts"

// These tests exercise resolvePath()'s full resolution chain (env override →
// PATH → well-known dirs) hermetically: every call passes an explicit `env`
// object, so process.env / process.execPath / the real filesystem HOME are
// never touched. Well-known dirs are reached by pointing `env.HOME` at a temp
// dir and materializing a shim under `~/.local/bin` or `~/.claude/local/bin`.
//
// Unix-only: the shims rely on the execute bit (X_OK), which Windows does not
// model, so the suite is skipped on win32.

const isWindows = process.platform === "win32"
const d = isWindows ? describe.skip : describe

/** Creates an executable shim at `dir/name`, making parent dirs as needed. */
function writeShim(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true })
  const full = join(dir, name)
  writeFileSync(full, "#!/bin/sh\nexit 0\n")
  chmodSync(full, 0o755)
  return full
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

const origExecPath = process.execPath

afterEach(() => {
  Object.defineProperty(process, "execPath", { value: origExecPath, configurable: true })
})

describe("WELL_KNOWN_DIRS", () => {
  test("lists the expected probe dirs", () => {
    expect(WELL_KNOWN_DIRS).toContain("~/.claude/local/bin")
    expect(WELL_KNOWN_DIRS).toContain("~/.local/bin")
    expect(WELL_KNOWN_DIRS).toContain("/opt/homebrew/bin")
    expect(WELL_KNOWN_DIRS).toContain("/usr/local/bin")
  })
})

d("resolvePath", () => {
  test("empty PATH + binary in ~/.local/bin → returns absolute path", () => {
    const home = tempDir("resolve-home-")
    const full = writeShim(join(home, ".local", "bin"), "claude")
    const got = resolvePath("claude-code", { PATH: "", HOME: home })
    expect(got).toBe(full)
  })

  test("regression (META-HARNESS-37): empty PATH + ~/.claude/local/bin → succeeds", () => {
    const home = tempDir("resolve-home-")
    const full = writeShim(join(home, ".claude", "local", "bin"), "claude")
    const got = resolvePath("claude-code", { PATH: "", HOME: home })
    expect(got).toBe(full)
  })

  test("env override (absolute, exists) → returns it", () => {
    const dir = tempDir("resolve-ovr-")
    const full = writeShim(dir, "my-claude")
    const got = resolvePath("claude-code", { HARNESS_BINARY_CLAUDE_CODE: full, PATH: "" })
    expect(got).toBe(full)
  })

  test("env override (absolute, missing) → null, does not fall through to PATH", () => {
    const dir = tempDir("resolve-ovr-")
    writeShim(dir, "claude") // claude IS on PATH...
    const got = resolvePath("claude-code", {
      HARNESS_BINARY_CLAUDE_CODE: "/nonexistent/claude", // ...but override wins and misses
      PATH: dir,
    })
    expect(got).toBeNull()
  })

  test("env override (bare name) → resolved on PATH", () => {
    const dir = tempDir("resolve-ovr-")
    const full = writeShim(dir, "my-claude")
    const got = resolvePath("claude-code", { HARNESS_BINARY_CLAUDE_CODE: "my-claude", PATH: dir })
    expect(got).toBe(full)
  })

  test("env override (bare name) not on PATH → null", () => {
    const dir = tempDir("resolve-ovr-")
    const got = resolvePath("claude-code", { HARNESS_BINARY_CLAUDE_CODE: "my-claude", PATH: dir })
    expect(got).toBeNull()
  })

  test("HARNESS_BINARY fallback override applies", () => {
    const dir = tempDir("resolve-ovr-")
    const full = writeShim(dir, "some-harness")
    const got = resolvePath("claude-code", { HARNESS_BINARY: full, PATH: "" })
    expect(got).toBe(full)
  })

  test("unknown harness + env override → returns path", () => {
    const dir = tempDir("resolve-ovr-")
    const full = writeShim(dir, "xyzzy")
    const got = resolvePath("xyzzy", { HARNESS_BINARY_XYZZY: full, PATH: "" })
    expect(got).toBe(full)
  })

  test("HOME unset + binary only in ~/.local/bin → skipped gracefully (null, no throw)", () => {
    const home = tempDir("resolve-home-")
    writeShim(join(home, ".local", "bin"), "claude")
    // No HOME/USERPROFILE in env; process.env.HOME may still exist but points
    // elsewhere, so the temp shim is unreachable → null, and crucially no throw.
    const got = resolvePath("claude-code", { PATH: "", HOME: "" })
    expect(got).toBeNull()
  })

  test("independent of process.execPath (bun/node mismatch)", () => {
    Object.defineProperty(process, "execPath", {
      value: "/nonexistent/bin/bun",
      configurable: true,
    })
    const home = tempDir("resolve-home-")
    const full = writeShim(join(home, ".local", "bin"), "claude")
    const got = resolvePath("claude-code", { PATH: "", HOME: home })
    expect(got).toBe(full)
  })

  test("symlink with existing target → succeeds; dangling symlink → fails", () => {
    const home = tempDir("resolve-home-")
    const bin = join(home, ".local", "bin")
    const target = writeShim(bin, "claude-real")
    const link = join(bin, "claude")
    symlinkSync(target, link)
    expect(resolvePath("claude-code", { PATH: "", HOME: home })).toBe(link)

    const home2 = tempDir("resolve-home-")
    const bin2 = join(home2, ".local", "bin")
    mkdirSync(bin2, { recursive: true })
    symlinkSync(join(bin2, "does-not-exist"), join(bin2, "claude"))
    expect(resolvePath("claude-code", { PATH: "", HOME: home2 })).toBeNull()
  })

  test("path-bearing name is checked directly (backwards compat with resolveBinary)", () => {
    const dir = tempDir("resolve-abs-")
    const full = writeShim(dir, "claude")
    expect(resolvePath(full, { PATH: "" })).toBe(full)
    expect(resolvePath("/nonexistent/claude", { PATH: "" })).toBeNull()
  })
})

d("lookup: Info.path stays PATH/override-only (no well-known fallback)", () => {
  test("binary only in well-known dir → lookup not installed, resolvePath installed", () => {
    const home = tempDir("resolve-home-")
    writeShim(join(home, ".local", "bin"), "claude")
    const info = lookup("claude-code", { PATH: "", HOME: home })
    expect(info.installed).toBe(false)
    expect(info.path).toBe("")
    // ...but the full chain resolves it.
    expect(resolvePath("claude-code", { PATH: "", HOME: home })).not.toBeNull()
  })

  test("threads env override through", () => {
    const dir = tempDir("resolve-ovr-")
    const full = writeShim(dir, "my-claude")
    const info = lookup("claude-code", { HARNESS_BINARY_CLAUDE_CODE: full, PATH: "" })
    expect(info.installed).toBe(true)
    expect(info.path).toBe(full)
  })

  test("unknown harness + env override → path populated, harness empty", () => {
    const dir = tempDir("resolve-ovr-")
    const full = writeShim(dir, "xyzzy")
    const info = lookup("xyzzy", { HARNESS_BINARY_XYZZY: full, PATH: "" })
    expect(info.harness).toBe("")
    expect(info.installed).toBe(true)
    expect(info.path).toBe(full)
  })
})
