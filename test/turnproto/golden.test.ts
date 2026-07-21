// §10 Tier-5 protocol freeze — the CLI RE-EXPORT IDENTITY half only.
//
// SUPERSEDED (META-HARNESS-91): the exit-constant/DeadlineLine literals and the
// StructuredTurnResult key+type schema this file used to freeze are now frozen
// by the shared cross-language WIRE corpus and its consumer,
// test/wire_corpus.test.ts (asserted from fixtures both repos vendor — the
// cross-repo source of truth). Keeping a second in-repo freeze here would give
// two points that can drift in what they assert, so this file retains ONLY what
// the corpus cannot cover: that both CLIs re-export the SAME constant objects as
// src/turnproto (no hand-synced copy can drift).

import { describe, expect, test } from "vitest";

import {
  DeadlineLine,
  ExitDeadline,
  ExitError,
  ExitOK,
  ExitUsage,
} from "../../src/turnproto/index.ts";

// The CLIs re-export from turnproto; assert they resolve to the SAME literals so
// no hand-synced copy can drift (acceptance: ONE source of truth).
import * as runCli from "../../src/cli/run.ts";
import * as structuredCli from "../../src/cli/structured-runner.ts";

describe("CLI re-export identity (constants are not hand-copied)", () => {
  test("both CLIs re-export the SAME constants as src/turnproto", () => {
    for (const cli of [runCli, structuredCli]) {
      expect(cli.ExitOK).toBe(ExitOK);
      expect(cli.ExitError).toBe(ExitError);
      expect(cli.ExitUsage).toBe(ExitUsage);
      expect(cli.ExitDeadline).toBe(ExitDeadline);
      expect(cli.DeadlineLine).toBe(DeadlineLine);
    }
  });
});
