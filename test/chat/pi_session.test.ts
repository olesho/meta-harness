// Pi create + resume session support driven over the REAL fake-harness process.
// Create seeds a minted --session-id; Reopen resumes it via --session; the
// conflict guard rejects raw session-control flags before launch; and env-derived
// session dirs are honored by the reader (absolute and cwd-anchored relative).

import { afterEach, describe, expect, test } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Context, isSentinel } from "../../src/internal/async/index.ts"
import {
  Open,
  Reopen,
  ErrInvalidOptions,
  newMemStore,
  RoleAssistant,
  TurnStateComplete,
  type Conversation,
  type Session,
  type Turn,
} from "../../src/chat/index.ts"
import { slugForCwd } from "../../src/transcript/pi/pi.ts"
import {
  New,
  fakeHarnessBin,
  fakeLaunchEnv,
  openFake,
  testIdleGap,
  testMarkerGap,
} from "./fakeharness.ts"

const open = new Set<Conversation>()
afterEach(async () => {
  for (const conv of open) {
    const { ctx } = Context.withDeadline(Context.background(), 2000)
    await conv.close(ctx)
  }
  open.clear()
})
function track(conv: Conversation): Conversation {
  open.add(conv)
  return conv
}

function argvOutPath(): string {
  return join(mkdtempSync(join(tmpdir(), "pi-argv-")), "argv.json")
}

