// Host-side structured-turn client (design §7): drive ONE structured harness
// turn over any `Workspace` and parse the frozen protocol result back.
//
// The consolidation payoff — the exit codes, DeadlineLine, and result-schema
// type all come from the ONE src/turnproto module (no hand-synced copy). The
// prompt crosses via a TEMP-FILE upload (the `--prompt-file` transport), never
// argv, so a prompt with quotes/newlines/leading-dashes cannot corrupt the argv
// or any shell the workspace's transport interposes. The exec argv itself is a
// string[] handed to ws.exec — the env layer (compose/argv.ts `argvToShell`) owns
// the injection-safe quoting at the boundary, and the prompt is never a token.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Context } from "../async/index.ts";
import { encodedCWD } from "../transcript/index.ts";
import {
  ExitDeadline,
  ExitUsage,
  parseLastJSONLine,
  type StructuredTurnResult,
  type TurnStatus,
} from "../turnproto/index.ts";
import type { Workspace } from "./types.ts";

/** The guest bin invoked per turn; overridable for image-pinned paths. */
const DEFAULT_BINARY = "meta-harness-structured-run";

/** Inputs for one structured turn. The prompt is a plain string — it is written
 *  to a temp file and uploaded, NEVER placed on the argv. */
export interface TurnConfig {
  /** Short harness alias (claude → claude-code, codex → codex) or the full name. */
  harness: string;
  /** The prompt text (crosses via --prompt-file, never argv). */
  prompt: string;
  /** Reasoning effort forwarded to the harness. */
  effort?: string;
  /** Model forwarded to the harness. */
  model?: string;
  /** Extra args forwarded verbatim to the harness after `--`. */
  harnessArgs?: string[];
  /** Environment overlaid on the guest process. */
  env?: Record<string, string>;
  /** Guest working directory; defaults to the workspace's repo path. */
  cwd?: string;
  /** Override the guest bin name/path (default meta-harness-structured-run). */
  binary?: string;
  /** OPTIONAL out-of-band RAW-JSONL transcript retrieval to this HOST path.
   *  claude-code ONLY (see below); a codex turn REJECTS this rather than
   *  downloading from the wrong on-disk layout. */
  retrieveTranscriptTo?: string;
}

/** Thrown when stdout carries a payload the client cannot interpret coherently
 *  (e.g. a success exit with NO JSON line — an anomalous producer state). */
export class TurnProtocolError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "TurnProtocolError";
  }
}

/** Thrown when out-of-band retrieval is requested for a harness whose raw-JSONL
 *  download is not implemented here. This client ships CLAUDE-CODE RETRIEVAL
 *  ONLY; codex uses a different (~/.codex/sessions/<Y>/<M>/<D>/rollout-…) layout
 *  with no encodedCWD, and silently downloading from the claude path would be a
 *  correctness bug — so a codex retrieval request is rejected, not misrouted. */
export class TranscriptRetrievalUnsupportedError extends Error {
  constructor(readonly harness: string) {
    super(
      `out-of-band transcript retrieval not supported for harness "${harness}" ` +
        `(claude-code retrieval only)`,
    );
    this.name = "TranscriptRetrievalUnsupportedError";
  }
}

/** Mirrors structured-runner's resolveHarnessName WITHOUT importing from src/cli
 *  (bin-only territory a public barrel must not reach into). Accepts both the
 *  short aliases and the canonical names. */
function resolveHarnessName(name: string): "claude-code" | "codex" | null {
  switch (name) {
    case "claude":
    case "claude-code":
      return "claude-code";
    case "codex":
      return "codex";
    default:
      return null;
  }
}

/** Assemble the structured-runner argv. The prompt is NOT here — only its file
 *  path — so no prompt content ever reaches the argv or a shell. */
function buildArgv(
  binary: string,
  promptPath: string,
  cfg: TurnConfig,
): string[] {
  const argv = [binary, "--prompt-file", promptPath];
  if (cfg.effort !== undefined) argv.push("--effort", cfg.effort);
  if (cfg.model !== undefined) argv.push("--model", cfg.model);
  argv.push(cfg.harness);
  if (cfg.harnessArgs && cfg.harnessArgs.length > 0)
    argv.push("--", ...cfg.harnessArgs);
  return argv;
}

