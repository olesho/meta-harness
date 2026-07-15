// Live "call us back" check against the INSTALLED claude binary — the durable
// guard against AskUserQuestion dialog drift. The fake-harness twin
// (test/chat/question.test.ts) replays the recorded 2.1.210 shapes; only this
// test can notice a new Claude Code build changing the dialog's glyphs, key
// handling, or submit flow. Opt-in and skipped by default:
//
//   LIVE_CLAUDE=1 npx vitest run test/chat/live_question.test.ts
//
// The prompt explicitly instructs the model to call the AskUserQuestion tool,
// then the test: (1) asserts the turn does NOT complete but surfaces an
// EventInputRequest of kind "question" with the requested options, (2) answers
// via the public answer() API, and (3) asserts the turn then completes with a
// reply reflecting the chosen option — the full stopped-on-a-question →
// read-question → respond → resume contract.

import { afterEach, describe, expect, test } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  EventInputRequest,
  EventInputResolved,
  EventTurn,
  Open,
  RoleAssistant,
  TurnStateComplete,
  TurnStateErrored,
  cleanHarnessEnv,
  newMemStore,
  type Conversation,
  type ConversationEvent,
  type InputAnswer,
  type Turn,
} from "../../src/chat/index.ts"
import { Context } from "../../src/internal/async/index.ts"
import { AutoAcceptTrust } from "../../src/oneshot/index.ts"

const live = process.env.LIVE_CLAUDE === "1"
const BIN = process.env.LIVE_CLAUDE_BIN ?? "claude"

const TEST_TIMEOUT = 300_000
const CTX_DEADLINE = TEST_TIMEOUT - 15_000

const QUESTION = "Which color should I use?"
const PROMPT =
  `Use the AskUserQuestion tool to ask me exactly one question. ` +
  `The question text must be "${QUESTION}" with header "Color" and exactly ` +
  `two options labeled "Red" and "Blue". After I answer, reply with exactly: ` +
  `CHOSEN: <the answer> — and end your turn.`

describe.skipIf(!live)("live claude question round trip", () => {
  const dirs: string[] = []
  const convs: Conversation[] = []

  afterEach(async () => {
    for (const conv of convs) {
      const { ctx } = Context.withDeadline(Context.background(), 5000)
      await conv.close(ctx).catch(() => {})
    }
    convs.length = 0
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
    dirs.length = 0
  })

  async function openLive(ctx: Context): Promise<Conversation> {
    const dir = mkdtempSync(join(tmpdir(), "mh-live-question-"))
    dirs.push(dir)
    const conv = await Open(ctx, {
      harness: "claude-code",
      binaryPath: BIN,
      workingDir: dir,
      env: cleanHarnessEnv(),
      store: newMemStore(),
      inputPolicy: AutoAcceptTrust,
    })
    convs.push(conv)
    return conv
  }

  /** Drains events, answering surfaced requests via `respond`, until the turn ends. */
  async function drive(
    ctx: Context,
    conv: Conversation,
    respond: (ev: ConversationEvent) => InputAnswer | null | Promise<InputAnswer | null>,
  ): Promise<{ turn: Turn; requests: ConversationEvent[] }> {
    const bus = conv.events()
    const requests: ConversationEvent[] = []
    for (;;) {
      const next = (async () => {
        const { value, ok } = await bus.receive()
        if (!ok) throw new Error("event channel closed before a terminal turn")
        return value!
      })()
      const ev = await Promise.race([
        next,
        ctx.done().then(() => {
          throw ctx.err() ?? new Error("context done")
        }),
      ])
      if (ev.type === EventInputRequest) {
        requests.push(ev)
        const ans = await respond(ev)
        if (ans) {
          const release = await conv.acquireControl(ctx)
          try {
            await conv.answer(ctx, ev.input!.id, ans)
          } finally {
            release()
          }
        }
        continue
      }
      if (ev.type === EventInputResolved) continue
      if (
        ev.type === EventTurn &&
        ev.turn?.role === RoleAssistant &&
        (ev.turn.state === TurnStateComplete || ev.turn.state === TurnStateErrored)
      ) {
        return { turn: ev.turn, requests }
      }
    }
  }

  test(
    "question surfaces, option answer resumes the turn",
    { timeout: TEST_TIMEOUT },
    async () => {
      const { ctx, cancel } = Context.withDeadline(Context.background(), CTX_DEADLINE)
      try {
        const conv = await openLive(ctx)
        const release = await conv.acquireControl(ctx)
        try {
          await conv.send(ctx, PROMPT)
        } finally {
          release()
        }

        const { turn, requests } = await drive(ctx, conv, (ev) =>
          ev.input!.kind === "question" ? { optionID: "Blue" } : null,
        )

        const questions = requests.filter((r) => r.input!.kind === "question")
        expect(questions.length).toBe(1)
        const req = questions[0]!.input!
        expect(req.prompt).toContain(QUESTION)
        const labels = req.options!.map((o) => o.label)
        expect(labels).toContain("Red")
        expect(labels).toContain("Blue")

        expect(turn.state).toBe(TurnStateComplete)
        expect(turn.text).toContain("CHOSEN: Blue")

        // pendingInput drained back to null once the dialog resolved.
        expect(conv.pendingInput()).toBeNull()
      } finally {
        cancel()
      }
    },
  )

  test(
    "free-text answer: decline via the other option, then send the text",
    { timeout: TEST_TIMEOUT },
    async () => {
      const { ctx, cancel } = Context.withDeadline(Context.background(), CTX_DEADLINE)
      try {
        const conv = await openLive(ctx)
        const release = await conv.acquireControl(ctx)
        try {
          await conv.send(ctx, PROMPT)
        } finally {
          release()
        }

        // Selecting the UI's "Type something." affordance (alias "other")
        // declines the structured question: the dialog closes and the TURN
        // ENDS (verified live on 2.1.210 — the tool reports "User declined to
        // answer questions" and control returns to the composer). The typed
        // answer then goes in as the next ordinary message.
        const first = await drive(ctx, conv, (ev) =>
          ev.input!.kind === "question" ? { optionID: "other" } : null,
        )
        expect(first.turn.state).toBe(TurnStateComplete)

        const release2 = await conv.acquireControl(ctx)
        try {
          await conv.send(ctx, "Turquoise")
        } finally {
          release2()
        }
        const second = await drive(ctx, conv, () => null)
        expect(second.turn.state).toBe(TurnStateComplete)
        expect(second.turn.text).toContain("CHOSEN: Turquoise")
      } finally {
        cancel()
      }
    },
  )
})
