// Route-level integration tests for the meta-harness-chatd daemon (src/gateway/
// server.ts). Drives the real HTTP surface with a FAKE Conversation that mirrors
// the chat layer's guard semantics (real ControlQueue + real chat sentinels +
// real EventBus), so the full open→control→send→SSE→answer→history→close flow,
// the error-mapping rows, the id scheme, close-vs-in-flight atomicity, the
// no-lost-events guarantee, and the multi-select round-trip are exercised
// against genuine chat behavior without spawning a PTY-backed harness.

import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createServer, type Server as HTTPServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  Server,
  newToken,
  parseBind,
  type ConversationLike,
} from "../../src/gateway/server.ts";
import { EventBus } from "../../src/chat/conversation.ts";
import { newControlQueue } from "../../src/chat/control.ts";
import {
  ErrClosed,
  ErrNoControl,
  ErrNoInputPending,
  ErrNotMultiSelect,
  ErrPermissionModeUnreachable,
  ErrStaleInputRequest,
  ErrTurnInFlight,
  ErrUnknownHarness,
  ErrUnknownOption,
  type InputAnswer,
  type InputRequest,
  type PermissionModeReading,
  type PermissionModeTarget,
  type Turn,
} from "../../src/chat/index.ts";
import { Context, ctxCanceled } from "../../src/internal/async/index.ts";
import type { Snapshot } from "../../src/screen/screen.ts";
import {
  New,
  PromptRef,
  fakeHarnessBin,
  fakeLaunchEnv,
  openFake,
} from "../chat/fakeharness.ts";

// ── A faithful fake Conversation ─────────────────────────────────────────────

function mkTurn(
  sessionID: string,
  role: Turn["role"],
  state: Turn["state"],
  text: string,
): Turn {
  const now = new Date();
  return {
    id: newToken().slice(0, 8),
    sessionID,
    role,
    state,
    text,
    reason: "",
    startedAt: now,
    completedAt: state === "complete" ? now : new Date(0),
    httpCode: 0,
    retryAfter: 0,
  };
}

class FakeConversation implements ConversationLike {
  readonly bus = new EventBus(64);
  private readonly queue = newControlQueue();
  private closed = false;
  currentTurn: Turn | null = null;
  currentInput: InputRequest | null = null;
  readonly turns: Turn[] = [];
  appliedSelections: string[] = [];
  /** When true, send/answer block until the request Context fires, then throw ctx.err(). */
  block = false;
  /** When set, send/answer throw this AFTER the token gate — for synthetic error rows. */
  inject?: unknown;
  /** Simulates a conversation that was closed underneath a still-registered entry. */
  forceClosed = false;
  private closeWaiters: (() => void)[] = [];

  constructor(readonly id: string = "sess-" + newToken().slice(0, 8)) {}

  /** Resolves when close() runs (so a blocked op can observe teardown). */
  private closedSignal(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((r) => this.closeWaiters.push(r));
  }

  sessionID(): string {
    return this.id;
  }
  events(): EventBus {
    return this.bus;
  }
  acquireControl(ctx: Context): Promise<() => void> {
    return this.queue.acquire(ctx);
  }

  async send(ctx: Context, text: string): Promise<string> {
    if (this.closed || this.forceClosed) throw ErrClosed;
    if (!this.queue.held()) throw ErrNoControl;
    if (this.currentTurn) throw ErrTurnInFlight;
    if (this.block) {
      await Promise.race([ctx.done(), this.closedSignal()]);
      if (this.closed || this.forceClosed) throw ErrClosed;
      throw ctx.err();
    }
    if (this.inject !== undefined) throw this.inject;
    const user = mkTurn(this.id, "user", "complete", text);
    this.turns.push(user);
    this.bus.emit({ type: "turn", turn: user });
    const asst = mkTurn(this.id, "assistant", "pending", "");
    this.turns.push(asst);
    this.currentTurn = asst;
    this.bus.emit({ type: "turn", turn: asst });
    return asst.id;
  }

  async answer(
    ctx: Context,
    requestID: string,
    ans: InputAnswer,
  ): Promise<void> {
    if (this.closed || this.forceClosed) throw ErrClosed;
    if (!this.queue.held()) throw ErrNoControl;
    if (this.block) {
      await Promise.race([ctx.done(), this.closedSignal()]);
      if (this.closed || this.forceClosed) throw ErrClosed;
      throw ctx.err();
    }
    if (this.inject !== undefined) throw this.inject;
    const req = this.currentInput;
    if (!req) throw ErrNoInputPending;
    if (requestID !== "" && requestID !== req.id) throw ErrStaleInputRequest;
    const opts = req.options ?? [];
    const find = (s: string): string | undefined =>
      opts.find((o) => o.id === s || o.alias === s || o.label === s)?.id;
    const applied: string[] = [];
    if (ans.optionIDs && ans.optionIDs.length > 0) {
      if (ans.optionIDs.length > 1 && !req.multiSelect) throw ErrNotMultiSelect;
      for (const id of ans.optionIDs) {
        const hit = find(id);
        if (!hit) throw ErrUnknownOption;
        applied.push(hit);
      }
    } else if (ans.optionID !== undefined) {
      const hit = find(ans.optionID);
      if (!hit) throw ErrUnknownOption;
      applied.push(hit);
    }
    // A menu prompt requires a concrete selection; empty/unknown → unknown_option.
    if (opts.length > 0 && applied.length === 0) throw ErrUnknownOption;
    this.appliedSelections = applied;
    this.bus.emit({ type: "input_resolved", input: req });
    this.currentInput = null;
  }

  async history(): Promise<Turn[]> {
    return this.turns;
  }
  /** The screen generation the next snapshot reports. */
  generation = 7;
  /**
   * When true, EVERY screenSnapshot() bumps the generation — a live claude
   * repainting under the handler's feet. A handler that sampled the screen
   * twice would then read two different frames.
   */
  repaintPerSnapshot = false;
  /**
   * The reading the fake reports. `generation` is filled from the snapshot the
   * route hands in, exactly like the real Conversation's live claude path,
   * unless `frozenGeneration` pins it (the cached-codex-box shape).
   */
  reading: Omit<PermissionModeReading, "generation" | "observedAt"> = {
    observed: "acceptEdits",
    raw: "accept edits",
    source: "footer",
  };
  /** When set, the reading reports THIS generation — a cached, possibly stale parse. */
  frozenGeneration?: number;

  screenSnapshot(): Snapshot {
    if (this.repaintPerSnapshot) this.generation++;
    return {
      text: "SCREEN",
      cols: 80,
      rows: 24,
      cursorCol: 3,
      cursorRow: 1,
      generation: this.generation,
    };
  }
  permissionMode(snap?: Snapshot): PermissionModeReading {
    const s = snap ?? this.screenSnapshot();
    return {
      ...this.reading,
      generation: this.frozenGeneration ?? s.generation,
      observedAt: new Date("2026-07-22T18:04:11.220Z"),
    };
  }

