// Out-of-scope closeout for the mid-session permission switch
// (META-HARNESS-106, closed by META-HARNESS-121).
//
// 106 ships `setPermissionMode()` and drives the COLLABORATION axis only. Four
// things it deliberately does NOT do were specified as "out of scope, asserted
// by absence" — an absence nothing in the type system or the TS surface golden
// can catch, because the failure mode is a NEW file/symbol appearing, not an
// existing one changing. This test is that assertion, in the shape
// test/acquisition/module-boundary.test.ts established for META-HARNESS-59.
//
// Each check and why it must keep failing loudly:
//
//   1. NOTHING WRITES ~/.codex/config.toml. Codex's `/permissions` dialog
//      persists its preset GLOBALLY — `approvals_reviewer = "auto_review"` was
//      observed leaking out of the session that set it and into a fresh,
//      unrelated one. 106 never touches that file. (The containment bar for
//      code that legitimately must — isolated CODEX_HOME, or snapshot-and-
//      restore — belongs to META-HARNESS-103 and is neither weakened nor
//      inherited here.)
//   2. NO `/permissions` DIALOG KEYSTROKES outside META-HARNESS-103. The
//      behavioural half — codex.AutoDismissKeys refusing to dismiss a
//      KindPermissions request — is already pinned by
//      test/turns/codex/input.test.ts and test/chat/codex_dismiss.test.ts.
//      What is pinned HERE is that no code path types the command at all.
//   3. ONE permission parser, in src/chat/permission.ts. Its one-line re-export
//      shim at src/discovery/permission.ts is the only other file allowed to
//      name it, and no second PermissionRung-shaped union may grow in the chat
//      layer. (META-HARNESS-100's wrapper-side value list in
//      src/wrapper/internal/permissionrungs.ts is a separate, legitimate
//      vocabulary — drift-guarded by the shared ladder tests, not by this one.)
//   4. NO `/plan` WRITE, NO `slashRefusedAnchor`, NO
//      `ErrPermissionModeRefusedBusy`. The `/plan` fallback is deferred out of
//      106; a sentinel no code path can raise would be dead public surface
//      frozen into the TS surface golden forever.
//
// Matching is deliberately on QUOTED STRING LITERALS ("..." / '...'), never on
// backticked text: every one of these subjects is discussed at length in JSDoc
// prose that uses `backticks`, and a scan that flagged prose would be deleted
// by the first person it annoyed rather than fixed.

import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

// Recorded terminal output under test/corpus/** is captured verbatim from real
// binaries: it quotes codex's own tips and dialogs, and is not code.
const SKIP_DIRS = new Set(["corpus", "node_modules", "dist", "__snapshots__"]);

// This file names every forbidden symbol in order to search for it.
const SELF = relative(root, fileURLToPath(import.meta.url));

// The containment bar this file's own docstring carves out: "code that
// legitimately must [name config.toml] — isolated CODEX_HOME, or snapshot-
// and-restore — belongs to META-HARNESS-103 and is neither weakened nor
// inherited here." seedIsolatedCodexHome (META-HARNESS-122, a 103 subtask) is
// exactly that code — it asserts a config.toml path is ABSENT from a seeded
// isolated home, which is the point of the helper, not a scope violation.
//
// fakeharness.ts's PermissionsCommandText and the test that exercises it
// (META-HARNESS-126, also a 103 subtask) are the "/permissions" analogue: the
// fake-harness scaffolding for setCodexPermissionPreset's driver has to type
// the literal command to give that driver something deterministic to script
// against. Test-only scaffolding, not a 106 code path.
//
// Check 2's own docstring makes the same carve-out for the `/permissions`
// command explicit ("outside META-HARNESS-103"): src/turns/harness/codex.ts's
// permissionsDialogKeys (META-HARNESS-125, a 103 subtask) is the capability
// seam that legitimately types it, gated by permissionsWriteContained — 106
// never touches it and this absence check is unaffected.
const EXEMPT = new Set([
  "test/helpers/codex_home.ts",
  "test/helpers/codex_home.test.ts",
  "test/chat/fakeharness.ts",
  "test/chat/fakeharness_permissions.test.ts",
  "src/turns/harness/codex.ts",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), out);
    } else if (e.name.endsWith(".ts") || e.name.endsWith(".mjs")) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

/** Every scanned source file, as [repo-relative path, contents]. */
const SOURCES: [string, string][] = [
  ...walk(join(root, "src")),
  ...walk(join(root, "test")),
]
  .map(
    (abs) =>
      [relative(root, abs).split(sep).join("/"), readFileSync(abs, "utf8")] as [
        string,
        string,
      ],
  )
  .filter(([rel]) => rel !== SELF.split(sep).join("/"))
  .filter(([rel]) => !EXEMPT.has(rel));

/** Repo-relative paths of every file whose source matches `re`. */
function hits(re: RegExp): string[] {
  return SOURCES.filter(([, src]) => re.test(src)).map(([rel]) => rel);
}

describe("META-HARNESS-106 out-of-scope absences", () => {
  test("the scan actually sees the tree it claims to", () => {
    // A walk that silently returned nothing would make every check below pass
    // vacuously — the one failure mode this whole file cannot otherwise detect.
    expect(SOURCES.length).toBeGreaterThan(100);
    expect(SOURCES.map(([rel]) => rel)).toContain("src/chat/permission.ts");
  });

  test("no code path names a config.toml path", () => {
    // A string literal that ENDS at config.toml — i.e. a path being built, as
    // opposed to the token appearing mid-sentence in a test name or a comment.
    expect(hits(/["'][^"'\n]*config\.toml["']/)).toEqual([]);
  });

  test("no code path types the /permissions command", () => {
    expect(hits(/["']\/permissions["']/)).toEqual([]);
  });

  test("no code path types the /plan command", () => {
    expect(hits(/["']\/plan(\\r|\\n)?["']/)).toEqual([]);
  });

  test("no slashRefusedAnchor symbol exists", () => {
    expect(hits(/\bslashRefusedAnchor\b/i)).toEqual([]);
  });

  test("no ErrPermissionModeRefusedBusy sentinel exists", () => {
    expect(hits(/\bErrPermissionModeRefusedBusy\b/)).toEqual([]);
  });

  test("exactly one permission parser, in the chat layer", () => {
    expect(hits(/export\s+function\s+parsePermissionMode\b/)).toEqual([
      "src/chat/permission.ts",
    ]);
    expect(hits(/export\s+type\s+PermissionRung\s*=/)).toEqual([
      "src/chat/permission.ts",
    ]);
  });

  test("src/discovery/permission.ts is a re-export shim and nothing more", () => {
    const shim = readFileSync(
      join(root, "src", "discovery", "permission.ts"),
      "utf8",
    );
    // Re-exports only: no declaration of its own may grow here, or the "one
    // parser" invariant above becomes true by name while false in substance.
    expect(shim).toMatch(/from\s+["']\.\.\/chat\/permission\.ts["']/);
    expect(shim).not.toMatch(/\b(function|class|interface|enum)\b/);
  });
});
