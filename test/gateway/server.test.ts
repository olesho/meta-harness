// Route-level integration tests for the meta-harness-chatd daemon (src/gateway/
// server.ts). Drives the real HTTP surface with a FAKE Conversation that mirrors
// the chat layer's guard semantics (real ControlQueue + real chat sentinels +
// real EventBus), so the full open→control→send→SSE→answer→history→close flow,
// the error-mapping rows, the id scheme, close-vs-in-flight atomicity, the
// no-lost-events guarantee, and the multi-select round-trip are exercised
// against genuine chat behavior without spawning a PTY-backed harness.

import { afterEach, describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
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
  ErrStaleInputRequest,
  ErrTurnInFlight,
  ErrUnknownHarness,
  ErrUnknownOption,
  type InputAnswer,
  type InputRequest,
  type Turn,
} from "../../src/chat/index.ts";
import { Context, ctxCanceled } from "../../src/internal/async/index.ts";
import type { Snapshot } from "../../src/screen/screen.ts";
import {
  New,
  PromptRef,
  fakeHarnessBin,
  fakeLaunchEnv,
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
  screenSnapshot(): Snapshot {
    return {
      text: "SCREEN",
      cols: 80,
      rows: 24,
      cursorCol: 3,
      cursorRow: 1,
      generation: 7,
    };
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