/** statusForExit maps an exit code that produced NO JSON to a coherent status. */
function statusForExit(code: number): TurnStatus {
  if (code === ExitDeadline) return "deadline";
  if (code === ExitUsage) return "startup_error";
  return "errored";
}

/**
 * runStructuredTurn drives one structured turn over `ws` and returns the parsed
 * protocol result.
 *
 * When stdout carries the JSON payload (structured-runner emits it on exit 0,
 * 124, and the caught runtime throw) it IS the source of truth and is returned
 * verbatim. When stdout carries ZERO JSON — exit 2 (usage), exit 1 from a
 * prompt-read failure, and exit 1 from the top-level fatal handler all emit
 * nothing — a coherent result is DERIVED from the exit code + stderr; a success
 * exit with no JSON throws TurnProtocolError (never assume a payload).
 */
export async function runStructuredTurn(
  ctx: Context,
  ws: Workspace,
  cfg: TurnConfig,
): Promise<StructuredTurnResult> {
  const binary = cfg.binary ?? DEFAULT_BINARY;
  const cwd = cfg.cwd ?? ws.guestPath("repo");

  // Stage the prompt on the host, upload to the guest tmp dir, exec, clean up.
  const stageDir = mkdtempSync(path.join(tmpdir(), "mh-turn-"));
  const hostPromptPath = path.join(stageDir, "prompt.txt");
  const guestPromptPath = `${ws.guestPath("tmp")}/meta-harness-prompt.txt`;

  let result: StructuredTurnResult;
  try {
    writeFileSync(hostPromptPath, cfg.prompt, "utf8");
    await ws.upload(ctx, hostPromptPath, guestPromptPath);

    const argv = buildArgv(binary, guestPromptPath, cfg);
    const exec = await ws.exec(ctx, argv, { env: cfg.env, cwd });

    const parsed = parseLastJSONLine(exec.stdout);
    if (parsed !== null) {
      // JSON payload present — the source of truth (exit 0 / 124 / caught throw).
      result = parsed;
    } else if (exec.code !== 0) {
      // No JSON on a non-zero exit (usage / prompt-read failure / fatal): derive
      // a coherent result from exit code + stderr rather than assume a payload.
      result = {
        status: statusForExit(exec.code),
        reply: "",
        harnessSessionID: "",
        transcript_entries: [],
        reason: exec.stderr.trim() || `structured-runner exited ${exec.code}`,
        working_dir: cwd,
      };
    } else {
      // Exit 0 with no JSON is anomalous — there is no reply to hand back.
      throw new TurnProtocolError(
        "structured-runner exited 0 but emitted no JSON result line",
        exec.code,
        exec.stderr,
      );
    }
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }

  if (cfg.retrieveTranscriptTo !== undefined) {
    await retrieveTranscript(ctx, ws, cfg, result);
  }
  return result;
}

/**
 * retrieveTranscript downloads the guest's RAW harness JSONL to a host path.
 * Harness-aware dispatch is MANDATORY — the layouts differ:
 *   - claude-code: ~/.claude/projects/<encodedCWD(cwd)>/<sessionID>.jsonl
 *   - codex:       ~/.codex/sessions/<Y>/<M>/<D>/rollout-<ts>-<uuid>.jsonl (no
 *                  encodedCWD) — NOT implemented here; rejected, not misrouted.
 * The in-band transcript_entries already covers BOTH harnesses; only this
 * raw-file download is harness-specific.
 */
async function retrieveTranscript(
  ctx: Context,
  ws: Workspace,
  cfg: TurnConfig,
  result: StructuredTurnResult,
): Promise<void> {
  const harness = resolveHarnessName(cfg.harness);
  if (harness !== "claude-code") {
    // codex (or an unknown alias) — do NOT download from the claude path.
    throw new TranscriptRetrievalUnsupportedError(cfg.harness);
  }
  if (!result.harnessSessionID) return; // nothing to retrieve without a session id

  const home = ws.guestPath("home");
  const projectDir = encodedCWD(result.working_dir || (cfg.cwd ?? ""));
  const guestFile = `${home}/.claude/projects/${projectDir}/${result.harnessSessionID}.jsonl`;
  await ws.download(ctx, guestFile, cfg.retrieveTranscriptTo!);
}