  /**
   * The targets this fake's "harness" can reach. A KNOWN token outside it is
   * ErrPermissionModeUnreachable — the real Conversation's answer for a ladder
   * rung on codex or `"default"` on claude. Default: the claude shape (the
   * 5-rung ladder, no collaboration axis).
   */
  reachable: PermissionModeTarget[] = [
    "plan",
    "manual",
    "acceptEdits",
    "auto",
    "bypass",
  ];
  /** Every target setPermissionMode was actually driven to, in order. */
  readonly setTargets: PermissionModeTarget[] = [];
  /** How many times refreshPermissionMode ran (0 proves "no silent refresh"). */
  refreshes = 0;

  /** Gates shared by both mutating permission ops, mirroring the real ones. */
  private async permissionGates(ctx: Context): Promise<void> {
    if (this.closed || this.forceClosed) throw ErrClosed;
    if (!this.queue.held()) throw ErrNoControl;
    if (this.block) {
      await Promise.race([ctx.done(), this.closedSignal()]);
      if (this.closed || this.forceClosed) throw ErrClosed;
      throw ctx.err();
    }
    if (this.inject !== undefined) throw this.inject;
  }

  async setPermissionMode(
    ctx: Context,
    target: PermissionModeTarget,
  ): Promise<PermissionModeReading> {
    await this.permissionGates(ctx);
    if (!this.reachable.includes(target)) throw ErrPermissionModeUnreachable;
    this.setTargets.push(target);
    // A cycle keystroke reaches the PTY, so the screen repaints.
    this.generation++;
    this.reading =
      target === "default"
        ? { ...this.reading, collaboration: "default" }
        : { ...this.reading, observed: target, raw: target };
    return this.permissionMode();
  }

  async refreshPermissionMode(ctx: Context): Promise<PermissionModeReading> {
    await this.permissionGates(ctx);
    this.refreshes++;
    return this.permissionMode();
  }
  async close(): Promise<void> {
    this.closed = true;
    this.queue.close();
    this.bus.close();
    for (const w of this.closeWaiters.splice(0)) w();
  }

  /** Test helper: surface an interactive prompt (currentInput + emitted event). */
  surface(req: InputRequest): void {
    this.currentInput = req;
    this.bus.emit({ type: "input_request", input: req });
  }
}

// ── HTTP harness ─────────────────────────────────────────────────────────────

interface Live {
  base: string;
  server: HTTPServer;
  gateway: Server;
}

const running: HTTPServer[] = [];

function start(
  open?: (opts: unknown) => Promise<ConversationLike>,
): Promise<Live> {
  const gateway = new Server(open ? { open: open } : {});
  const server = createServer(gateway.handle);
  running.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ base: `http://127.0.0.1:${port}`, server, gateway });
    });
  });
}

afterEach(async () => {
  while (running.length) {
    const s = running.pop()!;
    await new Promise<void>((r) =>
      s.close(() => {
        r();
      }),
    );
  }
});

async function req(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(base + path, {
    method,
    headers:
      body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, text };
}

const delay = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Open a conversation; returns the fake and its wire id. */
async function open(base: string, fake: FakeConversation): Promise<string> {
  const r = await req(base, "POST", "/v1/conversations", {
    harness: "claude-code",
    binary_path: "/bin/x",
  });
  expect(r.status).toBe(201);
  expect(r.json.id).toBe(fake.id);
  return r.json.id;
}

/** A server whose opener always returns the given fake. */
function serverFor(fake: FakeConversation): Promise<Live> {
  return start(async () => fake);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("route-level integration flow", () => {
  test("open → control → send → SSE events → answer input → history → release → close", async () => {
    const fake = new FakeConversation();
    const { base } = await serverFor(fake);
    const id = await open(base, fake);

    // Acquire control → token.
    const ctl = await req(base, "POST", `/v1/conversations/${id}/control`);
    expect(ctl.status).toBe(200);
    const token: string = ctl.json.token;
    expect(token).toMatch(/^[0-9a-f]{32}$/);

    // Attach an SSE subscriber and collect frames.
    const sse = collectSSE(base, `/v1/conversations/${id}/events`);

    // Send a message (token-gated).
    const snd = await req(base, "POST", `/v1/conversations/${id}/messages`, {
      token,
      text: "hi",
    });
    expect(snd.status).toBe(202);
    expect(typeof snd.json.turn_id).toBe("string");

    // Surface an input request and answer it.
    const inputReq: InputRequest = {
      id: "ir1",
      kind: "question",
      prompt: "pick",
      options: [{ id: "yes", label: "Yes" }],
    };
    fake.surface(inputReq);
    const ans = await req(base, "POST", `/v1/conversations/${id}/input`, {
      token,
      request_id: "ir1",
      option_id: "yes",
    });
    expect(ans.status).toBe(204);
    expect(fake.appliedSelections).toEqual(["yes"]);

    // The SSE stream saw turn + input events.
    const frames = await sse.take(4, 1000);
    const types = frames.map((f) => f.type);
    expect(types).toContain("turn");
    expect(types).toContain("input_request");
    expect(types).toContain("input_resolved");
    sse.close();

    // History.
    const hist = await req(base, "GET", `/v1/conversations/${id}/history`);
    expect(hist.status).toBe(200);
    expect(hist.json.turns.length).toBeGreaterThanOrEqual(2);

    // Release the control token.
    const rel = await req(
      base,
      "DELETE",
      `/v1/conversations/${id}/control/${token}`,
    );
    expect(rel.status).toBe(204);
    // Releasing again → 404 unknown_token.
    const rel2 = await req(
      base,
      "DELETE",
      `/v1/conversations/${id}/control/${token}`,
    );
    expect(rel2.status).toBe(404);
    expect(rel2.json.code).toBe("unknown_token");

    // Close.
    const close = await req(base, "DELETE", `/v1/conversations/${id}`);
    expect(close.status).toBe(204);
    // Post-close list is empty; ops on the id → 404.
    const list = await req(base, "GET", "/v1/conversations");
    expect(list.json).toEqual([]);
    const after = await req(base, "GET", `/v1/conversations/${id}/screen`);
    expect(after.status).toBe(404);
  });

  test("GET /healthz → { ok: true }", async () => {
    const { base } = await start();
    const r = await req(base, "GET", "/healthz");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
  });
});

describe("bind / trust boundary", () => {
  test("default bind is localhost-only, --bind overrides", () => {
    expect(parseBind([])).toBe("127.0.0.1:8080");
    expect(parseBind(["--bind", "127.0.0.1:9999"])).toBe("127.0.0.1:9999");
    expect(parseBind(["--bind=127.0.0.1:1234"])).toBe("127.0.0.1:1234");
    // Default MUST NOT be 0.0.0.0 (would expose process-spawning to the network).
    expect(parseBind([])).not.toContain("0.0.0.0");
  });

  test("module header carries Go's trust-boundary note verbatim", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      join(here, "..", "..", "src", "gateway", "server.ts"),
      "utf8",
    );
    expect(src).toContain("v1 has no auth; bind to localhost");
  });
});

