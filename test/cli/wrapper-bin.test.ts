// Dedicated assertion that the `meta-harness-wrapper` bin resolves to a BUILT
// dist artifact and that `npm run build` regenerates it. verify-exports.mjs
// only iterates pkg.exports and never inspects pkg.bin, so the new bin entry
// would otherwise go unvalidated (see task META-HARNESS-97; modeled directly
// on test/cli/hooks-bin.test.ts, the established per-binary precedent).
//
// Accepted cost: like hooks-bin.test.ts, this test runs its own full
// `npm run build` under a 180s timeout. With both per-binary tests present the
// suite now performs TWO independent full builds in CI. That is the standard
// per-binary pattern here — accepted deliberately, not an accidental
// regression.

import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const BIN_NAME = "meta-harness-wrapper";
const BIN_REL = "./dist/cli/wrapper.js";

describe("meta-harness-wrapper bin resolution", () => {
  test("package.json bin points at the built dist/cli/wrapper.js", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    ) as {
      bin?: Record<string, string>;
    };
    expect(pkg.bin?.[BIN_NAME]).toBe(BIN_REL);
    // Its compiled source must exist to compile to that dist path.
    expect(existsSync(path.join(root, "src", "cli", "wrapper.ts"))).toBe(true);
  });

  test("npm run build regenerates dist/cli/wrapper.js", () => {
    const distFile = path.join(root, "dist", "cli", "wrapper.js");
    // Prove regeneration: remove it, rebuild, assert it came back.
    rmSync(distFile, { force: true });
    execFileSync("npm", ["run", "build"], { cwd: root, stdio: "pipe" });
    expect(existsSync(distFile)).toBe(true);
    // The dist entry is executable JS (has the shebang from the source).
    expect(
      readFileSync(distFile, "utf8").startsWith("#!/usr/bin/env node"),
    ).toBe(true);
  }, 180_000);
});
