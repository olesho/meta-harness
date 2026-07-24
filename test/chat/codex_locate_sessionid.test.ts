// Guarded disk-fallback session-id recovery for Codex (META-HARNESS-83).
//
// CodexAdapter.locateSessionID is a race-free backstop for a Codex build whose
// /status scrape yields nothing but which still writes a session_meta rollout.
// The chat layer consults it ONLY on the codex first-write path, and ONLY once
// the prime recorded `written_uncaptured` (the /status keys were written but the
// box never yielded an id). These tests pin:
//   - the delegation goes through CodexReader.resolveRoot() (not the bare
//     locateLatestSession, which is a production no-op on sessionsRoot === "");
//   - the fallback fires on `written_uncaptured` and captures + persists;
//   - the `written_uncaptured` gate — not the mere presence of a rollout —
//     controls firing (too_narrow / not_written do not consult disk);
//   - the primeSessionID discriminator stays `written_uncaptured` (scrape-only),
//     never mis-flipping to `persist_failed` when a rollout is already on disk;
//   - a stale sibling rollout in the same cwd is not captured over the current
//     (newer-mtime) session;
//   - empty / no-match returns ["", false] without throwing.
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "../../src/chat/conversation.ts";
import { newMemStore } from "../../src/chat/memstore.ts";
import { newScreen, type Screen } from "../../src/screen/index.ts";
import { codex } from "../../src/turns/index.ts";
import { Context } from "../../src/internal/async/index.ts";
import { type Session } from "../../src/chat/types.ts";
import { writeCodexRollout } from "./helpers.ts";

const tmps: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const READY = "Codex\r\n\r\n› \r\n";

function primeOutcomeOf(c: Conversation): string | undefined {
  return (c as unknown as { primeOutcome?: string }).primeOutcome;
}

interface Built {
  c: Conversation;
  scr: Screen;
  store: ReturnType<typeof newMemStore>;
  sess: Session;
  sent: string[];
}

// build wires a codex Conversation with a real screen, an injected writeStdin
// that never renders the /status box (so the scrape always misses and only the
// disk fallback can capture), and an injected sessionsRoot + workingDir.
async function build(opts: {
  sessionsRoot: string;
  workingDir: string;
  cols?: number;
  primeBound?: number;
}): Promise<Built> {
  const scr = newScreen(opts.cols ?? 120, 40);
  const store = newMemStore();
  const adapter = codex.New();
  adapter.sessionsRoot = opts.sessionsRoot;
  const sess: Session = {
    id: "locate-" + Math.floor(performance.now() * 1000),
    harness: "codex",
    workingDir: opts.workingDir,
    createdAt: new Date(),
    harnessSessionID: "",
  };
  const sent: string[] = [];
  const c = new Conversation({
    opts: {
      harness: "codex",
      cols: opts.cols ?? 120,
      rows: 40,
      primeBound: opts.primeBound ?? 120,
      workingDir: opts.workingDir,
    },
    adapter,
    screen: scr,
    store,
    session: { ...sess },
    // Records /status but never renders the box: the scrape stays empty so any
    // capture must come from the disk fallback.
    writeStdin: (p) => void sent.push(new TextDecoder().decode(p)),
  });
  await store.createSession({ ...sess });
  return { c, scr, store, sess, sent };
}

describe("codex locateSessionID adapter", () => {
  test('empty workingDir returns ["", false] without throwing', () => {
    const adapter = codex.New();
    adapter.sessionsRoot = tempDir("locate-empty-");
    expect(adapter.locateSessionID("")).toEqual(["", false]);
  });

  test('no matching rollout returns ["", false]', () => {
    const sessionsRoot = tempDir("locate-nomatch-");
    const cwd = tempDir("locate-cwd-");
    writeCodexRollout(
      sessionsRoot,
      "019f0a01-0000-7013-a43a-00000000a001",
      cwd,
    );
    const adapter = codex.New();
    adapter.sessionsRoot = sessionsRoot;
    // A DIFFERENT working dir → no rollout matches.
    expect(adapter.locateSessionID(tempDir("locate-other-"))).toEqual([
      "",
      false,
    ]);
  });

  test("production path: delegation resolves the sessions root via CodexReader", () => {
    // sessionsRoot === "" (the production default). The bare locateLatestSession
    // would readdirSync("") and no-op; going through CodexReader.resolveRoot()
    // resolves the real sessions root, which we point at a temp dir.
    //
    // We drive resolveRoot's $CODEX_HOME rung, NOT its homedir() fallback: under
    // Bun on macOS, os.homedir() reads the passwd database and ignores a
    // reassigned process.env.HOME, so a HOME-based sandbox silently resolves to
    // the developer's real ~/.codex/sessions (which has no rollout for this temp
    // cwd) and the assertion returns ["", false] — non-hermetic and macOS-red.
    // CODEX_HOME is a plain env var resolveRoot reads directly
    // (src/transcript/codex/codex.ts:85), so it sandboxes reliably on every
    // runtime. resolveRoot's homedir() path composition is covered separately by
    // test/transcript/codex/codex.test.ts.
    const codexHome = tempDir("locate-codexhome-");
    const cwd = tempDir("locate-home-cwd-");
    const uuid = "019f0b02-0000-7013-a43a-00000000b002";
    writeCodexRollout(join(codexHome, "sessions"), uuid, cwd);

    const adapter = codex.New(); // sessionsRoot stays "" — the production shape
    const savedCodexHome = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = codexHome;
      expect(adapter.locateSessionID(cwd)).toEqual([uuid, true]);
    } finally {
      if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = savedCodexHome;
    }
  });
});

