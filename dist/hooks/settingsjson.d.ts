export interface SettingsHookCmd {
    type: "command";
    command: string;
    timeout?: number;
}
export interface SettingsHookMatcher {
    matcher?: string;
    hooks: SettingsHookCmd[];
}
export type ManagedHooks = Record<string, SettingsHookMatcher[]>;
export declare function ensureSettingsJSONHooks(configPath: string, managed: ManagedHooks): void;
export declare function removeManagedHooks(configPath: string, events?: string[]): void;
//# sourceMappingURL=settingsjson.d.ts.map