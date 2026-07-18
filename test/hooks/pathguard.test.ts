import { describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PathEscapeError,
  isWithinBase,
  resolveWithinBase,
} from "../../src/hooks/pathguard.ts";
import { canonicalDir, cleanPosix } from "../../src/transcript/pathutil.ts";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "mh-guard-"));
}

describe("resolveWithinBase (built on pathutil cleanPosix/canonicalDir)", () => {
  test("accepts a child path", () => {
    const base = tempDir();
    const canonBase = cleanPosix(canonicalDir(base));
    const child = path.join(base, "sub", "file.json");
    expect(resolveWithinBase(base, child)).toBe(`${canonBase}/sub/file.json`);
  });

  test("accepts a relative child and resolves it against base", () => {
    const base = tempDir();
    expect(resolveWithinBase(base, "sub/file.json")).toBe(
      `${cleanPosix(canonicalDir(base))}/sub/file.json`,
    );
  });

  test("accepts the base itself", () => {
    const base = tempDir();
    expect(resolveWithinBase(base, base)).toBe(cleanPosix(canonicalDir(base)));
  });

  test("rejects a ../ escape (relative)", () => {
    const base = tempDir();
    expect(() => resolveWithinBase(base, "../secret")).toThrow(PathEscapeError);
    expect(isWithinBase(base, "../secret")).toBe(false);
  });

  test("rejects a deep ../../ escape that lands outside base", () => {
    const base = path.join(tempDir(), "a", "b");
    mkdirSync(base, { recursive: true });
    expect(() => resolveWithinBase(base, "../../../../etc/passwd")).toThrow(
      PathEscapeError,
    );
  });

  test("rejects an absolute path outside base", () => {
    const base = tempDir();
    expect(() => resolveWithinBase(base, "/etc/passwd")).toThrow(
      PathEscapeError,
    );
  });

  test("rejects a symlink that escapes the base (EvalSymlinks analogue)", () => {
    const base = tempDir();
    const outside = tempDir();
    writeFileSync(path.join(outside, "secret"), "x");
    const link = path.join(base, "escape");
    symlinkSync(path.join(outside, "secret"), link);
    // Lexically `link` is within base, but canonicalDir resolves the symlink to
    // the outside target — the guard must reject it.
    expect(() => resolveWithinBase(base, link)).toThrow(PathEscapeError);
  });

  test("does not treat a sibling with a shared prefix as within base", () => {
    const parent = tempDir();
    const base = path.join(parent, "base");
    const sibling = path.join(parent, "base-evil");
    mkdirSync(base);
    mkdirSync(sibling);
    expect(() => resolveWithinBase(base, sibling)).toThrow(PathEscapeError);
  });
});
