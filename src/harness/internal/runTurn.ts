// runTurn — a single-turn driver over an existing Conversation. The TS port of
// pkg/harness/run_turn.go: opens a Conversation, sends Prompt through the PTY,
// waits for the adapter to report the submitted assistant turn's terminal
// state, then either stops the harness or hands the live Conversation back to
// the caller.
//
// Built ENTIRELY on the public chat.Conversation surface (sessionID, events,
// acquireControl, send, historyWithSource, wrapper, close, quit) — no
// src/turns/** import here, mirroring run_turn.go, which imports pkg/chat and
// never pkg/turns.
//
// Go's RunTurn returns (TurnResult, error) at every exit path, including the
// error ones — callers inspect the partial Turn/Session/History even when the
// run failed. TS has no multi-return, so failures throw a RunTurnError that
// carries that same best-effort TurnResult snapshot as `.result`, alongside
// the usual sentinel `.cause` chain (isSentinel(err, ErrTurnErrored) still
// works: RunTurnError extends CausedError).
//
// This port also has no equivalent of Go's wrapper.Session.Wait()/AttachOutput
// on the structural WrapperSession surface Conversation exposes via wrapper()
// (only writeStdin/acquireWriter/resize/stop are declared there) — so
// TurnConfig drops Output and TurnResult drops WrapperResult. ProcessStopped-
// AfterTurn is preserved: it needs no wrapper-level Result to be meaningful.

import {
  Open,
  type Conversation,
  type Turn,
  type Session,
  type HistorySource,
  type Store,
  type InputPolicy,
  type InputRequest,
  type InputAnswer,
  newMemStore,
  ErrInvalidOptions,
  ErrClosed,
  RoleAssistant,
  TurnStatePending,
  TurnStateComplete,
  TurnStateErrored,
  HistorySourceStore,
  EventTurn,
} from "../../chat/index.ts";
import {
  Context,
  defineSentinel,
  wrap,
  CausedError,
  type Sentinel,
} from "../../internal/async/index.ts";

/**
 * gracefulQuitWait bounds how long gracefulQuit waits for the harness to
 * settle after the quit sequence before runTurn's own close() escalates to a
 * forced stop.
 */
const gracefulQuitWait = 3000;

/** ErrTurnErrored is thrown (as a RunTurnError's cause) when the harness
 * reports that the submitted assistant turn ended in an errored state. The
 * RunTurnError's `.result` carries the errored turn. */
export const ErrTurnErrored: Sentinel = defineSentinel(
  "harness/turn-errored",
  "harness: turn errored",
);

/**
 * Thrown by runTurn when the run ends before a normal ExitAfterTurn/keep-alive
 * return: context cancellation, the event channel closing, an out-of-band
 * adapter error, or the submitted turn reaching TurnStateErrored (cause is
 * then ErrTurnErrored). Carries the best-effort TurnResult snapshot taken at
 * the moment of failure — the TS analogue of Go's (TurnResult, error) double
 * return, since a single throw can't carry both.
 */
export class RunTurnError extends CausedError {
  readonly result: TurnResult;

  constructor(message: string, cause: unknown, result: TurnResult) {
    super(message, cause);
    this.name = "RunTurnError";
    this.result = result;
  }
}

/**
 * TurnConfig configures runTurn, the one-shot interactive-turn entrypoint.
 *
 * runTurn starts an interactive harness, sends Prompt through the PTY, waits
 * for the adapter to report that the assistant turn completed, and then
 * either stops the harness process or returns the live Conversation to the
 * caller.
 */
