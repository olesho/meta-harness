import type { Turn } from "../event.ts";
export declare class PiReader {
    root: string;
    private sessionsDir_;
    constructor(opts?: string | {
        root?: string;
        sessionsDir?: string;
    });
    read(harnessSessionID: string, workingDir?: string): Turn[];
    private configDir;
    private sessionsDir;
    private locate;
}
export declare function slugForCwd(cwd: string): string;
//# sourceMappingURL=pi.d.ts.map