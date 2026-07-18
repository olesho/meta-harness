// Live conformance suite for the registry-drift sentry (src/drift/sentry.ts).
// Unlike sentry.test.ts — which mocks the Node global `fetch` and never leaves
// the process — this suite drives the sentry against the REAL npm registry, so
// it catches wiring rot the mocks can't: a scoped-name encoding regression, a
// registry response-shape change, a fetch that silently 404s and masquerades as
// drift. It mirrors the Go source-of-truth `pkg/harness/conformance_test.go`
// (live tests vs real binaries, gated by HARNESS_WRAPPER_CONFORMANCE=1).
//
// Opt-in and skipped by default (needs network + a live registry):
//
//   META_HARNESS_CONFORMANCE=1 vitest run test/drift/conformance.test.ts
//
// The assertions are deliberately about the STATE MACHINE, not about which
// version is latest today (upstream versions move constantly): every pinned
// harness must classify to `match` or `drift` — never an error/sentinel on a
// healthy fetch — and the unpinned harness (opencode) must resolve to the
// `unpinned` skip state without ever hitting the network.

import { describe, expect, test } from "vitest";

import {
  checkAll,
  checkEntry,
  type Row,
  type Status,
} from "../../src/drift/sentry.ts";
import { all } from "../../src/versions/index.ts";

const live = process.env.META_HARNESS_CONFORMANCE === "1";

// Live registry round-trips can be slow; give each ample headroom.
const TEST_TIMEOUT = 60_000;

const STATUSES: readonly Status[] = ["match", "drift", "unpinned"];

/** Asserts a Row is well-formed and internally consistent for its state. */
function expectWellFormedRow(row: Row, name: string, pkg: string): void {
  expect(row.name).toBe(name);
  expect(row.package).toBe(pkg);
  expect(STATUSES).toContain(row.status);

  if (row.status === "unpinned") {
    // Never fetched, so `latest` stays undefined and `pinned` is empty.
    expect(row.pinned).toBe("");
    expect(row.latest).toBeUndefined();
    return;
  }

  // Pinned rows carry a non-empty pin AND a fetched `latest`, and the status is
  // exactly the string-equality verdict between them.
  expect(row.pinned).not.toBe("");
  expect(typeof row.latest).toBe("string");
  expect(row.latest).not.toBe("");
  expect(row.status).toBe(row.latest === row.pinned ? "match" : "drift");
}

describe.skipIf(!live)(
  "registry-drift live conformance (META_HARNESS_CONFORMANCE=1)",
  () => {
    test(
      "checkEntry classifies each pinned harness as match|drift against the live registry",
      async () => {
        for (const [name, entry] of all()) {
          if (entry.pinned === "") continue; // covered by the unpinned case below
          const row = await checkEntry(name, entry.package, entry.pinned);
          expectWellFormedRow(row, name, entry.package);
          // A healthy fetch must never surface as an error/sentinel: the row's
          // status is one of the two pinned verdicts, never `unpinned`.
          expect(["match", "drift"]).toContain(row.status);
          expect(row.latest).toBeTruthy();
        }
      },
      TEST_TIMEOUT,
    );

    test(
      "opencode is unpinned and resolves to the unpinned skip state without a fetch",
      async () => {
        const entries = new Map(all());
        const opencode = entries.get("opencode");
        expect(opencode).toBeDefined();
        expect(opencode!.pinned).toBe("");

        const row = await checkEntry(
          "opencode",
          opencode!.package,
          opencode!.pinned,
        );
        expect(row.status).toBe("unpinned");
        expectWellFormedRow(row, "opencode", opencode!.package);
      },
      TEST_TIMEOUT,
    );

    test(
      "checkAll drives the whole embedded catalog against the live registry",
      async () => {
        const rows = await checkAll();

        // One row per catalog entry, and every one well-formed for its state.
        const entries = new Map(all());
        expect(rows.length).toBe(entries.size);
        for (const row of rows) {
          const entry = entries.get(row.name);
          expect(entry).toBeDefined();
          expectWellFormedRow(row, row.name, entry!.package);
        }

        // Every pinned harness resolved to a real match|drift verdict (no error
        // slipped through as a bogus `unpinned`), and opencode stayed unpinned.
        for (const [name, entry] of entries) {
          const row = rows.find((r) => r.name === name)!;
          if (entry.pinned === "") {
            expect(row.status).toBe("unpinned");
          } else {
            expect(["match", "drift"]).toContain(row.status);
          }
        }
      },
      TEST_TIMEOUT,
    );
  },
);