export interface TurnConfig {
  /** Wrapper harness/profile name ("claude", "codex", "gemini", ...). Also
   * used to pick the chat adapter unless turnHarness is set. */
  harness: string;
  /** Overrides the chat adapter name. Most callers leave this unset. Exists
   * for naming mismatches such as wrapper harness "claude" using chat
   * adapter "claude-code". */
  turnHarness?: string;
  /** The harness executable. Required. */
  binaryPath: string;
  /** Passed verbatim to the harness. For Claude Code this is the normal
   * interactive arg set, not print/headless args. */
  args?: string[];
  workingDir?: string;
  env?: string[];
  /** Execution-mode knobs forwarded to chat.Options. Empty leaves the harness
   * default. */
  effort?: string;
  model?: string;
  /** Submitted as one user message. */
  prompt: string;
  /** Stops the interactive harness after the submitted turn completes or
   * errors. When false, the returned TurnResult.conversation is live and the
   * caller owns closing it. */
  exitAfterTurn?: boolean;
  /** Virtual terminal size. Zero values use chat.Open defaults. */
  cols?: number;
  rows?: number;
  /** Sizes the chat event buffer. Zero uses chat.Open default. */
  eventBuffer?: number;
  /** Pre-resolves blocking interactive prompts so a one-shot run proceeds
   * unattended. */
  inputPolicy?: InputPolicy;
  /** In-process resolver for prompts the policy didn't answer. */
  onInputRequest?: (req: InputRequest) => [InputAnswer, boolean];
}

/** TurnResult is the outcome of a runTurn call. */
export interface TurnResult {
  /** The assistant turn that completed or errored. */
  turn: Turn;
  /** The chat-level session record after the turn. */
  session: Session;
  /** conv.historyWithSource() after the turn (or the store fallback). */
  history: Turn[];
  /** Which of those two paths produced history — len(history) alone can't
   * distinguish them, since the store fallback also returns non-empty arrays. */
  historySource: HistorySource;
  /** True when runTurn intentionally stopped the interactive harness after
   * the submitted turn reached a terminal state. */
  processStoppedAfterTurn: boolean;
  /** Set only when exitAfterTurn is false/omitted. The caller owns the live
   * interactive process and must eventually call close(). */
  conversation?: Conversation;
}

/** runTurn runs one interactive harness turn and resolves when that turn
 * reaches a completed or errored state. */
export async function runTurn(
  ctx: Context | undefined,
  cfg: TurnConfig,
): Promise<TurnResult> {
  const runCtx = ctx ?? Context.background();
  if (!cfg.harness) throw wrapInvalid("Harness is required");
  if (!cfg.binaryPath) throw wrapInvalid("BinaryPath is required");

  const store = newMemStore();
  const conv = await Open(runCtx, {
    harness: turnHarnessName(cfg),
    binaryPath: cfg.binaryPath,
    args: cfg.args,
    workingDir: cfg.workingDir,
    env: cfg.env,
    effort: cfg.effort,
    model: cfg.model,
    cols: cfg.cols,
    rows: cfg.rows,
    store,
    eventBuffer: cfg.eventBuffer,
    inputPolicy: cfg.inputPolicy,
    onInputRequest: cfg.onInputRequest,
  });

  let result: TurnResult;
  try {
    result = await runConversationTurn(runCtx, conv, store, cfg.prompt);
  } catch (err) {
    await conv.close(Context.background());
    throw err;
  }

  if (!cfg.exitAfterTurn) {
    result.conversation = conv;
    return result;
  }

  result.processStoppedAfterTurn = true;
  // Ask the harness to exit gracefully first (so it can flush/persist). The
  // graceful exit prints the harness session id, which the durable line tap
  // captures into the stored Session — so after the quit we refresh
  // result.session (now carrying harnessSessionID) and re-read history, which
  // is transcript-backed once that id is known. close() below still
  // guarantees termination if the harness ignores the quit.
  if (await gracefulQuit(conv)) {
    try {
      result.session = await store.getSession(conv.sessionID());
    } catch {
      /* keep the pre-quit snapshot */
    }
    try {
      const [history, source] = await conv.historyWithSource();
      if (history.length > 0) {
        result.history = history;
        result.historySource = source;
      }
    } catch {
      /* keep the pre-quit snapshot */
    }
  }
  await conv.close(Context.background());
  return result;
}