describe("id scheme", () => {
  test("open id === Conversation.sessionID(); history/screen/close address by it", async () => {
    const fake = new FakeConversation("the-session-id");
    const { base } = await serverFor(fake);
    const id = await open(base, fake);
    expect(id).toBe("the-session-id");

    const list = await req(base, "GET", "/v1/conversations");
    expect(list.json[0]).toMatchObject({
      id: "the-session-id",
      session_id: "the-session-id",
    });

    expect(
      (await req(base, "GET", `/v1/conversations/${id}/screen`)).status,
    ).toBe(200);
    expect(
      (await req(base, "GET", `/v1/conversations/${id}/history`)).status,
    ).toBe(200);
    expect((await req(base, "DELETE", `/v1/conversations/${id}`)).status).toBe(
      204,
    );
  });

  test("second open of the same session id is deduped/rejected", async () => {
    const fake = new FakeConversation("dupe");
    const { base } = await start(async () => fake);
    expect(
      (
        await req(base, "POST", "/v1/conversations", {
          harness: "x",
          binary_path: "/b",
        })
      ).status,
    ).toBe(201);
    const second = await req(base, "POST", "/v1/conversations", {
      harness: "x",
      binary_path: "/b",
    });
    expect(second.status).toBe(409);
    expect(second.json.code).toBe("already_open");
  });
});

describe("close vs in-flight", () => {
  test("an op racing DELETE resolves to a live result or 410 gone, never half-torn-down", async () => {
    const fake = new FakeConversation();
    const { base } = await serverFor(fake);
    const id = await open(base, fake);
    const ctl = await req(base, "POST", `/v1/conversations/${id}/control`);
    const token = ctl.json.token;

    // Block the send so it is in flight while we DELETE.
    fake.block = true;
    const sendP = req(base, "POST", `/v1/conversations/${id}/messages`, {
      token,
      text: "x",
      timeout_seconds: 5,
    });
    await delay(20);
    // Close races the in-flight send. close() marks the conv closed → the send's
    // Context also cancels when the response closes.
    const del = await req(base, "DELETE", `/v1/conversations/${id}`);
    expect(del.status).toBe(204);

    const snd = await sendP;
    // Either a live 202 (completed just before close) or a 4xx/5xx terminal
    // outcome — but a real, whole HTTP status, never a hang or torn socket.
    expect([202, 408, 410, 504]).toContain(snd.status);
  });

  test("op on a closed-but-registered conversation → 410 gone", async () => {
    const fake = new FakeConversation();
    const { base } = await serverFor(fake);
    const id = await open(base, fake);
    const ctl = await req(base, "POST", `/v1/conversations/${id}/control`);
    // Simulate the conv closed underneath the still-registered entry.
    fake.forceClosed = true;
    const snd = await req(base, "POST", `/v1/conversations/${id}/messages`, {
      token: ctl.json.token,
      text: "x",
    });
    expect(snd.status).toBe(410);
    expect(snd.json.code).toBe("gone");
  });
});

describe("error mapping via real requests", () => {
  test("send with no token → 409 no_control", async () => {
    const fake = new FakeConversation();
    const { base } = await serverFor(fake);
    const id = await open(base, fake);
    const r = await req(base, "POST", `/v1/conversations/${id}/messages`, {
      token: "nope",
      text: "x",
    });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("no_control");
  });

  test("answer with no token → 409 no_control", async () => {
    const fake = new FakeConversation();
    const { base } = await serverFor(fake);
    const id = await open(base, fake);
    const r = await req(base, "POST", `/v1/conversations/${id}/input`, {
      token: "nope",
      option_id: "y",
    });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("no_control");
  });

  test("send with a turn in flight → 409 turn_in_flight", async () => {
    const fake = new FakeConversation();
    const { base } = await serverFor(fake);
    const id = await open(base, fake);
    const token = (await req(base, "POST", `/v1/conversations/${id}/control`))
      .json.token;
    expect(
      (
        await req(base, "POST", `/v1/conversations/${id}/messages`, {
          token,
          text: "a",
        })
      ).status,
    ).toBe(202);
    const r = await req(base, "POST", `/v1/conversations/${id}/messages`, {
      token,
      text: "b",
    });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("turn_in_flight");
  });

  test("unknown harness at open → 400 unknown_harness", async () => {
    const { base } = await start(async () => {
      throw ErrUnknownHarness;
    });
    const r = await req(base, "POST", "/v1/conversations", {
      harness: "bogus",
      binary_path: "/b",
    });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("unknown_harness");
  });

  test("deadline → 504 timeout", async () => {
    const fake = new FakeConversation();
    const { base } = await serverFor(fake);
    const id = await open(base, fake);
    const token = (await req(base, "POST", `/v1/conversations/${id}/control`))
      .json.token;
    fake.block = true;
    const r = await req(base, "POST", `/v1/conversations/${id}/messages`, {
      token,
      text: "x",
      timeout_seconds: 0.05,
    });
    expect(r.status).toBe(504);
    expect(r.json.code).toBe("timeout");
  });

  test("cancel → 408 canceled", async () => {
    const fake = new FakeConversation();
    const { base } = await serverFor(fake);
    const id = await open(base, fake);
    const token = (await req(base, "POST", `/v1/conversations/${id}/control`))
      .json.token;
    // Synthetic ctxCanceled surfaced by the op → mapped by writeRunTurnError.
    fake.inject = ctxCanceled;
    const r = await req(base, "POST", `/v1/conversations/${id}/messages`, {
      token,
      text: "x",
    });
    expect(r.status).toBe(408);
    expect(r.json.code).toBe("canceled");
  });

  test("unknown / empty option_id → 400 unknown_option", async () => {
    const fake = new FakeConversation();
    const { base } = await serverFor(fake);
    const id = await open(base, fake);
    const token = (await req(base, "POST", `/v1/conversations/${id}/control`))
      .json.token;
    fake.surface({
      id: "ir",
      kind: "question",
      prompt: "?",
      options: [{ id: "yes", label: "Yes" }],
    });
    // Unknown id.
    const bad = await req(base, "POST", `/v1/conversations/${id}/input`, {
      token,
      option_id: "nope",
    });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe("unknown_option");
    // Empty (no selection) against a menu prompt.
    const empty = await req(base, "POST", `/v1/conversations/${id}/input`, {
      token,
      option_id: "",
    });
    expect(empty.status).toBe(400);
    expect(empty.json.code).toBe("unknown_option");
  });
});

