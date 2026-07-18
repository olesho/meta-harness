// Port of pkg/turns/generic/generic_test.go.

import { describe, expect, test } from "vitest";
import * as generic from "../../src/turns/generic.ts";
import type { Kind } from "../../src/turns/index.ts";
import { Blocked, Errored, TurnComplete } from "../../src/turns/index.ts";
import {
  StatusBlockedByCost,
  StatusFailed,
  StatusIdle,
  StatusInterrupted,
  StatusRetryLater,
  StatusStale,
  StatusUnknown,
  StatusWaitingForInput,
  type Status,
} from "../../src/turns/index.ts";

describe("generic adapter", () => {
  test("OnWrapperStatus mapping", () => {
    const a = generic.New();
    const cases: { status: Status; want: Kind }[] = [
      { status: StatusWaitingForInput, want: TurnComplete },
      { status: StatusBlockedByCost, want: Blocked },
      { status: StatusRetryLater, want: Blocked },
      { status: StatusFailed, want: Errored },
      { status: StatusInterrupted, want: Errored },
      { status: StatusIdle, want: Errored },
    ];
    for (const tc of cases) {
      const evs = a.onWrapperStatus(tc.status, "reason");
      expect(evs.length).toBe(1);
      expect(evs[0].kind).toBe(tc.want);
    }
  });

  test("OnWrapperStatus ignores advisory statuses", () => {
    const a = generic.New();
    for (const s of [StatusStale, StatusUnknown, "" as Status]) {
      expect(a.onWrapperStatus(s, "").length).toBe(0);
    }
  });
});
