import { type Event } from "../event.ts";
export interface Envelope {
    timestamp?: string;
    type?: string;
    payload?: unknown;
}
export declare function parseRollout(data: string): Envelope[];
export declare function events(data: string): Event[];
//# sourceMappingURL=parseCodex.d.ts.map