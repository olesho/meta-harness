// YieldControl + yield file + hookEnv — TS port of harness-wrapper's
// pkg/harness/yield.go and the hookEnv helper from pkg/harness/run.go.
//
// YieldControl is the caller's handle to request cooperative preemption of a
// running harness: it owns a private yield file, `request(reason)` writes it
// atomically, and the yield-guard PreToolUse hook checks it before each tool —
// sub-minute cooperative preemption for any hook-capable harness.

import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

// HW_* env var names — the orchestrator SETS them in the harness launch env; the
// in-process hook handler READS them. Names kept identical to the Go constants.
export const EnvSpool = "HW_EVENT_SPOOL"; // spool dir; absent ⇒ handler inert
export const EnvHookCwd = "HW_HOOK_CWD"; // harness working dir (worktree)
export const EnvHome = "HW_HOME"; // user home
// EnvYieldFile names the yield file in the harness launch env. The yield-guard
// hook checks it before each tool; when present it blocks the tool so the agent
// stops within a turn.
export const EnvYieldFile = "HW_YIELD_FILE";

/**
 * YieldControl allocates a private yield file under a fresh temp dir. The caller
 * owns the lifecycle and should `close()` it when the run is done. It is safe to
 * construct before the run and call `request`/`clear` while the run is in flight
 * (single filesystem ops).
 */
export class YieldControl {
  private readonly dir: string;
  private readonly path: string;

  constructor() {
    this.dir = mkdtempSync(path.join(tmpdir(), "hw-yield-"));
    this.path = path.join(this.dir, "yield.json");
  }

  /**
   * request signals a yield: the next tool the harness attempts is blocked, with
   * `reason` surfaced in the block message. Idempotent (re-requesting overwrites
   * the reason). Written atomically (temp file + rename) so the guard never reads
   * a partial file.
   */
  request(reason: string): void {
    const data = JSON.stringify({ reason });
    atomicWriteFile(this.path, data);
  }

  /** filePath is the yield file's path (wired into the harness env as HW_YIELD_FILE). */
  filePath(): string {
    return this.path;
  }

  /** clear cancels a pending yield (removes the file). A nonexistent file is fine. */
  clear(): void {
    rmSync(this.path, { force: true });
  }

  /** close removes the yield file and its temp dir. Safe to call more than once. */
  close(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/**
 * YieldOutcome directs the caller to BLOCK the tool: print `blockOutput` to
 * stdout and exit with the non-zero code the harness interprets as "block"
 * (Claude: exit 2). The zero value ({ block: false }) means proceed.
 */
export interface YieldOutcome {
  block: boolean;
  blockOutput: string;
}

/**
 * checkYield inspects the yield file and, if a yield was requested, returns a
 * blocking outcome carrying the harness's block-decision JSON. The protocol
 * (decision:block + exit 2) is the Claude shell-hook contract. No
 * file (or empty path) ⇒ no block ⇒ the tool proceeds.
 */
export function checkYield(yieldFile: string): YieldOutcome {
  if (!yieldFile) {
    return { block: false, blockOutput: "" };
  }
  let data: string;
  try {
    data = readFileSync(yieldFile, "utf8");
  } catch {
    return { block: false, blockOutput: "" }; // no file ⇒ no yield ⇒ tool proceeds
  }
  let reason = "unknown";
  try {
    const req = JSON.parse(data) as { reason?: string };
    if (req && typeof req.reason === "string" && req.reason !== "") {
      reason = req.reason;
    }
  } catch {
    // malformed ⇒ keep the "unknown" reason but still block (file present).
  }
  const blockOutput = JSON.stringify({
    decision: "block",
    reason: `Yield requested (${reason}) — please stop and exit immediately.`,
  });
  return { block: true, blockOutput };
}

/**
 * hookEnv augments the harness launch env array with the HW_* hook variables
 * (spool dir, hook cwd, home, and — when a YieldControl is present — the yield
 * file path). `base` is a "KEY=VALUE" string array (the env convention src/chat
 * uses); when null it is materialized from the current process environment.
 */
export function hookEnv(
  base: string[] | null,
  spoolDir: string,
  cwd: string,
  yieldControl?: YieldControl | null,
): string[] {
  const src = base ?? processEnvEntries();
  const out = [...src];
  out.push(`${EnvSpool}=${spoolDir}`);
  out.push(`${EnvHookCwd}=${cwd}`);
  out.push(`${EnvHome}=${homedir()}`);
  if (yieldControl) {
    out.push(`${EnvYieldFile}=${yieldControl.filePath()}`);
  }
  return out;
}

function processEnvEntries(): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    out.push(`${k}=${v}`);
  }
  return out;
}

// atomicWriteFile writes `data` durably: a uniquely-named temp file in the target
// directory, then a rename onto `path`, so a concurrent reader sees either the
// old file or the complete new one — never a partial write.
function atomicWriteFile(target: string, data: string): void {
  const tmp = `${target}.tmp-${process.pid}-${uniqueSuffix()}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  try {
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// uniqueSuffix returns a monotonically-increasing counter — a Date.now()-free
// source of temp-file name uniqueness within a process.
let counter = 0;
function uniqueSuffix(): number {
  counter += 1;
  return counter;
}