describe("codex guarded disk fallback (chat layer)", () => {
  test("happy path: written_uncaptured → next TurnComplete captures via disk", async () => {
    const sessionsRoot = tempDir("fb-happy-root-");
    const cwd = tempDir("fb-happy-cwd-");
    const uuid = "019f0c03-0000-7013-a43a-00000000c003";
    writeCodexRollout(sessionsRoot, uuid, cwd);

    const { c, scr, store, sess } = await build({
      sessionsRoot,
      workingDir: cwd,
    });
    await scr.write(READY);
    // Prime: /status is written but the box never renders → written_uncaptured.
    await c["primeSessionID"](Context.background());
    expect(primeOutcomeOf(c)).toBe("written_uncaptured");
    expect(c.session.harnessSessionID).toBe(""); // fallback not consulted during prime

    // Next TurnComplete drives the first-write branch: scrape empty → disk hit.
    await c.maybeExtractSessionID();
    expect(c.session.harnessSessionID).toBe(uuid);
    expect((await store.getSession(sess.id)).harnessSessionID).toBe(uuid);
  });

  test("guard, not rollout presence, controls firing: too_narrow does not consult disk", async () => {
    const sessionsRoot = tempDir("fb-narrow-root-");
    const cwd = tempDir("fb-narrow-cwd-");
    writeCodexRollout(
      sessionsRoot,
      "019f0d04-0000-7013-a43a-00000000d004",
      cwd,
    );

    // cols < CODEX_STATUS_MIN_COLS → prime skips the write → too_narrow.
    const { c, scr } = await build({ sessionsRoot, workingDir: cwd, cols: 40 });
    await scr.write(READY);
    await c["primeSessionID"](Context.background());
    expect(primeOutcomeOf(c)).toBe("too_narrow");

    // A matching rollout exists on disk, but the gate is not armed → no capture.
    await c.maybeExtractSessionID();
    expect(c.session.harnessSessionID).toBe("");
  });

  test("guard, not rollout presence: not_written does not consult disk", async () => {
    const sessionsRoot = tempDir("fb-nowrite-root-");
    const cwd = tempDir("fb-nowrite-cwd-");
    writeCodexRollout(
      sessionsRoot,
      "019f0e05-0000-7013-a43a-00000000e005",
      cwd,
    );

    const { c, scr } = await build({
      sessionsRoot,
      workingDir: cwd,
      primeBound: 100,
    });
    // No "› " → composer never ready → prime skips the write → not_written.
    await scr.write("Codex starting…\r\n");
    await c["primeSessionID"](Context.background());
    expect(primeOutcomeOf(c)).toBe("not_written");

    await c.maybeExtractSessionID();
    expect(c.session.harnessSessionID).toBe("");
  });

  test("discriminator stays written_uncaptured (scrape-only) even with a rollout on disk", async () => {
    // Direct regression guard for extractSessionID(false) at the persist_failed
    // vs written_uncaptured discriminator: a matching rollout is on disk, but the
    // /status box never rendered. If the discriminator leaked the disk fallback,
    // `parsed` would be true and the outcome would flip to persist_failed — which
    // is NOT in the firing gate set, silently disabling the fallback forever.
    const sessionsRoot = tempDir("fb-disc-root-");
    const cwd = tempDir("fb-disc-cwd-");
    writeCodexRollout(
      sessionsRoot,
      "019f0f06-0000-7013-a43a-00000000f006",
      cwd,
    );

    const { c, scr } = await build({ sessionsRoot, workingDir: cwd });
    await scr.write(READY);
    await c["primeSessionID"](Context.background());
    expect(primeOutcomeOf(c)).toBe("written_uncaptured");
  });

  test("cross-session race: the current (newer-mtime) rollout wins over a stale sibling", async () => {
    // Two rollouts share the SAME cwd — a stale/foreign one and the current one.
    // The fallback must not silently capture the sibling: locateLatestSession
    // returns the most-recently-modified rollout, and the live session's rollout
    // (still being appended) is the newest, so the current id is captured.
    const sessionsRoot = tempDir("fb-race-root-");
    const cwd = tempDir("fb-race-cwd-");
    const staleUUID = "019f0011-0000-7013-a43a-000000000011";
    const currentUUID = "019f0022-0000-7013-a43a-000000000022";
    const staleFile = writeCodexRollout(sessionsRoot, staleUUID, cwd);
    const currentFile = writeCodexRollout(sessionsRoot, currentUUID, cwd);
    // Force distinct, deterministic mtimes: stale older, current newer.
    utimesSync(staleFile, new Date(1000), new Date(1000));
    utimesSync(currentFile, new Date(2000), new Date(2000));

    const { c, scr } = await build({ sessionsRoot, workingDir: cwd });
    await scr.write(READY);
    await c["primeSessionID"](Context.background());
    expect(primeOutcomeOf(c)).toBe("written_uncaptured");

    await c.maybeExtractSessionID();
    expect(c.session.harnessSessionID).toBe(currentUUID);
    expect(c.session.harnessSessionID).not.toBe(staleUUID);
  });

  test("no rollout: fallback returns empty, id stays unset, no throw", async () => {
    const sessionsRoot = tempDir("fb-none-root-");
    const cwd = tempDir("fb-none-cwd-");
    // No rollout written under sessionsRoot.
    const { c, scr } = await build({ sessionsRoot, workingDir: cwd });
    await scr.write(READY);
    await c["primeSessionID"](Context.background());
    expect(primeOutcomeOf(c)).toBe("written_uncaptured");

    await c.maybeExtractSessionID();
    expect(c.session.harnessSessionID).toBe("");
  });
});
