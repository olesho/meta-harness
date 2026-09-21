// Drift gate for the cross-repo sensitive-env-name contract.
//
// contract/sensitive-env-names.json is canonical; loomcli vendors it byte-identically
// at internal/driver/testdata/sensitive-env-names.json and gates its own literals
// against its copy. This suite is our half: it asserts CREDENTIAL_SENSITIVE_ENV_NAMES
// is exactly `runner_infra ++ provider_credentials`, that the probe still EMITS every
// one of them, and that contract/MANIFEST.sha256 is current — the same guard shape as
// test/chat/auth_corpus.test.ts. See contract/README.md and
// scripts/sync-sensitive-env-names.sh.
//
// This is an in-repo gate only: it cannot see loomcli's copy. Cross-repo divergence is
// caught by `scripts/sync-sensitive-env-names.sh --check` with $LOOMCLI_REPO set.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import {
  CREDENTIAL_SENSITIVE_ENV_NAMES,
  credentialLeakProbe,
} from "../../src/env-daytona/index.ts";

const contractRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../contract",
);
const artifact = "sensitive-env-names.json";

interface Contract {
  version: number;
  runner_infra: string[];
  provider_credentials: string[];
}

function readContract(): Contract {
  const path = join(contractRoot, artifact);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `cannot read the canonical contract at contract/${artifact} (${String(err)}). ` +
        `It is checked in; restore it, then run scripts/sync-sensitive-env-names.sh ` +
        `to refreeze contract/MANIFEST.sha256.`,
    );
  }
  try {
    return JSON.parse(raw) as Contract;
  } catch (err) {
    throw new Error(
      `contract/${artifact} is not valid JSON (${String(err)}). It is vendored ` +
        `byte-for-byte into loomcli — repair it here, then re-run ` +
        `scripts/sync-sensitive-env-names.sh --to $LOOMCLI_REPO.`,
    );
  }
}

const contract = readContract();
const union = [...contract.runner_infra, ...contract.provider_credentials];

describe("sensitive-env-name contract", () => {
  test("the artifact is well-formed", () => {
    expect(contract.version).toBe(1);
    expect(contract.runner_infra.length).toBeGreaterThan(0);
    expect(contract.provider_credentials.length).toBeGreaterThan(0);
  });

  test("no name appears in both roles", () => {
    const infra = new Set(contract.runner_infra);
    const dupes = contract.provider_credentials.filter((n) => infra.has(n));
    expect(dupes).toEqual([]);
  });

  test("no role lists a name twice", () => {
    expect(new Set(union).size).toBe(union.length);
  });

  // The split-on-"_" probe emitter is total only for names of this shape: at least
  // one segment, no leading/trailing/doubled underscore, no lowercase.
  test("every name is a plain SCREAMING_SNAKE identifier", () => {
    for (const name of union) {
      expect(name, `${name} is not a plain SCREAMING_SNAKE env name`).toMatch(
        /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/,
      );
    }
  });

  test("CREDENTIAL_SENSITIVE_ENV_NAMES is runner_infra ++ provider_credentials", () => {
    // Order-sensitive: the union order IS the literal's order, which is what keeps
    // this file and loomcli's sandboxLeakProbeCommand() diffable line-for-line.
    expect(CREDENTIAL_SENSITIVE_ENV_NAMES).toEqual(union);
  });

  // Catches a name being dropped from the EMITTED script rather than from the array
  // — mirror of loomcli's daytona-task-runner.test.mjs assertion, reconstructing the
  // parts-literal through the same shell escaping the probe applies.
  describe("credentialLeakProbe emits every name", () => {
    const cmd = credentialLeakProbe();
    const shellQuoteInner = (s: string): string => s.replace(/'/g, "'\\''");

    for (const name of union) {
      test(name, () => {
        const partsLiteral =
          "[" +
          name
            .split("_")
            .map((p) => `'${p}'`)
            .join(",") +
          "]";
        expect(
          cmd.includes(shellQuoteInner(partsLiteral)),
          `probe command must reference ${name} (${partsLiteral})`,
        ).toBe(true);
      });
    }

    // An EXTRA stray name in the probe fails too, not just a missing one.
    test("and emits no others", () => {
      const emitted = cmd.match(/\['[^\]]*'\]/g) ?? [];
      expect(emitted.length).toBe(union.length);
    });
  });

  // The drift guard: identical to scripts/sync-sensitive-env-names.sh --check. An
  // artifact edit that forgets to re-sync fails here.
  test("contract/MANIFEST.sha256 is current", () => {
    const want = readFileSync(join(contractRoot, "MANIFEST.sha256"), "utf8");
    const hash = createHash("sha256")
      .update(readFileSync(join(contractRoot, artifact)))
      .digest("hex");
    expect(`${hash}  ${artifact}\n`).toBe(want);
  });
});
