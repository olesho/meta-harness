#!/usr/bin/env node
import { type IncomingMessage, type ServerResponse } from "node:http";
import { type ConversationEvent, type InputAnswer, type Options, type PermissionModeReading, type Store, type Turn } from "../chat/index.ts";
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
    /**
     * A PURE read of the permission ladder — no PTY write, no store mutation.
     * `snap` is passed by the route so the reading and the staleness comparison
     * come from ONE frame.
     */
    permissionMode(snap?: Snapshot): PermissionModeReading;
    close(ctx?: Context): Promise<void>;
}
/**
 * Opens a Conversation for a decoded open request. Injectable for tests.
 *
 * `store` is OPTIONAL here, unlike on `Options`: it is the one required field a
 * JSON-decoding handler can never supply (a live object with no wire shape), and
 * defaultOpener fills it in. Widening the parameter this way lets openConv pass
 * its literal WITHOUT an `as Options` cast, which is what keeps TypeScript's
 * excess-property check alive on that literal — a misspelled or missing option
 * field is a compile error instead of a silently dropped property.
 */
export type Opener = (opts: Omit<Options, "store"> & {
    store?: Store;
}) => Promise<ConversationLike>;
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
     * POST /v1/turns — one-shot RunTurn. Opens a harness, submits one prompt,
     * waits for that turn to reach a terminal state, stops the harness, and
     * returns the full turn-result envelope (Go's `harness-chatd` /v1/turns).
     *
     * CONTEXT (§7): the handler passes a REQUEST-SCOPED, optionally-deadlined ctx
     * (requestContext) as runTurn's first argument, so `timeout_seconds` and
     * client disconnect can abort a wedged run (event-loop ctx sentinels →
     * 504/408 via writeRunTurnError) — a background ctx would make those dead
     * code and let an unanswered input request hang. The unattended
     * `AutoAcceptTrust` policy clears the trust prompt; the bounded ctx is the
     * primary guard against any other input kind hanging.
     *
     * TIMING (§3): a COMPLETED run pays runTurn's ~3s gracefulQuit floor before
     * responding, so client timeouts must budget for it. An errored turn skips
     * gracefulQuit and returns faster.
     */
    private runTurn;
    /**
     * Pre-check `effort` against the wrapper's own predicates. Returns false when
     * a 400 has been written and the handler must stop.
     *
     * Falsy skips, mirroring validateConfig's `if (cfg.effort && cfg.effort !== "")`.
     * Order is VALUE-then-harness here, matching that same block, so this
     * pre-check can never contradict the wrapper it fronts. (The permission-mode
     * guard below is deliberately the other way round, for the same reason.)
     */
    private checkEffort;
    /**
     * Pre-check `permission_mode` against the wrapper's own predicates. Returns
     * false when a 400 has been written and the handler must stop.
     *
     * Falsy skips: `""` is indistinguishable from omitted, exactly as the wrapper
     * treats it. Order is HARNESS-then-value, matching the wrapper's permission
     * validation, so `{"harness":"opencode","permission_mode":"plan"}` reports the
     * harness problem rather than a confusing value one.
     *
     * Both messages are deliberately HARNESS-AGNOSTIC — they never name the
     * supported set. The wrapper's own errors do name it, because that is where
     * the vocabulary is defined; restating it under src/gateway/ would re-freeze
     * the very table this pre-check delegates, and it would go stale silently the
     * moment a third harness is added. Semantically aligned, textually agnostic —
     * please do not "fix" this back.
     */
    private checkPermissionMode;
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
    /**
     * GET /v1/conversations/{id}/permission-mode — a pure read; requires no
     * token (it mutates nothing: no PTY write, no store write).
     *
     * ONE SNAPSHOT SERVES BOTH GENERATIONS. `Snapshot.generation` increments on
     * every successful write/resize and claude repaints continuously, so calling
     * `permissionMode()` and THEN `screenSnapshot()` would see a bumped
     * generation from any byte arriving in between and report `stale: true` on a
     * genuinely live read. Taking the frame once means the reading and the
     * comparison can never disagree about which frame they saw.
     */
    private permissionMode;
    /** Look the entry up once at handler entry; 404 when absent (Go's lookup). */
    private lookup;
}
/** Parse `--bind host:port` from argv; defaults to localhost-only. */
export declare function parseBind(argv: string[]): string;
export declare function main(argv: string[]): Promise<void>;
export {};
//# sourceMappingURL=server.d.ts.map