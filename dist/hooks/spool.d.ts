import { type ParsedEvent } from "../transcript/event.ts";
export declare const spoolFileName = "events.jsonl";
export declare function spoolFilePath(spoolDir: string): string;
export declare function appendSpool(spoolDir: string, events: ParsedEvent[]): void;
export declare function drainSpool(spoolDir: string): ParsedEvent[];
//# sourceMappingURL=spool.d.ts.map