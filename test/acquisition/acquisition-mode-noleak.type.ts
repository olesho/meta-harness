// Type-level enforcement of the no-un-latched-Auto invariant (META-HARNESS-94).
//
// This file has NO runtime tests — it is deliberately named `*.type.ts` so the
// vitest glob (`test/**/*.test.ts`) skips it, while `tsc --noEmit` (tsconfig
// `include: ["test"]`) still typechecks it. The `@ts-expect-error` lines below
// are the LOAD-BEARING guard: each asserts the compiler REJECTS a spot where
// the request-only `auto` token would leak into the resolved event path. If a
// future change widened the resolved AcquisitionMode union to admit `"auto"`,
// these errors would vanish and `@ts-expect-error` would itself become an
// error — failing the typecheck loudly.

import type { AcquisitionMode } from "../../src/turns/index.ts";
import {
  AcquisitionModeAuto,
  describeAcquisitionMode,
} from "../../src/turns/index.ts";

// (a) describeAcquisitionMode renders only RESOLVED modes; passing the
//     request-only token must not compile. Its parameter/return stay the closed
//     "off" | "stream" | "hooks" union.
// @ts-expect-error — "auto" is not an AcquisitionMode; describe rejects it.
describeAcquisitionMode("auto");
// @ts-expect-error — the exported const carries the request-only literal too.
describeAcquisitionMode(AcquisitionModeAuto);

// (b) A binding typed as the resolved AcquisitionMode must not accept "auto":
//     the resolved union never carries the un-latched value.
// @ts-expect-error — "auto" is outside the resolved AcquisitionMode union.
const leaked: AcquisitionMode = "auto";
void leaked;
