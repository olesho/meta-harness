// Offline auth-corpus conformance — the TS half of the cross-language contract.
// Walks the shared, byte-identical corpus (test/corpus/auth, vendored from
// harness-wrapper) and asserts authRequired() agrees with every captured screen's
// expected verdict, plus that MANIFEST.sha256 is current. The Go repo runs the
// IDENTICAL corpus through pkg/chat/auth_corpus_test.go; the two repos are in sync
// iff their manifests match. See test/corpus/auth/README.md and
// scripts/sync-auth-corpus.sh.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { authRequired } from "../../src/chat/index.ts";

const corpusRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../corpus/auth",
);

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const rec = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) rec(p);
      else out.push(p);
    }
  };
  rec(root);
  return out;
}

interface Meta {
  harness: string;
  authRequired: boolean;
  state?: string;
}

// Normalize an absolute path to a forward-slashed path relative to the corpus
// root, so the manifest matches on every OS and byte-matches the bash generator.
const rel = (p: string): string => relative(corpusRoot, p).split(sep).join("/");

const cases = walkFiles(corpusRoot)
  .filter((p) => p.endsWith(`${sep}meta.json`))
  .map((metaPath) => {
    const dir = dirname(metaPath);
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Meta;
    const screen = readFileSync(join(dir, "screen.txt"), "utf8");
    return { name: rel(dir), meta, screen };
  })
  .sort((a, b) => (a.name < b.name ? -1 : 1));

describe("auth corpus conformance", () => {
  test("corpus is non-empty", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    test(`authRequired(${c.meta.harness}, ${c.name})`, () => {
      expect(authRequired(c.meta.harness, c.screen)).toBe(c.meta.authRequired);
    });
  }

  // The drift guard: identical to scripts/sync-auth-corpus.sh --check and Go's
  // TestAuthCorpusManifest. A fixture edit that forgets to re-sync fails here.
  test("MANIFEST.sha256 is current", () => {
    const want = readFileSync(join(corpusRoot, "MANIFEST.sha256"), "utf8");
    const lines = walkFiles(corpusRoot)
      .filter((p) => !p.endsWith(`${sep}MANIFEST.sha256`))
      .map((p) => ({
        rel: rel(p),
        hash: createHash("sha256").update(readFileSync(p)).digest("hex"),
      }))
      .sort((a, b) => (a.rel < b.rel ? -1 : 1))
      .map((e) => `${e.hash}  ${e.rel}`);
    expect(lines.join("\n") + "\n").toBe(want);
  });
});
