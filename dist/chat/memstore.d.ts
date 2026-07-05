import type { Store } from "./store.ts";
import type { Session, Turn } from "./types.ts";
/** The in-memory implementation of chat.Store. */
export declare class MemStore implements Store {
    private readonly sessions;
    private readonly turns;
    createSession(s: Session | null | undefined): Promise<void>;
    getSession(id: string): Promise<Session>;
    updateSession(s: Session | null | undefined): Promise<void>;
    appendTurn(t: Turn | null | undefined): Promise<void>;
    updateTurn(t: Turn | null | undefined): Promise<void>;
    listTurns(sessionID: string): Promise<Turn[]>;
}
/** Construct an empty MemStore. */
export declare function newMemStore(): MemStore;
//# sourceMappingURL=memstore.d.ts.map