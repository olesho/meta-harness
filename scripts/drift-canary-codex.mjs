// Single-harness registry-drift canary — pinned to `codex` (@openai/codex).
//
// This is the tightest single-harness drift signal. Out-of-scope Go-only
// harnesses have their own canary; this file scopes to the MH-relevant pinned
// harnesses. We pick `codex` because:
//   - It has the most frequently-moving upstream of the pinned three, so a drift
//     fires soonest — exercising the sentry's `match` -> `drift` transition
//     earliest of any pinned harness.
//   - Being scoped (`@openai/codex`), it exercises the sentry's
//     `encodeURIComponent` URL path (`%40openai%2Fcodex`) rather than the bare
//     name path.
// We deliberately do NOT canary `opencode` (unpinned `pinned: ""` — perpetual
// `unpinned`, no signal) or any harness absent from versions.json.
//
// Unlike the corpus rebake tooling, this canary runs against the EMBEDDED
// catalog via `all()` and needs no A5 screenbench recorder — so it lands and
// runs today.
//
// EXIT-CODE CONTRACT — identical to the check-versions gate (src/cli/check-versions.ts):
//   0 — codex matches npm `latest` (or is unpinned — never reached here)
//   2 — drift detected (pinned version differs from npm latest)
//   1 — probe/network/parse error (registry unreachable, 404, unparseable body)
//
//   npm run build && node scripts/drift-canary-codex.mjs
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// The sentry is tooling-only (not on the package `exports` map), so we import
// the built dist module by relative path, exactly as the check-versions bin does
// via `node dist/cli/check-versions.js`.
const { checkEntry, errFetch, errParse } = await import(
  pathToFileURL(join(root, "dist", "drift", "sentry.js")).href
);
const { all } = await import(
  pathToFileURL(join(root, "dist", "versions", "index.js")).href
);
const { isSentinel } = await import(
  pathToFileURL(join(root, "dist", "internal", "async", "index.js")).href
);

const CANARY = "codex";

const ExitOK = 0;
const ExitError = 1;
const ExitDrift = 2;

async function main() {
  const entry = all().get(CANARY);
  if (!entry) {
    process.stderr.write(
      `drift-canary: harness ${JSON.stringify(CANARY)} not found in versions.json\n`,
    );
    return ExitError;
  }

  let row;
  try {
    row = await checkEntry(CANARY, entry.package, entry.pinned);
  } catch (err) {
    if (isSentinel(err, errFetch) || isSentinel(err, errParse)) {
      process.stderr.write(
        "drift-canary: registry probe failed: " +
          (err instanceof Error ? err.message : String(err)) +
          "\n",
      );
      return ExitError;
    }
    process.stderr.write(
      "drift-canary: " + (err instanceof Error ? err.message : String(err)) + "\n",
    );
    return ExitError;
  }

  switch (row.status) {
    case "match":
      process.stdout.write(
        `  ok       ${row.name} (${row.package}) pinned ${row.pinned} == latest\n`,
      );
      return ExitOK;
    case "unpinned":
      // codex is pinned, so this is unreachable — but keep the contract exact.
      process.stdout.write(
        `  unpinned ${row.name} (${row.package}) — skipped\n`,
      );
      return ExitOK;
    case "drift":
      process.stdout.write(
        `  DRIFT    ${row.name} (${row.package}) pinned ${row.pinned} != latest ${row.latest}\n`,
      );
      process.stderr.write("drift-canary: registry drift detected for codex\n");
      return ExitDrift;
  }
  return ExitError;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write("drift-canary: fatal: " + String(err) + "\n");
    process.exit(ExitError);
  },
);
