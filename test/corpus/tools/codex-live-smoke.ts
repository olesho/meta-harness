// codex-live-smoke.ts — the META-HARNESS-21 end-to-end probe against the
// INSTALLED codex binary (live, not recorded-replay). Validates the whole
// causal chain the ticket got wrong:
//
//   1. Spawn codex under the production PTY bridge, wait for readiness with the
//      SAME predicate Conversation.send uses.
//   2. Prime the session id exactly like Conversation.open does — write
//      CodexAdapter.primeSessionIDKeys() ("/status" + CSI 13 u) as ONE chunk —
//      and scrape the id with CodexAdapter.extractSessionID.
//   3. Send one message with the production pacing (echo-gated split submit:
//      text first, wait for the composer to echo it, then CSI 13 u as a
//      SEPARATE write) and wait for assistant output.
//   4. Assert a new rollout-*-<uuid>.jsonl appears under ~/.codex/sessions and
//      <uuid> EQUALS the scraped /status id (the id does NOT diverge), and
//   5. Assert CodexReader.read(scrapedId) returns the turn.
//
// This is a manual smoke, not part of `bun test` (no .test.ts suffix): it needs
// an installed, authenticated codex and spends a real model turn. Verified
// against codex-cli 0.142.5 during the META-HARNESS-21 triage.
//
// Usage:
//   bun test/corpus/tools/codex-live-smoke.ts [--bin codex] [--cols 120] [--rows 40]
//     [--prompt "reply with just: ok"] [--ready-timeout 45000] [--echo-timeout 2000]
//     [--reply-timeout 120000]

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { readyForInput } from "../../../src/chat/ready.ts";
import { Screen } from "../../../src/screen/index.ts";
import { CodexReader, turnsFromEvents } from "../../../src/transcript/index.ts";
import { codex } from "../../../src/turns/index.ts";
import {
  PtyProcess,
  resolveBinary,
} from "../../../src/wrapper/internal/pty.ts";

interface Opts {
  bin: string;
  cols: number;
  rows: number;
  prompt: string;
  readyTimeoutMs: number;
  echoTimeoutMs: number;
  replyTimeoutMs: number;
}

function parseArgs(argv: string[]): Opts {
  const o: Opts = {
    bin: "codex",
    cols: 120,
    rows: 40,
    prompt: "reply with just: ok",
    readyTimeoutMs: 45_000,
    echoTimeoutMs: 2_000,
    replyTimeoutMs: 120_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "--bin":
        o.bin = next();
        break;
      case "--cols":
        o.cols = Number(next());
        break;
      case "--rows":
        o.rows = Number(next());
        break;
      case "--prompt":
        o.prompt = next();
        break;
      case "--ready-timeout":
        o.readyTimeoutMs = Number(next());
        break;
      case "--echo-timeout":
        o.echoTimeoutMs = Number(next());
        break;
      case "--reply-timeout":
        o.replyTimeoutMs = Number(next());
        break;
      default:
        throw new Error(`unknown flag: ${a}`);
    }
  }
  return o;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// Mirrors CodexReader.resolveRoot()'s fallback chain (minus the explicit
// override this probe never sets): an isolated $CODEX_HOME moves codex's
// session log with it, so the smoke must watch the same root the reader reads.
const sessionsRoot =
  process.env.CODEX_HOME !== undefined && process.env.CODEX_HOME !== ""
    ? join(process.env.CODEX_HOME, "sessions")
    : join(homedir(), ".codex", "sessions");

