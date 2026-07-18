#!/usr/bin/env node
import { type Result } from "../wrapper/api.ts";
/**
 * Maps a wrapper Result onto a process exit code. Ported from Go's
 * exitCodeFor (cmd/harness-wrapper/main.go:192-219); all ten Status constants
 * already exist 1:1 in both runtimes, so this is a straight port with no
 * parity gap.
 */
export declare function exitCodeFor(res: Result): number;
/**
 * Enables raw mode on stdin (when it is a TTY) and guarantees it is restored
 * exactly once, whether cleanup() is called from the normal control-flow path
 * or the process is torn down abnormally (an uncaught exception / rejected
 * promise reaching the top level still fires "exit" before Node terminates —
 * only signals that cannot be intercepted at all, like SIGKILL, bypass it).
 * There is no existing TS precedent for this in the repo (the two prior
 * raw-mode toggles are both bare try/catch with no finally and no exit
 * handler), so this is written and unit-tested as a small standalone guard
 * rather than inlined into the TTY branch below.
 */
export interface RawModeGuard {
    cleanup: () => void;
}
export declare function installRawModeGuard(stdin: Pick<NodeJS.ReadStream, "isTTY" | "setRawMode">): RawModeGuard;
export declare function main(argv: string[]): Promise<number>;
//# sourceMappingURL=wrapper.d.ts.map