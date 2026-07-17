#!/usr/bin/env node
// meta-harness-chatd — the integrating HTTP+SSE daemon for `src/chat`.
//
// Exposes `src/chat.Conversation` over HTTP + SSE so non-Node clients can drive
// multi-turn harness conversations across a process boundary. Ported from the Go
// `cmd/harness-chatd` (`main.go` process entry/trust boundary, `server.go`
// `Server`/`NewServer`/`Routes()` + the `id → convEntry` registry, `sse.go`
// `newToken()`). Consumes the sibling gateway subtasks: the SSE fanout primitive
// (`./fanout.ts`, `./sse.ts`) and the DTO + error-mapping layer (`./dto.ts`,
// `./errors.ts`).
//
// TRUST BOUNDARY (carried verbatim from Go's `main.go`):
//
//   v1 has no auth; bind to localhost. See clients/ for reference clients.
//
// The daemon SPAWNS HARNESS PROCESSES on request. `--bind` therefore defaults to
// `127.0.0.1:<port>` (localhost-only). Do NOT bind `0.0.0.0` in v1: it would
// expose process-spawning to the network. There is no authentication layer.
//
// RUNTIME: Node ONLY (`#!/usr/bin/env node`). The daemon drives Conversations
// that spawn harnesses through node-pty, whose `onData`/`onExit` are DEAD under
// Bun (project memory `meta-harness-node-pty-bun-broken`). There is no
// "works under Bun" path.
import { createServer } from "node:http";
import { EventInputRequest, EventInputResolved, Open, } from "../chat/index.js";
import { Context } from "../internal/async/index.js";
import { conversationSummary, inputRequestDTO, openResponse, parseAnswerRequest, screenResponse, turnDTO, } from "./dto.js";
import { writeChatError, writeRunTurnError } from "./errors.js";
import { Fanout } from "./fanout.js";
import { streamSSE } from "./sse.js";
// The default opener hands `Conversation.Open` a BACKGROUND context — NOT a
// request-scoped one. Open passes this context to wrapper.Start, which keeps it
// for the lifetime of the harness process; a request-scoped context would cancel
// when the open handler returns and kill the harness (Go opens with
// context.Background() for exactly this reason).
const defaultOpener = (opts) => Open(Context.background(), opts);
// ── newToken (port of Go sse.go newToken) ────────────────────────────────────
/** Mint an opaque 16-byte hex token (control tokens; matches Go's `newToken`). */
export function newToken() {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    let s = "";
    for (const x of b)
        s += x.toString(16).padStart(2, "0");
    return s;
}
// ── convEntry — one live conversation + its daemon-owned token registry ───────
/**
 * A registered conversation: the Conversation, its eager Fanout (created at open
 * so no early event is lost), and the control-token map. The token map is the
 * daemon's own layer — `src/chat` returns a release closure, not a token string,
 * so the daemon mints the opaque token and stores `token → releaseClosure`
 * (mirrors Go's `convEntry.tokens map[string]func()`).
 */
class ConvEntry {
    id;
    conv;
    fan;
    harness;
    tokens = new Map();
    constructor(id, conv, fan, harness) {
        this.id = id;
        this.conv = conv;
        this.fan = fan;
        this.harness = harness;
    }
    /** Mint a token for an acquired control release closure; store and return it. */
    acquireToken(release) {
        const tok = newToken();
        this.tokens.set(tok, release);
        return tok;
    }
    /** Release + forget a token; returns false if the token was not held. */
    releaseToken(tok) {
        const rel = this.tokens.get(tok);
        if (rel === undefined)
            return false;
        this.tokens.delete(tok);
        rel();
        return true;
    }
    /** Whether this caller's token currently holds control (the send/answer gate). */
    hasToken(tok) {
        return this.tokens.has(tok);
    }
    /** Invoke and drop every outstanding release closure (close/shutdown). */
    releaseAll() {
        const rels = [...this.tokens.values()];
        this.tokens.clear();
        for (const rel of rels)
            rel();
    }
}
/** Read the whole request body and JSON-parse it; `{}` for an empty body. */
async function readJSON(req) {
    const chunks = [];
    for await (const chunk of req)
        chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (raw === "")
        return {};
    return JSON.parse(raw);
}
/** Write a JSON body with a status code. */
function writeJSON(res, status, body) {
    const payload = JSON.stringify(body);
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(payload);
}
/** Write an `{ error, code }` body (Go's writeError shape). */
function writeError(res, status, code, message) {
    writeJSON(res, status, { error: message, code });
}
/**
 * A per-request cancellation Context (Node lifecycle → chat `Context`). Cancelled
 * when the request or response closes (client disconnect); optionally bounded by
 * a deadline for timed ops (`timeout_seconds`). `src/chat`'s `Context` has no
 * AbortSignal constructor, so this bridges the Node `'close'` events onto it.
 */