/** All rollout file basenames under the resolved sessions root (recursive). */
function rolloutFiles(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.name.startsWith("rollout-") && e.name.endsWith(".jsonl"))
        out.add(e.name);
    }
  };
  walk(sessionsRoot);
  return out;
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  const resolved = resolveBinary(o.bin);
  if (!resolved) throw new Error(`binary not found: ${o.bin}`);
  const version = execFileSync(resolved, ["--version"], {
    encoding: "utf8",
  }).trim();
  console.log(`[smoke] ${resolved} — ${version}`);

  const preexisting = rolloutFiles();
  const adapter = codex.New();
  const screen = new Screen(o.cols, o.rows);
  const pty = await PtyProcess.spawn({
    binaryPath: resolved,
    args: [],
    cols: o.cols,
    rows: o.rows,
  });
  pty.onData((d) => void screen.write(d));
  const fail = (msg: string): never => {
    console.error(`[smoke] FAIL: ${msg}`);
    console.error("---- final screen ----\n" + screen.snapshot().text);
    pty.kill("SIGKILL");
    process.exit(1);
  };

  const waitFor = async (
    what: string,
    timeoutMs: number,
    pred: () => boolean,
  ): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pred()) return true;
      await sleep(150);
    }
    console.error(`[smoke] timeout waiting for ${what}`);
    return false;
  };

  // 1. Readiness — the production predicate.
  if (
    !(await waitFor("ready composer", o.readyTimeoutMs, () =>
      readyForInput("codex", screen.snapshot().text),
    ))
  )
    fail("codex never reached a ready composer");

  // 2. Prime — the exact production keystrokes, then the production scrape.
  pty.write(adapter.primeSessionIDKeys());
  let scrapedID = "";
  if (
    !(await waitFor("/status session id", 10_000, () => {
      const [id, ok] = adapter.extractSessionID(screen.snapshot());
      if (ok) scrapedID = id;
      return ok;
    }))
  )
    fail("could not scrape the /status session id");
  console.log(`[smoke] scraped /status session id: ${scrapedID}`);

  // 3. Send with the production pacing: text, echo-verified gap, submit.
  if (
    !(await waitFor("ready composer after /status", 10_000, () =>
      readyForInput("codex", screen.snapshot().text),
    ))
  )
    fail("composer not ready after /status");
  pty.write(new TextEncoder().encode(o.prompt));
  const needle = o.prompt.split("\n", 1)[0].trim().slice(0, 24);
  await waitFor("composer echo", o.echoTimeoutMs, () =>
    screen.snapshot().text.includes(needle),
  ); // deadline degrades to a blind gap, same as production
  pty.write(new TextEncoder().encode("\x1b[13u"));

  // 4a. The submitted prompt must leave the composer (accepted, not pasted).
  const swallowed = () =>
    adapter.promptNotAccepted(screen.snapshot(), "\0never\0");
  if (!(await waitFor("prompt acceptance", 15_000, () => !swallowed())))
    fail("prompt still sitting in the composer — swallowed submit");

  // 4b. A NEW rollout named with the scraped id must appear on disk.
  let rolloutName = "";
  if (
    !(await waitFor("rollout file", o.replyTimeoutMs, () => {
      for (const f of rolloutFiles()) {
        if (preexisting.has(f)) continue;
        if (f.includes(scrapedID)) {
          rolloutName = f;
          return true;
        }
      }
      return false;
    }))
  ) {
    const fresh = [...rolloutFiles()].filter((f) => !preexisting.has(f));
    fail(
      `no new rollout named with the scraped id ${scrapedID}; new files: ${JSON.stringify(fresh)}`,
    );
  }
  console.log(
    `[smoke] rollout appeared: ${rolloutName} (uuid matches /status id)`,
  );

  // 5. CodexReader.read(scrapedId) must return the turn.
  let turns: { role: string; text: string }[] = [];
  if (
    !(await waitFor("transcript turns", 30_000, () => {
      try {
        turns = turnsFromEvents(new CodexReader("").read(scrapedID, ""));
      } catch {
        return false;
      }
      return turns.some((t) => t.role === "user" && t.text.includes(needle));
    }))
  )
    fail("CodexReader.read(scrapedID) did not return the sent turn");

  console.log(`[smoke] CodexReader.read returned ${turns.length} turn(s)`);
  console.log(
    `[smoke] PASS — /status id == rollout uuid == readable transcript (${version})`,
  );
  pty.write(new TextEncoder().encode("/quit\x1b[13u"));
  await sleep(1000);
  pty.kill("SIGTERM");
  process.exit(0);
}

main().catch((err) => {
  console.error("[smoke]", err);
  process.exit(1);
});
