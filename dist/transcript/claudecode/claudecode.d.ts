import type { Event } from "../event.ts";
import { type Usage } from "../usage.ts";
export declare function encodedCWD(workingDir: string): string;
export declare class ClaudeCodeReader {
    projectsRoot: string;
    constructor(projectsRoot?: string);
    read(harnessSessionID: string, workingDir?: string): Event[];
    readUsage(harnessSessionID: string, workingDir?: string): Usage | null;
    private resolveRoot;
    private locate;
}
//# sourceMappingURL=claudecode.d.ts.map