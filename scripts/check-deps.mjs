// Assert the exact runtime-dependency SET in package.json.
//
// meta-harness pins its runtime `dependencies` to exactly two packages —
// @xterm/headless and node-pty (see src/cli/PACKAGING.md:28-45 for why node-pty
// carries two runtime requirements). That two-dependency convention was, until
// now, documented but unenforced: `verify-exports.mjs` only checks that each
// `exports` subpath LOADS under Node, never what `dependencies` contains, so a
// stray `semver` (or a swap) would sail past it. This is the missing gate.
//
//   node scripts/check-deps.mjs
//
// We assert the sorted SET deep-equals ["@xterm/headless", "node-pty"], NOT
// merely `length === 2`: a count check catches an addition (3rd key) but
// silently passes a size-preserving substitution (@xterm/headless -> got, still
// 2 keys), which breaks the invariant just as surely. Sorted deep-equal closes
// that swap hole.
//
// Exit 0 = deps are exactly the expected set; exit 1 = otherwise (prints which).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const expected = ["@xterm/headless", "node-pty"];
const actual = Object.keys(pkg.dependencies ?? {}).sort();

const matches =
  actual.length === expected.length &&
  actual.every((key, i) => key === expected[i]);

if (!matches) {
  console.error(
    `check-deps: runtime dependencies must be exactly ${JSON.stringify(expected)}, ` +
      `but package.json has ${JSON.stringify(actual)}`,
  );
  process.exit(1);
}

console.log(`check-deps: runtime dependencies are exactly ${JSON.stringify(expected)}`);
