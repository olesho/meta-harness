import type { Event } from "../event.ts";
export declare class CodexReader {
    sessionsRoot: string;
    constructor(sessionsRoot?: string);
    read(harnessSessionID: string, _workingDir?: string): Event[];
    locateLatestSession(workingDir: string): string | undefined;
    resolveRoot(): string;
    private locate;
}
//# sourceMappingURL=codex.d.ts.map