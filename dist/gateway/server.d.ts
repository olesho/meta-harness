#!/usr/bin/env node
import { type IncomingMessage, type ServerResponse } from "node:http";
import { type ConversationEvent, type InputAnswer, type Options, type Turn } from "../chat/index.ts";
import type { Snapshot } from "../screen/screen.ts";
import { Context } from "../internal/async/index.ts";
import { type InputRequestDTO, type TurnDTO } from "./dto.ts";
import { type EventSource } from "./fanout.ts";
export interface ConversationLike {
    /** The chat session id — ALSO the daemon's registry key (Go's `openConv`). */
    sessionID(): string;
    /** The single-consumer event channel; the Fanout is its sole drainer. */
    events(): EventSource;
    /** Block until granted the exclusive control token; returns a release closure. */
    acquireControl(ctx: Context): Promise<() => void>;
    send(ctx: Context, text: string): Promise<string>;
    answer(ctx: Context, requestID: string, ans: InputAnswer): Promise<void>;
    history(): Promise<Turn[]>;
    screenSnapshot(): Snapshot;
    close(ctx?: Context): Promise<void>;
}
/** Opens a Conversation for a decoded open request. Injectable for tests. */
export type Opener = (opts: Options) => Promise<ConversationLike>;
/** Mint an opaque 16-byte hex token (control tokens; matches Go's `newToken`). */
export declare function newToken(): string;
/** Typed SSE envelope; discriminated by `type` (Go's eventDTO). */
interface EventEnvelopeDTO {
    type: string;
    turn?: TurnDTO;
    input?: InputRequestDTO;
    error?: string;
}
/** Encode a ConversationEvent to its wire envelope (Go's toEventDTO). */
export declare function eventDTO(ev: ConversationEvent): EventEnvelopeDTO;
export declare class Server {
    private readonly convs;
    private readonly routes;
    private readonly opener;
    private accepting;
    constructor(opts?: {
        open?: Opener;
    });
    /** The `node:http` request listener. Dispatches the route table (Go's Routes). */
    handle: (req: IncomingMessage, res: ServerResponse) => void;
    /**
     * Graceful shutdown: stop accepting, then for every conversation release all
     * control tokens and close it. Empties the registry synchronously so no
     * in-flight lookup revives a torn-down entry (Go's Server.Shutdown).
     */
    shutdown(ctx?: Context): Promise<void>;
    private buildRoutes;
    private healthz;
    /**
     * POST /v1/turns — one-shot RunTurn. SCAFFOLD ONLY: the richer RunTurn/
     * TurnResult it needs is not yet available (today's `src/oneshot`
     * `runOneShotDetailed` returns the thinner OneShotOutcome), so the handler
     * validates the request shape then returns a clear "not yet available" path.
     * Its integration test is marked PENDING until that lands.
     */
    private runTurn;
    /** POST /v1/conversations — open. Uses a BACKGROUND context (see defaultOpener). */
    private openConv;
    /** GET /v1/conversations — list. */
    private listConvs;
    /**
     * DELETE /v1/conversations/{id} — close + releaseAll. ATOMIC per the registry
     * contract: look the entry up once and, if present, delete it SYNCHRONOUSLY
     * (no await between the presence check and the delete) so an in-flight handler
     * that already captured the entry either finishes or sees ErrClosed→410, never
     * a half-torn-down state.
     */
    private closeConv;
    /** POST /v1/conversations/{id}/control — acquire control, mint a token. */
    private acquireControl;
    /** DELETE /v1/conversations/{id}/control/{token} — release. */
    private releaseControl;
    /**
     * POST /v1/conversations/{id}/messages — send. GATED on the daemon's own
     * hasToken(token) BEFORE calling send. The chat `send` self-guards with
     * ErrNoControl only when NOBODY holds control; the daemon gate additionally
     * rejects a caller who holds no token.
     */
    private sendMessage;
    /**
     * POST /v1/conversations/{id}/input — answer. Token-gated like send. Parses
     * the SUPERSET answerRequest (incl `option_ids[]`) via the DTO layer, so a
     * multi-select prompt is reachable over HTTP.
     */
    private answerInput;
    /**
     * GET /v1/conversations/{id}/events — SSE. Subscribes to the eager Fanout,
     * NEVER to events() directly, so early turn/input events are replayed to the
     * first subscriber. Per-subscriber lifecycle is a request-scoped Context.
     */
    private streamEvents;
    /** GET /v1/conversations/{id}/history. */
    private history;
    /** GET /v1/conversations/{id}/screen — a pure read; requires no token. */
    private screen;
    /** Look the entry up once at handler entry; 404 when absent (Go's lookup). */
    private lookup;
}
/** Parse `--bind host:port` from argv; defaults to localhost-only. */
export declare function parseBind(argv: string[]): string;
export declare function main(argv: string[]): Promise<void>;
export {};
//# sourceMappingURL=server.d.ts.map