#!/usr/bin/env node
// Production build for Node consumers.
//
// 1. Compile src/** → dist/** (ESM + .d.ts) via tsconfig.build.json. tsc rewrites
//    the source's `.ts` import specifiers to `.js` (rewriteRelativeImportExtensions).
// 2. Copy the raw PTY bridge (ptyHost.mjs) next to its compiled importer so the
//    default `import.meta.url`-relative HOST resolution keeps working for the dist,
//    and so a consumer that copies dist/wrapper/internal/ has the bridge on hand.
//
// Bun consumers never hit dist — they import src/** directly via the `bun` export
// condition. This build is only for Node (loomcli's flue bundle + sandbox runner).

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

// Clean prior output so stale files never survive a rename/delete.
rmSync(dist, { recursive: true, force: true });

const tsc = join(root, "node_modules", ".bin", "tsc");
const res = spawnSync(tsc, ["-p", join(root, "tsconfig.build.json")], {
  cwd: root,
  stdio: "inherit",
});
if (res.status !== 0) {
  console.error("build: tsc failed");
  process.exit(res.status ?? 1);
}

// Assets tsc does not emit (a raw .mjs, not a .ts input): the PTY bridge.
const bridgeSrc = join(root, "src", "wrapper", "internal", "ptyHost.mjs");
const bridgeDstDir = join(dist, "wrapper", "internal");
mkdirSync(bridgeDstDir, { recursive: true });
cpSync(bridgeSrc, join(bridgeDstDir, "ptyHost.mjs"));

// versions.json: dist/versions/versions.js reads it `import.meta.url`-relative
// at module load, so without this copy `import("meta-harness/versions")`
// throws ENOENT under Node.
const versionsDstDir = join(dist, "versions");
mkdirSync(versionsDstDir, { recursive: true });
cpSync(
  join(root, "src", "versions", "versions.json"),
  join(versionsDstDir, "versions.json"),
);

// models.json: dist/discovery/models.js reads it `import.meta.url`-relative at
// module load (same pattern as versions.json), so copy it alongside.
const discoveryDstDir = join(dist, "discovery");
mkdirSync(discoveryDstDir, { recursive: true });
cpSync(
  join(root, "src", "discovery", "models.json"),
  join(discoveryDstDir, "models.json"),
);

console.log("build: dist ready");
