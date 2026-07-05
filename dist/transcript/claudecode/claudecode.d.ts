import type { Event } from "../event.ts";
export declare function encodedCWD(workingDir: string): string;
export declare class ClaudeCodeReader {
    projectsRoot: string;
    constructor(projectsRoot?: string);
    read(harnessSessionID: string, workingDir?: string): Event[];
    private resolveRoot;
    private locate;
}
//# sourceMappingURL=claudecode.d.ts.map