async function readArgv(path: string): Promise<string[]> {
  for (let i = 0; i < 100; i++) {
    try {
      return JSON.parse(readFileSync(path, "utf8"))
    } catch {
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  throw new Error(`argv dump never appeared at ${path}`)
}

const uuidRE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function piScript() {
  return New("pi").PiIdle().StayAliveUntilStopped().Build()
}

// Writes a pi-shaped session file for <id> under <sessionsDir>/<cwd-slug>/.
function writePiSession(sessionsDir: string, cwd: string, id: string): void {
  const dir = join(sessionsDir, slugForCwd(cwd))
  mkdirSync(dir, { recursive: true })
  const body = `{"type":"session","version":3,"id":"${id}","timestamp":"2024-12-03T14:00:00.000Z","cwd":"${cwd}"}
{"type":"message","id":"a","timestamp":"2024-12-03T14:00:01.000Z","message":{"role":"assistant","content":"restored reply"}}
`
  writeFileSync(join(dir, "20241203T140000_" + id + ".jsonl"), body)
}

describe("pi create/resume", () => {
  test("Open (create) seeds a minted --session-id", async () => {
    const store = newMemStore()
    const argvPath = argvOutPath()
    const conv = track(await openFake(piScript(), { store, argvOut: argvPath }))
    const argv = await readArgv(argvPath)
    expect(argv[0]).toBe("--session-id")
    expect(argv[1]).toMatch(uuidRE)
    const stored = await store.getSession(conv.sessionID())
    expect(stored.harnessSessionID).toBe(argv[1])
  })

  test("Reopen resumes via --session with the stored id", async () => {
    const store = newMemStore()
    const storedID = "chat-pi-reopen"
    const workingDir = mkdtempSync(join(tmpdir(), "pi-wd-"))
    const uuid = "0281fd4a-0a10-4dfe-adca-9b61b3777255"
    const session: Session = {
      id: storedID,
      harness: "pi",
      workingDir,
      createdAt: new Date(),
      harnessSessionID: uuid,
    }
    await store.createSession(session)

    const argvPath = argvOutPath()
    const conv = track(
      await Reopen(undefined, {
        sessionID: storedID,
        binaryPath: fakeHarnessBin,
        env: fakeLaunchEnv(piScript(), argvPath),
        store,
        cols: 120,
        rows: 40,
        idleGap: testIdleGap,
        markerGap: testMarkerGap,
      }),
    )
    expect(conv.sessionID()).toBe(storedID)
    const argv = await readArgv(argvPath)
    expect(argv.slice(0, 2)).toEqual(["--session", uuid])
  })

  test("early history falls back to store when transcript absent", async () => {
    const store = newMemStore()
    // A nonexistent session dir → ErrSessionNotFound → store fallback.
    const missing = join(mkdtempSync(join(tmpdir(), "pi-missing-")), "nope")
    const env = [
      ...fakeLaunchEnv(piScript()),
      `PI_CODING_AGENT_SESSION_DIR=${missing}`,
    ]
    const conv = track(
      await Open(undefined, {
        harness: "pi",
        binaryPath: fakeHarnessBin,
        env,
        store,
        cols: 120,
        rows: 40,
        idleGap: testIdleGap,
        markerGap: testMarkerGap,
      }),
    )
    const prior: Turn = {
      id: "t1",
      sessionID: conv.sessionID(),
      role: RoleAssistant,
      state: TurnStateComplete,
      text: "store-only reply",
      reason: "",
      startedAt: new Date(),
      completedAt: new Date(),
      httpCode: 0,
      retryAfter: 0,
    }
    await store.appendTurn(prior)
    const hist = await conv.history()
    expect(hist.map((t) => t.text)).toContain("store-only reply")
  })

  describe("conflict guard rejects session-control flags before launch", () => {
    const cases: Record<string, string[]> = {
      "--fork": ["--fork", "x"],
      "attached --session=": ["--session=abc"],
      "short -r": ["-r"],
      "--session-dir": ["--session-dir", "/tmp/x"],
    }
    for (const [name, args] of Object.entries(cases)) {
      test(name, async () => {
        const p = Open(undefined, {
          harness: "pi",
          binaryPath: fakeHarnessBin,
          store: newMemStore(),
          args,
        })
        await expect(p).rejects.toThrow()
        await p.catch((err) =>
          expect(isSentinel(err, ErrInvalidOptions)).toBe(true),
        )
      })
    }

    test("positional after -- is not rejected", async () => {
      const argvPath = argvOutPath()
      const conv = track(
        await openFake(piScript(), {
          store: newMemStore(),
          argvOut: argvPath,
          args: ["--", "--session"],
        }),
      )
      const argv = await readArgv(argvPath)
      expect(argv).toContain("--")
      expect(argv).toContain("--session")
      // create prefix still present.
      expect(argv[0]).toBe("--session-id")
    })
  })

  test("env session-dir agreement: absolute PI_CODING_AGENT_SESSION_DIR", async () => {
    const store = newMemStore()
    const sessionsDir = mkdtempSync(join(tmpdir(), "pi-sess-"))
    const workingDir = mkdtempSync(join(tmpdir(), "pi-wd-"))
    const env = [
      ...fakeLaunchEnv(piScript()),
      `PI_CODING_AGENT_SESSION_DIR=${sessionsDir}`,
    ]
    const conv = track(
      await Open(undefined, {
        harness: "pi",
        binaryPath: fakeHarnessBin,
        env,
        store,
        workingDir,
        cols: 120,
        rows: 40,
        idleGap: testIdleGap,
        markerGap: testMarkerGap,
      }),
    )
    const id = (await store.getSession(conv.sessionID())).harnessSessionID
    // Materialize a transcript at the minted id in the launch-declared dir.
    writePiSession(sessionsDir, workingDir, id)
    const hist = await conv.history()
    expect(hist.map((t) => t.text)).toContain("restored reply")
  })

  test("env session-dir agreement: relative dir anchored on child cwd", async () => {
    const store = newMemStore()
    const workingDir = mkdtempSync(join(tmpdir(), "pi-wd-"))
    const relDir = "pi-sessions"
    const env = [
      ...fakeLaunchEnv(piScript()),
      `PI_CODING_AGENT_SESSION_DIR=${relDir}`,
    ]
    const conv = track(
      await Open(undefined, {
        harness: "pi",
        binaryPath: fakeHarnessBin,
        env,
        store,
        workingDir,
        cols: 120,
        rows: 40,
        idleGap: testIdleGap,
        markerGap: testMarkerGap,
      }),
    )
    const id = (await store.getSession(conv.sessionID())).harnessSessionID
    writePiSession(join(workingDir, relDir), workingDir, id)
    const hist = await conv.history()
    expect(hist.map((t) => t.text)).toContain("restored reply")
  })
})
