import type { ServerResponse } from "node:http";
/** An HTTP outcome: numeric status + stable machine-readable code. */
export interface ErrorMapping {
    status: number;
    code: string;
}
/** Map a chat-path error to its HTTP outcome (exported for testing/reuse). */
export declare function mapChatError(err: unknown): ErrorMapping;
/** Map a run-turn-path error: context sentinels first, then the chat table. */
export declare function mapRunTurnError(err: unknown): ErrorMapping;
/** writeChatError: map a thrown chat error and write its JSON body. */
export declare function writeChatError(res: ServerResponse, err: unknown): void;
/**
 * writeRunTurnError: like writeChatError but ALSO maps the context sentinels
 * (ctxDeadlineExceeded→504, ctxCanceled→408) before falling back to the chat
 * table. Ported from Go's writeRunTurnError.
 */
export declare function writeRunTurnError(res: ServerResponse, err: unknown): void;
//# sourceMappingURL=errors.d.ts.map