import type { Event } from "./event.ts";
export interface Reader {
    read(harnessSessionID: string, workingDir: string): Event[];
}
//# sourceMappingURL=reader.d.ts.map