describe("multi-select round trip", () => {
  test("happy path: option_ids[] over HTTP applies both selections", async () => {
    const fake = new FakeConversation();
    const { base } = await serverFor(fake);
    const id = await open(base, fake);
    const token = (await req(base, "POST", `/v1/conversations/${id}/control`))
      .json.token;
    fake.surface({
      id: "ms",
      kind: "question",
      prompt: "pick many",
      multiSelect: true,
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
        { id: "c", label: "C" },
      ],
    });
    const r = await req(base, "POST", `/v1/conversations/${id}/input`, {
      token,
      request_id: "ms",
      option_ids: ["a", "b"],
    });
    expect(r.status).toBe(204);
    expect(fake.appliedSelections).toEqual(["a", "b"]);
  });

  test("rejection: multiple ids on a single-select prompt → 400 not_multi_select", async () => {
    const fake = new FakeConversation();
    const { base } = await serverFor(fake);
    const id = await open(base, fake);
    const token = (await req(base, "POST", `/v1/conversations/${id}/control`))
      .json.token;
    fake.surface({
      id: "ss",
      kind: "question",
      prompt: "pick one",
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    });
    const r = await req(base, "POST", `/v1/conversations/${id}/input`, {
      token,
      request_id: "ss",
      option_ids: ["a", "b"],
    });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("not_multi_select");
  });

  test("rejection: unknown id in option_ids[] → 400 unknown_option", async () => {
    const fake = new FakeConversation();
    const { base } = await serverFor(fake);
    const id = await open(base, fake);
    const token = (await req(base, "POST", `/v1/conversations/${id}/control`))
      .json.token;
    fake.surface({
      id: "ms2",
      kind: "question",
      prompt: "pick many",
      multiSelect: true,
      options: [{ id: "a", label: "A" }],
    });
    const r = await req(base, "POST", `/v1/conversations/${id}/input`, {
      token,
      request_id: "ms2",
      option_ids: ["a", "z"],
    });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("unknown_option");
  });
});

describe("no lost events", () => {
  test("turn/input events emitted before the first SSE subscriber are still delivered", async () => {
    const fake = new FakeConversation();
    const { base } = await serverFor(fake);
    const id = await open(base, fake);

    // Emit events BEFORE any SSE subscriber attaches. The Fanout was created
    // eagerly at open, so it buffers these for the first subscriber.
    fake.bus.emit({
      type: "turn",
      turn: mkTurn(fake.id, "assistant", "complete", "early-1"),
    });
    fake.bus.emit({
      type: "input_request",
      input: { id: "early-ir", kind: "question", prompt: "?" },
    });
    await delay(20); // let the Fanout pump drain into its pending buffer

    const sse = collectSSE(base, `/v1/conversations/${id}/events`);
    const frames = await sse.take(2, 1000);
    sse.close();
    const types = frames.map((f) => f.type);
    expect(types).toContain("turn");
    expect(types).toContain("input_request");
  });
});

// /v1/turns drives the imported runTurn directly (NOT the injectable opener), so
// these tests spawn a REAL fake-harness process on a REAL pty — exactly like
// test/harness/run-turn.test.ts. That yields a genuine store-backed Session for
// free (the live line taps populate the store), so the asserted `session` is a
// real, non-zero record rather than zeroSession(). The 30 000 ms global vitest
// budget absorbs the ~3 s gracefulQuit floor the completed path pays (§3).
describe("/v1/turns (one-shot RunTurn over a real pty + fake harness)", () => {
  test("exit_after_turn=false → 400 unsupported", async () => {
    const { base } = await start();
    const r = await req(base, "POST", "/v1/turns", {
      harness: "x",
      binary_path: "/b",
      exit_after_turn: false,
    });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("unsupported");
  });

  test("missing harness / binary_path / prompt → 400 invalid_options", async () => {
    const { base } = await start();
    for (const body of [
      { binary_path: "/b", prompt: "p" },
      { harness: "claude", prompt: "p" },
      { harness: "claude", binary_path: "/b" },
    ]) {
      const r = await req(base, "POST", "/v1/turns", body);
      expect(r.status).toBe(400);
      expect(r.json.code).toBe("invalid_options");
    }
  });

  test("malformed JSON → 400 invalid_json", async () => {
    const { base } = await start();
    const res = await fetch(base + "/v1/turns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not valid json",
    });
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.code).toBe("invalid_json");
  });

  test("one-shot RunTurn returns a full TurnResult envelope", async () => {
    // The claude-code adapter mints its OWN --session-id uuid at launch; the
    // scripted resume hint is a losing backstop (see run-turn.test.ts).
    const resumeHintID = "123e4567-e89b-12d3-a456-426614174000";
    const script = New("claude-code")
      .Session(resumeHintID)
      .Idle()
      .AwaitSubmit()
      .Working(30, "Working")
      .Reply(40, "assistant reply: " + PromptRef(), "Baked", "1s")
      .StayAliveUntilStopped()
      .Build();
    const { base } = await start();
    const r = await req(base, "POST", "/v1/turns", {
      harness: "claude",
      binary_path: fakeHarnessBin,
      env: fakeLaunchEnv(script),
      prompt: "ship the turn API",
    });
    expect(r.status).toBe(200);
    expect(r.json.turn.state).toBe("complete");
    // A GENUINE, store-backed session — a freshly-minted --session-id uuid, NOT
    // the all-zeros zeroSession() a naive fake seam would yield.
    expect(r.json.session.harness_session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(r.json.session.harness_session_id).not.toBe(resumeHintID);
    expect(r.json.history.length).toBeGreaterThanOrEqual(2);
    expect(["transcript", "store"]).toContain(r.json.history_source);
    expect(r.json.process_stopped_after_turn).toBe(true);
    // A completed turn omits `error` entirely (Go's runTurnResponse omitempty).
    expect(r.json.error).toBeUndefined();
  });

  test("an errored turn returns 200 with the errored turn, NOT 500", async () => {
    const script = New("claude-code").Idle().AwaitSubmit().Exit(2).Build();
    const { base } = await start();
    const r = await req(base, "POST", "/v1/turns", {
      harness: "claude",
      binary_path: fakeHarnessBin,
      env: fakeLaunchEnv(script),
      prompt: "fail this turn",
    });
    expect(r.status).toBe(200);
    expect(r.json.turn.state).toBe("errored");
    // Handler override (§4): the internal TurnResult flag is false (the errored
    // turn throws before runTurn sets it), but exit_after_turn=true always stops
    // the process, so the wire envelope reports it stopped consistently.
    expect(r.json.process_stopped_after_turn).toBe(true);
    // Item 1: Go's runTurnResponse.Error carries the bare ErrTurnErrored string.
    expect(r.json.error).toBe("harness: turn errored");
  });

  test("timeout_seconds bounds a wedged turn → 504 timeout (§7)", async () => {
    // A turn that submits but never reaches a terminal state: runTurn's event
    // loop exits only on ctx.done(). Proves the handler passes the bounded,
    // request-scoped ctx (a background ctx would hang here forever).
    const script = New("claude-code")
      .Idle()
      .AwaitSubmit()
      .Working(30, "Working")
      .StayAliveUntilStopped()
      .Build();
    const { base } = await start();
    const r = await req(base, "POST", "/v1/turns", {
      harness: "claude",
      binary_path: fakeHarnessBin,
      env: fakeLaunchEnv(script),
      prompt: "never completes",
      timeout_seconds: 6,
    });
    expect(r.status).toBe(504);
    expect(r.json.code).toBe("timeout");
    // Item 3: mapped errors ship Go's `{ error, code }` body — guard the `error`
    // key the old `{ code, message }` shape never carried.
    expect(typeof r.json.error).toBe("string");
  });

  // Regression: the DEFAULT opener must supply a Store. Every other route test
  // injects its own Opener, so defaultOpener was never exercised and shipped
  // without one — Open rejected it ErrInvalidOptions, POST /v1/conversations
  // returned 400 for every caller, and the whole /v1/conversations/** surface
  // was unreachable on the real binary. `store` is a live object with no wire
  // representation, so the daemon has to provide it. This uses the DEFAULT
  // server (no `open` argument) — that is the entire point of the test.
  test("POST /v1/conversations opens on the DEFAULT opener (supplies a Store)", async () => {
    const script = New("claude-code").Idle().StayAliveUntilStopped().Build();
    const { base } = await start();

    const open = await req(base, "POST", "/v1/conversations", {
      harness: "claude-code",
      binary_path: fakeHarnessBin,
      env: fakeLaunchEnv(script),
      // Required in practice: with no working_dir the claude-code transcript
      // reader throws ErrEmptyWorkingDir, which historyWithSource does NOT
      // degrade to store history (only ErrSessionNotFound / ErrEmptySessionID),
      // so GET /history would 500. `working_dir` is optional on the wire.
      working_dir: process.cwd(),
    });
    expect(open.status).toBe(201);
    expect(typeof open.json.id).toBe("string");
    expect(open.json.id.length).toBeGreaterThan(0);

    // Registered and store-backed: it lists, and history reads without the
    // 500 history_failed a missing store would produce.
    const list = await req(base, "GET", "/v1/conversations");
    expect(list.status).toBe(200);
    expect(list.json.map((c: { id: string }) => c.id)).toContain(open.json.id);

    const hist = await req(
      base,
      "GET",
      `/v1/conversations/${open.json.id}/history`,
    );
    expect(hist.status).toBe(200);
    expect(Array.isArray(hist.json.turns)).toBe(true);

    const del = await req(base, "DELETE", `/v1/conversations/${open.json.id}`);
    expect(del.status).toBe(204);
  }, 30_000);
});

