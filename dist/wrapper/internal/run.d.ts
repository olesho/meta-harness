import { type Config } from "./config.ts";
import { type Result, type Session } from "./session.ts";
/** A cancellation context (the async toolkit's Context, or anything done()-shaped). */
export interface RunContext {
    done(): Promise<void>;
    err?(): unknown;
}
/**
 * Launch the configured harness under a pseudoterminal and return a live
 * Session. Throws a cause-chain error (ErrInvalidConfig / ErrBinaryNotFound /
 * ErrPTYAllocation) only when the wrapper itself fails to start; once a Session
 * is returned, every harness outcome flows through Session.wait().
 */
export declare function start(ctx: RunContext | undefined, cfg: Config): Promise<Session>;
/**
 * Start the harness, supervise it to completion, and return the normalized
 * outcome. A non-null err means the wrapper itself failed; harness outcomes are
 * always reported through result with err === null.
 */
export declare function run(ctx: RunContext | undefined, cfg: Config): Promise<{
    result: Result;
    err: Error | null;
}>;
//# sourceMappingURL=run.d.ts.map