// Verify every public subpath export in package.json loads under plain Node.
//
// This is the migration's core promise (META-HARNESS-30/31/32: Bun -> Node):
// downstream consumers import the *built* `dist/**` over the `exports` map with
// `node`, never Bun. Orche does exactly this — `import('meta-harness/chat')`
// from `packages/agent` (see META-HARNESS-33). If any subpath's `import` target
// fails to load under Node, that consumer breaks, so we assert every one here.
//
// Requires the package's runtime deps to be installed first (the subpath entries
// pull in @xterm/headless, node-pty, ...) — i.e. run after `npm install` and
// `npm run build`, which is exactly the state a consumer/CI is in.
//
//   npm run build && node scripts/verify-exports.mjs
//
// Exit 0 = every subpath loaded; exit 1 = at least one failed (prints which).
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const targets = [];
for (const [subpath, entry] of Object.entries(pkg.exports ?? {})) {
  // The `import` condition is what Node's ESM resolver picks for consumers.
  const rel = typeof entry === "string" ? entry : entry.import;
  if (!rel) continue;
  targets.push({ subpath, rel });
}

if (targets.length === 0) {
  console.error(
    "verify-exports: package.json has no `exports` — nothing to check",
  );
  process.exit(1);
}

let failed = 0;
for (const { subpath, rel } of targets) {
  const spec =
    subpath === "." ? "meta-harness" : `meta-harness/${subpath.slice(2)}`;
  const url = pathToFileURL(join(root, rel)).href;
  try {
    const mod = await import(url);
    console.log(
      `OK  ${spec.padEnd(24)} ${Object.keys(mod).length} exports  (${rel})`,
    );
  } catch (err) {
    failed++;
    console.error(
      `ERR ${spec.padEnd(24)} ${err?.code ?? ""} ${err?.message ?? err}`,
    );
  }
}

if (failed) {
  console.error(
    `\nverify-exports: ${failed}/${targets.length} subpath(s) failed to load under Node`,
  );
  process.exit(1);
}
console.log(
  `\nverify-exports: all ${targets.length} public subpath exports load under Node`,
);