// ── permission_mode / effort on both request bodies (META-HARNESS-101) ───────
//
// The request wire has NO corpus comparator (test/corpus/wire/ carries response
// surfaces only), so every guarantee here is hand-written or it does not exist.
// Three layers, each catching something the others cannot:
//
//   1. the opener SPY — the only proof of the omitted / "" / value distinction,
//      since `permissionMode: body.permission_mode` always SETS the key;
//   2. the argv dump over a real pty — the only proof the value survives the two
//      hand-enumerated, non-spread literals downstream (runTurn's Open call and
//      openWithSession's wrapper cfg). A rename there compiles, passes the spy,
//      and drops the flag on the floor;
//   3. the 400 guards — no pty, no opener, deterministic.
//
// Every /v1/conversations body uses "claude-code", never "claude": resolveAdapter
// has no "claude" case, so the bare spelling is an ErrUnknownHarness 400 on the
// open route (pre-existing, unrelated to this feature). /v1/turns takes "claude"
// because turnHarnessName maps it.
describe("permission_mode (POST /v1/conversations + POST /v1/turns)", () => {
  /** A server whose opener records the Options literal it was handed. */
  function spyStart(): Promise<
    Live & { seen: () => Record<string, unknown>[] }
  > {
    const calls: Record<string, unknown>[] = [];
    return start((opts: unknown) => {
      calls.push(opts as Record<string, unknown>);
      return Promise.resolve(new FakeConversation());
    }).then((live) => ({ ...live, seen: () => calls }));
  }

  function argvPath(): string {
    return join(mkdtempSync(join(tmpdir(), "gw-argv-")), "argv.json");
  }

  /**
   * Read the argv dump, waiting for it to appear. The fake harness writes it as
   * its FIRST act, but that is still a freshly spawned node process: POST
   * /v1/conversations answers 201 as soon as Open returns, which can beat the
   * child to its own first line. Poll rather than sleep so the fast path stays
   * fast and a genuine "never launched" failure still fails, on the timeout.
   */
  async function readArgv(path: string): Promise<string[]> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        return JSON.parse(readFileSync(path, "utf8")) as string[];
      } catch (err) {
        if (Date.now() >= deadline) throw err;
        await new Promise((r) => setTimeout(r, 25));
      }
    }
  }

  /**
   * Assert `flag` appears exactly `count` times and each occurrence is followed
   * by `value`. Adjacency matters: run.ts prepends effort/model/permission args
   * in front of the adapter's own `--session-id <uuid>` prefix, so several
   * tokens coexist and a bare `toContain` pair would pass on a mis-paired argv.
   */
  function expectFlag(
    argv: string[],
    flag: string,
    value: string,
    count = 1,
  ): void {
    const at = argv.flatMap((a, i) => (a === flag ? [i] : []));
    expect(at.length).toBe(count);
    for (const i of at) expect(argv[i + 1]).toBe(value);
  }

  // ── The spy: omitted vs "" vs a real rung ──────────────────────────────────

  test("opener sees permissionMode undefined / '' / 'plan' verbatim", async () => {
    const { base, seen } = await spyStart();
    const bodies = [
      {},
      { permission_mode: "" },
      { permission_mode: "plan" },
    ] as const;
    for (const extra of bodies) {
      const r = await req(base, "POST", "/v1/conversations", {
        harness: "claude-code",
        binary_path: "/b",
        ...extra,
      });
      expect(r.status).toBe(201);
    }
    const calls = seen();
    expect(calls.length).toBe(3);
    // Assert the VALUE, not key-absence: the handler always sets the key.
    expect(calls[0].permissionMode).toBeUndefined();
    expect(calls[1].permissionMode).toBe("");
    expect(calls[2].permissionMode).toBe("plan");
  });

  test("codex + plan is ACCEPTED on the open route (201, not 400)", async () => {
    // On /v1/conversations this rung is fully usable: the conversation is
    // registered, so an approval_prompt raised by approval_policy=untrusted
    // surfaces on SSE and a client answers it via .../input. (The same body on
    // /v1/turns is deliberately NOT asserted here — see the RunTurnRequestBody
    // doc comment: unattended, it can legitimately end 408/504.)
    const { base, seen } = await spyStart();
    const r = await req(base, "POST", "/v1/conversations", {
      harness: "codex",
      binary_path: "/b",
      permission_mode: "plan",
    });
    expect(r.status).toBe(201);
    expect(seen()[0].permissionMode).toBe("plan");
  });

  // ── The 400 guards (no pty, no opener) ─────────────────────────────────────

  test("/v1/turns rejects an unsupported value and an unsupported harness", async () => {
    const { base } = await start();
    // `prompt` is mandatory in these bodies or the pre-existing "prompt is
    // required" guard fires first and the test asserts nothing.
    const bad = await req(base, "POST", "/v1/turns", {
      harness: "claude",
      binary_path: "/b",
      prompt: "p",
      permission_mode: "ultra",
    });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe("invalid_options");
    expect(bad.json.error).toMatch(/permission_mode ultra/);

    const wrongHarness = await req(base, "POST", "/v1/turns", {
      harness: "opencode",
      binary_path: "/b",
      prompt: "p",
      permission_mode: "plan",
    });
    expect(wrongHarness.status).toBe(400);
    expect(wrongHarness.json.code).toBe("invalid_options");
    expect(wrongHarness.json.error).toMatch(/permission_mode/);
    expect(wrongHarness.json.error).toMatch(/opencode/);
  });

  test("/v1/conversations rejects both, BEFORE calling the opener", async () => {
    const { base, seen } = await spyStart();
    const bad = await req(base, "POST", "/v1/conversations", {
      harness: "claude-code",
      binary_path: "/b",
      permission_mode: "ultra",
    });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe("invalid_options");
    expect(bad.json.error).toMatch(/permission_mode ultra/);

    const wrongHarness = await req(base, "POST", "/v1/conversations", {
      harness: "opencode",
      binary_path: "/b",
      permission_mode: "plan",
    });
    expect(wrongHarness.status).toBe(400);
    expect(wrongHarness.json.error).toMatch(/permission_mode/);
    expect(wrongHarness.json.error).toMatch(/opencode/);
    // The guard runs BEFORE the spawn — that is what makes it a 400 and not a
    // 500 out of validateConfig.
    expect(seen().length).toBe(0);
  });

  test("permission_mode '' skips the guard entirely (no 400)", async () => {
    const { base } = await start();
    // "opencode" supports no rung at all, so an empty value would 400 if the
    // guard treated "" as a value rather than as unset.
    const r = await req(base, "POST", "/v1/turns", {
      harness: "opencode",
      binary_path: "/b",
      prompt: "p",
      permission_mode: "",
    });
    expect(r.status).not.toBe(400);
  });

  // ── The adjacent effort guard: previously an opaque 500 ────────────────────

  test("a bad effort is now 400 invalid_options on both routes", async () => {
    const { base, seen } = await spyStart();
    const open = await req(base, "POST", "/v1/conversations", {
      harness: "claude-code",
      binary_path: "/b",
      effort: "ultra",
    });
    expect(open.status).toBe(400);
    expect(open.json.code).toBe("invalid_options");
    expect(open.json.error).toMatch(/effort ultra/);
    expect(seen().length).toBe(0);

    const turn = await req(base, "POST", "/v1/turns", {
      harness: "claude",
      binary_path: "/b",
      prompt: "p",
      effort: "ultra",
    });
    expect(turn.status).toBe(400);
    expect(turn.json.code).toBe("invalid_options");
    expect(turn.json.error).toMatch(/effort ultra/);
  });

  test("an EMPTY harness still gets the honest presence error, not an effort one", async () => {
    // Pins openConv's single shared `if (h)` skip. Without it this would 400
    // with "effort is not supported for harness " — right status, wrong field,
    // trailing empty name — instead of Open's own ErrInvalidOptions.
    const { base } = await start();
    const r = await req(base, "POST", "/v1/conversations", { effort: "high" });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("invalid_options");
    expect(r.json.error).toMatch(/Harness and BinaryPath are required/);
    expect(r.json.error).not.toMatch(/effort/);
  });

  // ── End-to-end argv: the only proof the value reaches the harness ──────────

  test("/v1/turns: permission_mode 'plan' reaches the launch argv", async () => {
    const script = New("claude-code")
      .Idle()
      .AwaitSubmit()
      .Working(30, "Working")
      .Reply(40, "ok", "Baked", "1s")
      .StayAliveUntilStopped()
      .Build();
    const argvOut = argvPath();
    const { base } = await start();
    const r = await req(base, "POST", "/v1/turns", {
      harness: "claude",
      binary_path: fakeHarnessBin,
      env: fakeLaunchEnv(script, argvOut),
      prompt: "pin the rung",
      permission_mode: "plan",
    });
    expect(r.status).toBe(200);
    const argv = await readArgv(argvOut);
    expectFlag(argv, "--permission-mode", "plan");
  }, 30_000);

  test("/v1/turns: an explicit --permission-mode in args WINS", async () => {
    // The wrapper's all-or-nothing precedence rule, pinned at the wire level:
    // the request is ACCEPTED (not 400) and the wire field injects nothing.
    const script = New("claude-code")
      .Idle()
      .AwaitSubmit()
      .Working(30, "Working")
      .Reply(40, "ok", "Baked", "1s")
      .StayAliveUntilStopped()
      .Build();
    const argvOut = argvPath();
    const { base } = await start();
    const r = await req(base, "POST", "/v1/turns", {
      harness: "claude",
      binary_path: fakeHarnessBin,
      env: fakeLaunchEnv(script, argvOut),
      prompt: "explicit args win",
      args: ["--permission-mode", "acceptEdits"],
      permission_mode: "plan",
    });
    expect(r.status).toBe(200);
    const argv = await readArgv(argvOut);
    expectFlag(argv, "--permission-mode", "acceptEdits");
  }, 30_000);

  test("/v1/conversations: permission_mode reaches the argv on the DEFAULT opener", async () => {
    // Covers the openWithSession half of the forwarding chain independently of
    // the spy, which observes Options one hop EARLIER than the cfg literal that
    // actually launches the wrapper.
    const script = New("claude-code").Idle().StayAliveUntilStopped().Build();
    const argvOut = argvPath();
    const { base } = await start();
    const open = await req(base, "POST", "/v1/conversations", {
      harness: "claude-code",
      binary_path: fakeHarnessBin,
      env: fakeLaunchEnv(script, argvOut),
      working_dir: process.cwd(),
      permission_mode: "plan",
    });
    expect(open.status).toBe(201);
    const argv = await readArgv(argvOut);
    expectFlag(argv, "--permission-mode", "plan");

    const del = await req(base, "DELETE", `/v1/conversations/${open.json.id}`);
    expect(del.status).toBe(204);
  }, 30_000);
});
// ── GET /v1/conversations/{id}/permission-mode ───────────────────────────────

