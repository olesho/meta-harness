import { describe, expect, test } from "vitest"

import {
  EventOutputChunk,
  admitParent,
  isParentConversationKind,
} from "../../src/acquisition/internal/filter.ts"
import {
  AcquisitionModeHooks,
  AcquisitionModeOff,
  AcquisitionModeStream,
  type AcquisitionMode,
} from "../../src/turns/index.ts"
import {
  EventSessionMeta,
  EventText,
  EventToolResult,
  EventToolUse,
} from "../../src/transcript/index.ts"

const CONVERSATION_KINDS = [EventText, EventToolUse, EventToolResult, EventOutputChunk]
const NON_CONVERSATION_KINDS = [EventSessionMeta, "usage", "system", "totally-unknown-kind"]
const ALL_KINDS = [...CONVERSATION_KINDS, ...NON_CONVERSATION_KINDS]
const SOURCES: Array<"live" | "file"> = ["live", "file"]

describe("isParentConversationKind", () => {
  for (const k of CONVERSATION_KINDS) {
    test(`"${k}" is a conversation kind`, () => {
      expect(isParentConversationKind(k)).toBe(true)
    })
  }
  for (const k of NON_CONVERSATION_KINDS) {
    test(`"${k}" is NOT a conversation kind (unknown ⇒ non-conversation)`, () => {
      expect(isParentConversationKind(k)).toBe(false)
    })
  }
})

describe("admitParent decision table", () => {
  // Subagent events are admitted in EVERY mode/source/kind combination.
  const MODES: AcquisitionMode[] = [
    AcquisitionModeStream,
    AcquisitionModeHooks,
    AcquisitionModeOff,
    "bogus-mode" as AcquisitionMode,
  ]
  for (const mode of MODES) {
    for (const source of SOURCES) {
      for (const kind of ALL_KINDS) {
        test(`subagent admitted: mode=${mode} source=${source} kind=${kind}`, () => {
          expect(admitParent(mode, source, kind, true)).toBe(true)
        })
      }
    }
  }

  // Stream mode: live parent events admitted, file parent events dropped —
  // regardless of kind.
  for (const kind of ALL_KINDS) {
    test(`stream: live parent admitted (kind=${kind})`, () => {
      expect(admitParent(AcquisitionModeStream, "live", kind, false)).toBe(true)
    })
    test(`stream: file parent dropped (kind=${kind})`, () => {
      expect(admitParent(AcquisitionModeStream, "file", kind, false)).toBe(false)
    })
  }

  // Hooks mode: file parent always admitted; live parent admitted ONLY for
  // non-conversation kinds.
  for (const kind of ALL_KINDS) {
    test(`hooks: file parent admitted (kind=${kind})`, () => {
      expect(admitParent(AcquisitionModeHooks, "file", kind, false)).toBe(true)
    })
  }
  for (const kind of CONVERSATION_KINDS) {
    test(`hooks: live parent conversation kind dropped (kind=${kind})`, () => {
      expect(admitParent(AcquisitionModeHooks, "live", kind, false)).toBe(false)
    })
  }
  for (const kind of NON_CONVERSATION_KINDS) {
    test(`hooks: live parent non-conversation kind admitted (kind=${kind})`, () => {
      expect(admitParent(AcquisitionModeHooks, "live", kind, false)).toBe(true)
    })
  }

  // Off / unknown modes admit nothing for parent events.
  for (const source of SOURCES) {
    for (const kind of ALL_KINDS) {
      test(`off: parent dropped (source=${source} kind=${kind})`, () => {
        expect(admitParent(AcquisitionModeOff, source, kind, false)).toBe(false)
      })
      test(`unknown mode: parent dropped (source=${source} kind=${kind})`, () => {
        expect(admitParent("bogus-mode" as AcquisitionMode, source, kind, false)).toBe(false)
      })
    }
  }
})
