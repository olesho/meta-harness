import type { Event } from "../event.ts";
import { type Usage } from "../usage.ts";
export declare class CodexReader {
    sessionsRoot: string;
    constructor(sessionsRoot?: string);
    read(harnessSessionID: string, _workingDir?: string): Event[];
    readUsage(harnessSessionID: string, _workingDir?: string): Usage | null;
    locateLatestSession(workingDir: string): string | undefined;
    resolveRoot(): string;
    private locate;
}
//# sourceMappingURL=codex.d.ts.map