describe("permission-mode route", () => {
  const path = (id: string): string =>
    `/v1/conversations/${id}/permission-mode`;

  test("pure read: no control token, full reading on the wire", async () => {
    const fake = new FakeConversation();
    fake.reading = {
      requested: "bypass",
      requestedRaw: "bypassPermissions",
      observed: "acceptEdits",
      raw: "accept edits",
      collaboration: "default",
      source: "footer",
    };
    const { base } = await serverFor(fake);
    const id = await open(base, fake);

    // NOT token-gated — nobody has ever acquired control here.
    const r = await req(base, "GET", path(id));
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      requested: "bypass",
      requested_raw: "bypassPermissions",
      observed: "acceptEdits",
      raw: "accept edits",
      collaboration: "default",
      source: "footer",
      generation: 7,
      current_generation: 7,
      stale: false,
      observed_at: "2026-07-22T18:04:11.220Z",
    });
  });

  test("one snapshot serves both generations: a live read under continuous repaint is NOT stale", async () => {
    // The fake repaints on EVERY screenSnapshot() call, exactly like a live
    // claude. A handler that sampled the screen twice would see the second,
    // bumped generation and report stale:true on a genuinely live read.
    const fake = new FakeConversation();
    fake.repaintPerSnapshot = true;
    const { base } = await serverFor(fake);
    const id = await open(base, fake);

    for (let i = 0; i < 3; i++) {
      const r = await req(base, "GET", path(id));
      expect(r.status).toBe(200);
      expect(r.json.stale).toBe(false);
      expect(r.json.current_generation).toBe(r.json.generation);
    }
    // Successive reads DO advance — the frames really are different.
    const a = (await req(base, "GET", path(id))).json.generation;
    const b = (await req(base, "GET", path(id))).json.generation;
    expect(b).toBeGreaterThan(a);
  });

  test("a cached (codex /status) reading reports stale once the screen has moved on", async () => {
    const fake = new FakeConversation();
    fake.reading = {
      observed: "auto",
      raw: "Full access",
      collaboration: "default",
      source: "status",
    };
    fake.frozenGeneration = 3; // parsed at prime time
    fake.generation = 4711; // the screen has been repainted since
    const { base } = await serverFor(fake);
    const id = await open(base, fake);

    const r = await req(base, "GET", path(id));
    expect(r.json).toMatchObject({
      observed: "auto",
      source: "status",
      generation: 3,
      current_generation: 4711,
      stale: true,
    });
  });

  test("404 on an unknown id", async () => {
    const { base } = await start();
    const r = await req(base, "GET", path("no-such-conversation"));
    expect(r.status).toBe(404);
    expect(r.json.code).toBe("not_found");
  });

  test("off-ladder: `Workspace (Approve for me)` reaches the HTTP body as raw", async () => {
    // The whole off-ladder story has to survive to the wire: unknown WITH a raw
    // is "outside the ladder", not "we couldn't see".
    const fake = new FakeConversation();
    fake.reading = {
      observed: "unknown",
      raw: "Workspace (Approve for me)",
      source: "unparsed_footer",
    };
    const { base } = await serverFor(fake);
    const id = await open(base, fake);

    const r = await req(base, "GET", path(id));
    expect(r.status).toBe(200);
    expect(r.json.observed).toBe("unknown");
    expect(r.json.raw).toBe("Workspace (Approve for me)");
    expect(r.json.source).toBe("unparsed_footer");
    // The raw text survives the JSON round-trip byte for byte.
    expect(r.text).toContain("Workspace (Approve for me)");
  });

  test("`requested`, `requested_raw`, `raw` and `collaboration` are omitted when empty", async () => {
    const fake = new FakeConversation();
    fake.reading = { observed: "unknown", source: "no_footer" };
    const { base } = await serverFor(fake);
    const id = await open(base, fake);

    const r = await req(base, "GET", path(id));
    expect(r.json).toEqual({
      observed: "unknown",
      source: "no_footer",
      generation: 7,
      current_generation: 7,
      stale: false,
      observed_at: "2026-07-22T18:04:11.220Z",
    });
    for (const k of ["requested", "requested_raw", "raw", "collaboration"]) {
      expect(r.text).not.toContain(`"${k}"`);
    }
  });

  test("the closed-conversation case cannot arise over HTTP — DELETE 404s the route", async () => {
    // `stale` is a generation comparison, not a liveness claim, so a closed
    // conversation would report stale:false on a frozen frame. It never gets
    // the chance: closeConv removes the entry from the registry SYNCHRONOUSLY
    // before awaiting close(), so the route 404s instead.
    const fake = new FakeConversation();
    const { base } = await serverFor(fake);
    const id = await open(base, fake);
    expect((await req(base, "GET", path(id))).status).toBe(200);

    expect((await req(base, "DELETE", `/v1/conversations/${id}`)).status).toBe(
      204,
    );
    const after = await req(base, "GET", path(id));
    expect(after.status).toBe(404);
    expect(after.json.code).toBe("not_found");
  });

  test("a REAL pi conversation reads back over the route: launch source, no throw", async () => {
    // No screen reader exists for pi/opencode/generic, so the route must still
    // answer 200 with `observed: "unknown"` / `source: "launch"` — never a 500.
    // `requested` is necessarily absent here: the wrapper rejects a launch
    // permissionMode outright for a harness with no permission axis, so a pi
    // conversation can never carry one.
    const script = New("pi").Idle().StayAliveUntilStopped().Build();
    const conv = await openFake(script);
    try {
      const { base } = await start(async () => conv);
      const o = await req(base, "POST", "/v1/conversations", {
        harness: "pi",
        binary_path: "/bin/x",
      });
      expect(o.status).toBe(201);

      const r = await req(base, "GET", path(o.json.id));
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({
        observed: "unknown",
        source: "launch",
        stale: false,
      });
      expect(Object.hasOwn(r.json, "requested")).toBe(false);
      expect(Object.hasOwn(r.json, "requested_raw")).toBe(false);
      expect(typeof r.json.generation).toBe("number");
      expect(r.json.current_generation).toBe(r.json.generation);
      expect(Date.parse(r.json.observed_at)).not.toBeNaN();
    } finally {
      await conv.close();
    }
  }, 30_000);

  test("a REAL claude-code conversation carries requested/requested_raw over the route", async () => {
    // The launch spelling is normalized on the way out (`bypassPermissions` →
    // `bypass`) while `requested_raw` keeps it verbatim — both survive to the
    // wire. The fake's idle frame paints no mode footer, so the live read
    // honestly reports `no_footer` rather than guessing.
    const script = New("claude-code").Idle().StayAliveUntilStopped().Build();
    const conv = await openFake(script, {
      permissionMode: "bypassPermissions",
    });
    try {
      const { base } = await start(async () => conv);
      const o = await req(base, "POST", "/v1/conversations", {
        harness: "claude-code",
        binary_path: "/bin/x",
      });
      expect(o.status).toBe(201);

      const r = await req(base, "GET", path(o.json.id));
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({
        requested: "bypass",
        requested_raw: "bypassPermissions",
        observed: "unknown",
        source: "no_footer",
        stale: false,
      });
    } finally {
      await conv.close();
    }
  }, 30_000);
});

