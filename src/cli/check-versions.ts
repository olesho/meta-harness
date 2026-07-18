#!/usr/bin/env node
// meta-harness `check-versions` CLI — the registry-drift gate.
//
// A THIN shell over the sentry library (src/drift/sentry.ts): it checks each
// pinned harness version against the npm registry's `latest` and maps the
// outcome to a deliberate exit-code contract.
//
// EXIT-CODE CONTRACT (the whole gate contract):
//   0 — all match / unpinned
//   2 — drift detected (a pinned version differs from npm latest)
//   1 — probe/network/parse error (registry unreachable, 404, unparseable body)
//
// This is DELIBERATELY a different scheme from the 0/1/2/124 turnproto codes the
// `run` CLI (src/cli/run.ts) uses — do not conflate them.

import { pathToFileURL } from "node:url";

import {
  checkAll,
  hasDrift,
  errFetch,
  errParse,
  type Row,
} from "../drift/sentry.ts";
import { isSentinel } from "../internal/async/index.ts";

export const ExitOK = 0;
export const ExitError = 1;
export const ExitDrift = 2;

/** Render one row as a single human-readable status line. */
function formatRow(r: Row): string {
  switch (r.status) {
    case "match":
      return `  ok       ${r.name} (${r.package}) pinned ${r.pinned} == latest`;
    case "drift":
      return `  DRIFT    ${r.name} (${r.package}) pinned ${r.pinned} != latest ${r.latest}`;
    case "unpinned":
      return `  unpinned ${r.name} (${r.package}) — skipped`;
  }
}

export async function main(): Promise<number> {
  let rows: Row[];
  try {
    rows = await checkAll();
  } catch (err) {
    if (isSentinel(err, errFetch) || isSentinel(err, errParse)) {
      process.stderr.write(
        "check-versions: registry probe failed: " +
          (err instanceof Error ? err.message : String(err)) +
          "\n",
      );
      return ExitError;
    }
    process.stderr.write(
      "check-versions: " +
        (err instanceof Error ? err.message : String(err)) +
        "\n",
    );
    return ExitError;
  }

  for (const r of rows) {
    process.stdout.write(formatRow(r) + "\n");
  }

  if (hasDrift(rows)) {
    process.stderr.write("check-versions: registry drift detected\n");
    return ExitDrift;
  }
  return ExitOK;
}

// Entry point — only when executed directly (not when imported by tests).
// Mirrors run.ts / structured-runner.ts: import.meta.main is Node ≥24.2 only.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write("check-versions: fatal: " + String(err) + "\n");
      process.exit(ExitError);
    },
  );
}
