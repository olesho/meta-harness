/** Normalize a harness name for switch matching ("claude-code" → matches "claude"). */
export declare function normHarness(h: string): string;
export declare function prependArgs(args: string[], ...prefix: string[]): string[];
export declare function argsContainFlag(args: string[], flag: string): boolean;
export declare function argsContainConfigKey(args: string[], key: string): boolean;
//# sourceMappingURL=harnessargs.d.ts.map