function requestContext(req, res, timeoutSeconds) {
    const base = Context.withCancel(Context.background());
    let ctx = base.ctx;
    const cancels = [base.cancel];
    if (timeoutSeconds && timeoutSeconds > 0) {
        const d = Context.withDeadline(base.ctx, timeoutSeconds * 1000);
        ctx = d.ctx;
        cancels.push(d.cancel);
    }
    const onClose = () => base.cancel();
    req.on("close", onClose);
    res.on("close", onClose);
    return {
        ctx,
        cleanup: () => {
            req.off("close", onClose);
            res.off("close", onClose);
            for (const c of cancels)
                c();
        },
    };
}
/** Encode a ConversationEvent to its wire envelope (Go's toEventDTO). */
export function eventDTO(ev) {
    const out = { type: ev.type };
    if (ev.err !== undefined && ev.err !== null) {
        out.error = ev.err instanceof Error ? ev.err.message : String(ev.err);
    }
    if (ev.type === EventInputRequest || ev.type === EventInputResolved) {
        if (ev.input)
            out.input = inputRequestDTO(ev.input);
    }
    else if (ev.turn) {
        out.turn = turnDTO(ev.turn);
    }
    return out;
}
// ── The daemon ───────────────────────────────────────────────────────────────
export class Server {
    convs = new Map();
    routes;
    opener;
    accepting = true;
    constructor(opts = {}) {
        this.opener = opts.open ?? defaultOpener;
        this.routes = this.buildRoutes();
    }
    /** The `node:http` request listener. Dispatches the route table (Go's Routes). */
    handle = (req, res) => {
        const method = req.method ?? "GET";
        const path = new URL(req.url ?? "/", "http://localhost").pathname;
        const parts = splitPath(path);
        for (const route of this.routes) {
            if (route.method !== method)
                continue;
            const params = matchSegments(route.segments, parts);
            if (!params)
                continue;
            Promise.resolve(route.handler(req, res, params)).catch((err) => {
                // Last-resort guard: never leak an unhandled rejection; emit a 500.
                if (!res.headersSent)
                    writeError(res, 500, "internal", err instanceof Error ? err.message : String(err));
                else
                    res.end();
            });
            return;
        }
        writeError(res, 404, "not_found", "route not found");
    };
    /**
     * Graceful shutdown: stop accepting, then for every conversation release all
     * control tokens and close it. Empties the registry synchronously so no
     * in-flight lookup revives a torn-down entry (Go's Server.Shutdown).
     */
    async shutdown(ctx) {
        this.accepting = false;
        const entries = [...this.convs.values()];
        this.convs.clear();
        for (const e of entries) {
            e.releaseAll();
            await e.conv.close(ctx).catch(() => { });
        }
    }
    // ── Route table (port of server.go Routes) ─────────────────────────────────
    buildRoutes() {
        const defs = [
            ["GET", "/healthz", (_q, s) => this.healthz(s)],
            ["POST", "/v1/turns", (q, s) => this.runTurn(q, s)],
            ["POST", "/v1/conversations", (q, s) => this.openConv(q, s)],
            ["GET", "/v1/conversations", (_q, s) => this.listConvs(s)],
            ["DELETE", "/v1/conversations/:id", (q, s, p) => this.closeConv(q, s, p)],
            ["POST", "/v1/conversations/:id/control", (q, s, p) => this.acquireControl(q, s, p)],
            ["DELETE", "/v1/conversations/:id/control/:token", (_q, s, p) => this.releaseControl(s, p)],
            ["POST", "/v1/conversations/:id/messages", (q, s, p) => this.sendMessage(q, s, p)],
            ["POST", "/v1/conversations/:id/input", (q, s, p) => this.answerInput(q, s, p)],
            ["GET", "/v1/conversations/:id/events", (q, s, p) => this.streamEvents(q, s, p)],
            ["GET", "/v1/conversations/:id/history", (q, s, p) => this.history(q, s, p)],
            ["GET", "/v1/conversations/:id/screen", (_q, s, p) => this.screen(s, p)],
        ];
        return defs.map(([method, pattern, handler]) => ({
            method,
            segments: splitPath(pattern),
            handler,
        }));
    }
    // ── Handlers ───────────────────────────────────────────────────────────────
    healthz(res) {
        writeJSON(res, 200, { ok: true });
    }
    /**
     * POST /v1/turns — one-shot RunTurn. SCAFFOLD ONLY: the richer RunTurn/
     * TurnResult it needs is not yet available (today's `src/oneshot`
     * `runOneShotDetailed` returns the thinner OneShotOutcome), so the handler
     * validates the request shape then returns a clear "not yet available" path.
     * Its integration test is marked PENDING until that lands.
     */
    async runTurn(req, res) {
        let body;
        try {
            body = await readJSON(req);
        }
        catch (err) {
            writeError(res, 400, "invalid_json", err instanceof Error ? err.message : String(err));
            return;
        }
        const exitAfterTurn = body.exit_after_turn ?? true;
        if (!exitAfterTurn) {
            writeError(res, 400, "unsupported", "POST /v1/turns is one-shot and requires exit_after_turn=true");
            return;
        }
        writeError(res, 501, "not_implemented", "POST /v1/turns is not yet available (awaits the richer RunTurn/TurnResult)");
    }
    /** POST /v1/conversations — open. Uses a BACKGROUND context (see defaultOpener). */
    async openConv(req, res) {
        let body;
        try {
            body = await readJSON(req);
        }
        catch (err) {
            writeError(res, 400, "invalid_json", err instanceof Error ? err.message : String(err));
            return;
        }
        let conv;
        try {
            conv = await this.opener({
                harness: body.harness ?? "",
                binaryPath: body.binary_path ?? "",
                args: body.args,
                workingDir: body.working_dir,
                env: body.env,
                cols: body.cols,
                rows: body.rows,
                effort: body.effort,
                model: body.model,
                disableCodexAutoDismiss: body.disable_codex_auto_dismiss,
            });
        }
        catch (err) {
            writeChatError(res, err);
            return;
        }
        // Create the Fanout EAGERLY at open, before any subscriber — it is the sole
        // drainer of events(), so turn/input events fired before the first SSE
        // attach are buffered and replayed rather than dropped.
        const id = conv.sessionID();
        const entry = new ConvEntry(id, conv, new Fanout(conv.events()), body.harness ?? "");
        // Dedupe a second open of the same underlying session id (Go keys on the
        // session id). The presence check + set is synchronous — no await between.
        if (this.convs.has(id) || !this.accepting) {
            await conv.close().catch(() => { });
            if (!this.accepting)
                writeError(res, 503, "shutting_down", "server is shutting down");
            else
                writeError(res, 409, "already_open", "conversation already open for this session id");
            return;
        }
        this.convs.set(id, entry);
        writeJSON(res, 201, openResponse(id));
    }
    /** GET /v1/conversations — list. */
    listConvs(res) {
        const out = [...this.convs.values()].map((e) => conversationSummary(e.id, e.harness, e.conv.sessionID()));
        writeJSON(res, 200, out);
    }
    /**
     * DELETE /v1/conversations/{id} — close + releaseAll. ATOMIC per the registry
     * contract: look the entry up once and, if present, delete it SYNCHRONOUSLY
     * (no await between the presence check and the delete) so an in-flight handler
     * that already captured the entry either finishes or sees ErrClosed→410, never
     * a half-torn-down state.
     */
    async closeConv(req, res, params) {
        const id = params.id;
        const entry = this.convs.get(id);
        if (entry === undefined) {
            writeError(res, 404, "not_found", "conversation not found");
            return;
        }
        this.convs.delete(id); // synchronous remove — no await before this point
        entry.releaseAll();
        await entry.conv.close().catch(() => { });
        res.statusCode = 204;
        res.end();
    }
    /** POST /v1/conversations/{id}/control — acquire control, mint a token. */
    async acquireControl(req, res, params) {
        const entry = this.lookup(res, params);
        if (!entry)
            return;
        const { ctx, cleanup } = requestContext(req, res);
        try {
            const release = await entry.conv.acquireControl(ctx);
            const tok = entry.acquireToken(release);
            writeJSON(res, 200, { token: tok });
        }
        catch (err) {
            writeChatError(res, err);
        }
        finally {
            cleanup();
        }
    }
    /** DELETE /v1/conversations/{id}/control/{token} — release. */
    releaseControl(res, params) {
        const entry = this.lookup(res, params);
        if (!entry)
            return;
        if (!entry.releaseToken(params.token)) {
            writeError(res, 404, "unknown_token", "token not held");
            return;
        }
        res.statusCode = 204;
        res.end();
    }
    /**
     * POST /v1/conversations/{id}/messages — send. GATED on the daemon's own
     * hasToken(token) BEFORE calling send. The chat `send` self-guards with
     * ErrNoControl only when NOBODY holds control; the daemon gate additionally
     * rejects a caller who holds no token.
     */
    async sendMessage(req, res, params) {
        const entry = this.lookup(res, params);
        if (!entry)
            return;
        let body;
        try {
            body = await readJSON(req);
        }
        catch (err) {
            writeError(res, 400, "invalid_json", err instanceof Error ? err.message : String(err));
            return;
        }
        if (!entry.hasToken(body.token ?? "")) {
            writeError(res, 409, "no_control", "caller does not hold the control token");
            return;
        }
        const { ctx, cleanup } = requestContext(req, res, body.timeout_seconds);
        try {
            const turnID = await entry.conv.send(ctx, body.text ?? "");
            writeJSON(res, 202, { turn_id: turnID });
        }
        catch (err) {
            // A timed op: deadline/cancel map to 504/408 via writeRunTurnError, which
            // also falls through to the chat table for every other sentinel.
            writeRunTurnError(res, err);
        }
        finally {
            cleanup();
        }
    }
    /**
     * POST /v1/conversations/{id}/input — answer. Token-gated like send. Parses
     * the SUPERSET answerRequest (incl `option_ids[]`) via the DTO layer, so a
     * multi-select prompt is reachable over HTTP.
     */
    async answerInput(req, res, params) {
        const entry = this.lookup(res, params);
        if (!entry)
            return;
        let body;
        try {
            body = await readJSON(req);
        }
        catch (err) {
            writeError(res, 400, "invalid_json", err instanceof Error ? err.message : String(err));
            return;
        }
        if (!entry.hasToken(body.token ?? "")) {
            writeError(res, 409, "no_control", "caller does not hold the control token");
            return;
        }
        const ans = parseAnswerRequest(body);
        const { ctx, cleanup } = requestContext(req, res, body.timeout_seconds);
        try {
            await entry.conv.answer(ctx, body.request_id ?? "", ans);
            res.statusCode = 204;
            res.end();
        }
        catch (err) {
            writeRunTurnError(res, err);
        }
        finally {
            cleanup();
        }
    }
    /**
     * GET /v1/conversations/{id}/events — SSE. Subscribes to the eager Fanout,
     * NEVER to events() directly, so early turn/input events are replayed to the
     * first subscriber. Per-subscriber lifecycle is a request-scoped Context.
     */
    async streamEvents(req, res, params) {
        const entry = this.lookup(res, params);
        if (!entry)
            return;
        const { ctx, cleanup } = requestContext(req, res);
        const sub = entry.fan.subscribe();
        try {
            await streamSSE(res, sub, {
                encode: (ev) => JSON.stringify(eventDTO(ev)),
                signal: ctx.done(),
                req,
            });
        }
        finally {
            cleanup();
        }
    }
    /** GET /v1/conversations/{id}/history. */
    async history(req, res, params) {
        const entry = this.lookup(res, params);
        if (!entry)
            return;
        try {
            const turns = await entry.conv.history();
            writeJSON(res, 200, { turns: turns.map(turnDTO) });
        }
        catch (err) {
            writeError(res, 500, "history_failed", err instanceof Error ? err.message : String(err));
        }
    }
    /** GET /v1/conversations/{id}/screen — a pure read; requires no token. */
    screen(res, params) {
        const entry = this.lookup(res, params);
        if (!entry)
            return;
        writeJSON(res, 200, screenResponse(entry.conv.screenSnapshot()));
    }
    /** Look the entry up once at handler entry; 404 when absent (Go's lookup). */
    lookup(res, params) {
        const entry = this.convs.get(params.id);
        if (entry === undefined) {
            writeError(res, 404, "not_found", "conversation not found");
            return undefined;
        }
        return entry;
    }
}
// ── Path matching ────────────────────────────────────────────────────────────
/** Split a path into non-empty segments. */
function splitPath(path) {
    return path.split("/").filter((s) => s.length > 0);
}
/**
 * Match compiled route segments against request parts; returns the captured
 * params, or null if the shapes differ. `:name` segments capture; literals must
 * equal exactly.
 */