async function runConversationTurn(
  ctx: Context,
  conv: Conversation,
  store: Store,
  prompt: string,
): Promise<TurnResult> {
  const release = await conv.acquireControl(ctx);
  try {
    const turnID = await conv.send(ctx, prompt);
    const bus = conv.events();

    for (;;) {
      const raced = await Promise.race([
        ctx.done().then((): "ctx" => "ctx"),
        bus.receive().then((r) => ({ recv: r })),
      ]);

      if (raced === "ctx") {
        const result = await snapshotTurnResult(conv, store, zeroTurn());
        throw new RunTurnError("harness: run canceled", ctx.err(), result);
      }

      const { value, ok } = raced.recv;
      if (!ok || value === undefined) {
        const result = await snapshotTurnResult(conv, store, zeroTurn());
        throw new RunTurnError(
          "harness: conversation closed",
          ErrClosed,
          result,
        );
      }

      const ev = value;
      if (ev.err !== undefined) {
        const result = await snapshotTurnResult(
          conv,
          store,
          ev.turn ?? zeroTurn(),
        );
        throw new RunTurnError("harness: turn event error", ev.err, result);
      }
      if (ev.type !== EventTurn || ev.turn?.id !== turnID) continue;

      if (ev.turn.state === TurnStateComplete) {
        return await snapshotTurnResult(conv, store, ev.turn);
      }
      if (ev.turn.state === TurnStateErrored) {
        const result = await snapshotTurnResult(conv, store, ev.turn);
        throw new RunTurnError("harness: turn errored", ErrTurnErrored, result);
      }
    }
  } finally {
    release();
  }
}

async function snapshotTurnResult(
  conv: Conversation,
  store: Store,
  turn: Turn,
): Promise<TurnResult> {
  let session: Session;
  try {
    session = await store.getSession(conv.sessionID());
  } catch {
    session = zeroSession();
  }

  let history: Turn[];
  let source: HistorySource;
  try {
    [history, source] = await conv.historyWithSource();
  } catch {
    try {
      history = await store.listTurns(conv.sessionID());
    } catch {
      history = [];
    }
    source = HistorySourceStore;
  }

  return {
    turn,
    session,
    history,
    historySource: source,
    processStoppedAfterTurn: false,
  };
}

/**
 * gracefulQuit asks the harness to exit cleanly via Conversation.quit (its
 * turns.Quitter sequence — for Claude Code, the "/quit" slash command) so it
 * can flush/persist its transcript before termination, and waits briefly for
 * the process to settle. Returns true if the quit was sent: the caller may
 * then re-read a freshly flushed transcript AND the harness session id the
 * durable line tap captured from the exit output. A harness with no quit
 * sequence is a no-op returning false — conv.close() then stops it with a
 * signal as before.
 *
 * Unlike Go, there is no wrapper-level Wait() on the WrapperSession surface
 * Conversation exposes, so this can't race a real process-exit signal against
 * the timeout the way gracefulQuit.go does — it always waits out the full
 * gracefulQuitWait bound, which is also what Go's select degrades to whenever
 * the harness doesn't exit on the quit keys by itself.
 */
async function gracefulQuit(conv: Conversation): Promise<boolean> {
  const { ctx, cancel } = Context.withDeadline(
    Context.background(),
    gracefulQuitWait,
  );
  try {
    await conv.quit(ctx);
  } catch {
    return false;
  } finally {
    cancel();
  }
  await sleep(gracefulQuitWait);
  return true;
}

function turnHarnessName(cfg: TurnConfig): string {
  if (cfg.turnHarness) return cfg.turnHarness;
  switch (cfg.harness) {
    case "claude":
      return "claude-code";
    default:
      return cfg.harness;
  }
}

function wrapInvalid(msg: string): Error {
  return wrap(`chat: invalid options: ${msg}`, ErrInvalidOptions);
}

function zeroTurn(): Turn {
  return {
    id: "",
    sessionID: "",
    role: RoleAssistant,
    state: TurnStatePending,
    text: "",
    reason: "",
    startedAt: new Date(0),
    completedAt: new Date(0),
    httpCode: 0,
    retryAfter: 0,
  };
}

function zeroSession(): Session {
  return {
    id: "",
    harness: "",
    workingDir: "",
    createdAt: new Date(0),
    harnessSessionID: "",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
