import type { ParsedEvent } from "../transcript/event.ts";
export interface HookContext {
    cwd: string;
    home: string;
    configDir: string;
    spoolDir: string;
    harnessSessionID?: string;
}
export interface HookEntry {
    event: string;
    command: string;
    matcher?: string;
}
export interface HookSpec {
    configPath: string;
    events: HookEntry[];
    yield?: HookEntry;
    owner: string;
}
export interface StaticHookProfile {
    owner: string;
    entries: HookEntry[];
    yield?: HookEntry;
}
export declare function specFromProfile(profile: StaticHookProfile, configPath: string): HookSpec;
export interface HookProvider {
    ensureConfig(ctx: HookContext): HookSpec;
    parsePayload(raw: string, ctx: HookContext): ParsedEvent[];
}
//# sourceMappingURL=provider.d.ts.map