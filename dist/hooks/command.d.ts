export declare const hookMarkerPrefix = "meta-harness-hook";
export interface RenderHookCommandOptions {
    nodePath: string;
    distDir: string;
    event: string;
    args?: string[];
}
export declare function renderHookCommand(opts: RenderHookCommandOptions): string;
export declare function isManagedHookCommand(cmd: string): boolean;
//# sourceMappingURL=command.d.ts.map