function matchSegments(segments, parts) {
    if (segments.length !== parts.length)
        return null;
    const params = {};
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (seg.startsWith(":")) {
            params[seg.slice(1)] = decodeURIComponent(parts[i]);
        }
        else if (seg !== parts[i]) {
            return null;
        }
    }
    return params;
}
// ── Process entry point (port of main.go) ────────────────────────────────────
const DEFAULT_BIND = "127.0.0.1:8080";
/** Parse `--bind host:port` from argv; defaults to localhost-only. */
export function parseBind(argv) {
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--bind")
            return argv[i + 1] ?? DEFAULT_BIND;
        if (a.startsWith("--bind="))
            return a.slice("--bind=".length);
    }
    return DEFAULT_BIND;
}
/** Split a `host:port` bind target into listen args (IPv6-aware, best-effort). */
function bindTarget(bind) {
    const idx = bind.lastIndexOf(":");
    if (idx < 0)
        return { host: "127.0.0.1", port: Number(bind) };
    const host = bind.slice(0, idx) || "127.0.0.1";
    const port = Number(bind.slice(idx + 1));
    return { host, port };
}
export async function main(argv) {
    const bind = parseBind(argv);
    const server = new Server();
    const httpServer = createServer(server.handle);
    const { host, port } = bindTarget(bind);
    await new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
            httpServer.off("error", reject);
            resolve();
        });
    });
    process.stderr.write(`harness-chatd: listening on ${bind}\n`);
    let shuttingDown = false;
    const onSignal = () => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        process.stderr.write("harness-chatd: shutting down\n");
        // Stop accepting, release all control tokens, close all conversations.
        httpServer.close();
        void server.shutdown().then(() => process.exit(0));
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
}
// Node-safe entry guard (mirrors src/cli/run.ts; import.meta.main is Node ≥24.2).
import { pathToFileURL } from "node:url";
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    main(process.argv.slice(2)).catch((err) => {
        process.stderr.write("harness-chatd: fatal: " + String(err) + "\n");
        process.exit(1);
    });
}
//# sourceMappingURL=server.js.map