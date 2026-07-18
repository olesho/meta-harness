// Instantiate the Tier-2 conformance suite against the shipped local + none.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { local, none } from "../../src/env/index.ts";
import { runConformance } from "./conformance.ts";

runConformance({
  name: "local + none",
  makeProvisioner: () =>
    local({ root: mkdtempSync(join(tmpdir(), "conf-local-")) }),
  makeContainment: () => none(),
});