// ── POST /v1/conversations/{id}/permission-mode ──────────────────────────────
//
// MH-ONLY, no Go counterpart: the request decoding is not corpus-covered, so
// every row below is hand-written. The response body is the SAME DTO the GET
// above returns (permissionModeResponse), so a client parses one shape for both.

describe("permission-mode switch route", () => {
  const path = (id: string): string =>
    `/v1/conversations/${id}/permission-mode`;

  /** Open + acquire control; returns the wire id and the control token. */
  async function opened(
    fake: FakeConversation,
  ): Promise<{ base: string; id: string; token: string }> {
    const { base } = await serverFor(fake);
    const id = await open(base, fake);
    const token = (await req(base, "POST", `/v1/conversations/${id}/control`))
      .json.token as string;
    return { base, id, token };
  }

  test("un-tokened caller → 409 no_control (a switch is at least as privileged as a send)", async () => {
    const fake = new FakeConversation();
    const { base } = await serverFor(fake);
    const id = await open(base, fake);

    const r = await req(base, "POST", path(id), { permission_mode: "plan" });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("no_control");
    expect(fake.setTargets).toEqual([]);
  });

  test("the token gate covers the refresh form too — a codex re-probe writes /status", async () => {
    const fake = new FakeConversation();
    const { base } = await serverFor(fake);
    const id = await open(base, fake);

    const r = await req(base, "POST", path(id), { refresh: true });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("no_control");
    expect(fake.refreshes).toBe(0);
  });

  test("neither permission_mode nor refresh → 400 invalid_options", async () => {
    const fake = new FakeConversation();
    const { base, id, token } = await opened(fake);

    const r = await req(base, "POST", path(id), { token });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("invalid_options");
    expect(fake.refreshes).toBe(0);
    expect(fake.setTargets).toEqual([]);
  });

  test("both permission_mode and refresh → 400 invalid_options", async () => {
    const fake = new FakeConversation();
    const { base, id, token } = await opened(fake);

    const r = await req(base, "POST", path(id), {
      token,
      permission_mode: "plan",
      refresh: true,
    });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("invalid_options");
    expect(fake.setTargets).toEqual([]);
    expect(fake.refreshes).toBe(0);
  });

  test("a MISSPELLED key is 400 invalid_options, NEVER a silent refresh", async () => {
    // readJSON validates nothing, so without the explicit discriminator every
    // one of these would decode to `{}` + a 200 whose reading looks plausible
    // and whose mode never changed.
    const fake = new FakeConversation();
    const { base, id, token } = await opened(fake);

    for (const key of ["permissionMode", "mode", "permission-mode"]) {
      const r = await req(base, "POST", path(id), { token, [key]: "plan" });
      expect(r.status, key).toBe(400);
      expect(r.json.code, key).toBe("invalid_options");
    }
    expect(fake.refreshes).toBe(0);
    expect(fake.setTargets).toEqual([]);
  });

  test("an unknown mode token → 400 invalid_options, not a fall-through 500", async () => {
    // No sentinel row matches an unknown string, so without the syntactic check
    // this would reach FALLBACK → 500 internal. Includes the per-harness native
    // spellings: the gateway normalizes harness-agnostically, so they are NOT
    // admitted here.
    const fake = new FakeConversation();
    const { base, id, token } = await opened(fake);

    for (const mode of [
      "yolo",
      "",
      "bypassPermissions",
      "workspace-write",
      "read-only",
      "dontAsk",
    ]) {
      const r = await req(base, "POST", path(id), {
        token,
        permission_mode: mode,
      });
      expect(r.status, mode).toBe(400);
      expect(r.json.code, mode).toBe("invalid_options");
    }
    expect(fake.setTargets).toEqual([]);
  });

  test("a KNOWN token off this harness's axis → 409 permission_mode_unreachable", async () => {
    // Syntax is the gateway's call; reachability is chat's. `default` is a real
    // vocabulary member (codex's collaboration axis) and so passes the gateway's
    // check, then loses to the claude-shaped fake's axis.
    const fake = new FakeConversation();
    const { base, id, token } = await opened(fake);

    const r = await req(base, "POST", path(id), {
      token,
      permission_mode: "default",
    });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("permission_mode_unreachable");
  });

  test("timeout_seconds expiry → 504 timeout", async () => {
    const fake = new FakeConversation();
    const { base, id, token } = await opened(fake);
    fake.block = true;

    const r = await req(base, "POST", path(id), {
      token,
      permission_mode: "plan",
      timeout_seconds: 0.05,
    });
    expect(r.status).toBe(504);
    expect(r.json.code).toBe("timeout");
  });

  test("set: 200 carrying the GET's DTO shape, and the target really was driven", async () => {
    const fake = new FakeConversation();
    fake.reading = {
      requested: "bypass",
      requestedRaw: "bypassPermissions",
      observed: "acceptEdits",
      raw: "accept edits",
      source: "footer",
    };
    const { base, id, token } = await opened(fake);

    const r = await req(base, "POST", path(id), {
      token,
      permission_mode: "acceptedits", // the ladder spelling is case-insensitive
    });
    expect(r.status).toBe(200);
    expect(fake.setTargets).toEqual(["acceptEdits"]);
    expect(fake.refreshes).toBe(0);
    // Keys snake_case, rung values camelCase, source values snake_case — 102's
    // deliberate mix, reused verbatim.
    expect(r.json).toEqual({
      requested: "bypass",
      requested_raw: "bypassPermissions",
      observed: "acceptEdits",
      raw: "acceptEdits",
      source: "footer",
      generation: 8, // the cycle keystroke repainted
      current_generation: 8,
      stale: false,
      observed_at: "2026-07-22T18:04:11.220Z",
    });

    // Byte-for-byte the same shape the GET reports for the same session.
    const g = await req(base, "GET", path(id));
    expect(Object.keys(g.json).sort()).toEqual(Object.keys(r.json).sort());
  });

  test("refresh: 200 carrying the GET's DTO shape, and nothing was driven", async () => {
    const fake = new FakeConversation();
    fake.reading = {
      observed: "auto",
      raw: "Full access",
      collaboration: "default",
      source: "status",
    };
    const { base, id, token } = await opened(fake);

    const r = await req(base, "POST", path(id), { token, refresh: true });
    expect(r.status).toBe(200);
    expect(fake.refreshes).toBe(1);
    expect(fake.setTargets).toEqual([]);
    expect(r.json).toEqual({
      observed: "auto",
      raw: "Full access",
      collaboration: "default",
      source: "status",
      generation: 7,
      current_generation: 7,
      stale: false,
      observed_at: "2026-07-22T18:04:11.220Z",
    });
  });

  test("404 on an unknown id", async () => {
    const { base } = await start();
    const r = await req(base, "POST", path("no-such-conversation"), {
      permission_mode: "plan",
    });
    expect(r.status).toBe(404);
    expect(r.json.code).toBe("not_found");
  });

  test("malformed JSON → 400 invalid_json", async () => {
    const fake = new FakeConversation();
    const { base, id } = await opened(fake);
    const res = await fetch(base + path(id), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_json");
  });
});

// ── SSE collection helper ────────────────────────────────────────────────────

interface Collector {
  take(
    n: number,
    timeoutMs: number,
  ): Promise<{ type: string; [k: string]: unknown }[]>;
  close(): void;
}

/** Open an SSE stream and parse `data:` frames as JSON until closed. */
function collectSSE(base: string, path: string): Collector {
  const controller = new AbortController();
  const frames: { type: string }[] = [];
  const waiters: (() => void)[] = [];
  let done = false;

  void (async () => {
    try {
      const res = await fetch(base + path, { signal: controller.signal });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done: rdone } = await reader.read();
        if (rdone) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of chunk.split("\n")) {
            if (line.startsWith("data: ")) {
              try {
                frames.push(JSON.parse(line.slice(6)));
              } catch {
                /* skip */
              }
            }
          }
          for (const w of waiters.splice(0)) w();
        }
      }
    } catch {
      /* aborted */
    } finally {
      done = true;
      for (const w of waiters.splice(0)) w();
    }
  })();

  return {
    async take(n, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (frames.length < n && !done) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await Promise.race([
          new Promise<void>((r) => waiters.push(r)),
          new Promise<void>((r) => setTimeout(r, remaining)),
        ]);
      }
      return frames.slice();
    },
    close() {
      controller.abort();
    },
  };
}
