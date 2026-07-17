export declare class PathEscapeError extends Error {
    readonly baseDir: string;
    readonly candidate: string;
    constructor(baseDir: string, candidate: string);
}
export declare function resolveWithinBase(baseDir: string, candidate: string): string;
export declare function isWithinBase(baseDir: string, candidate: string): boolean;
//# sourceMappingURL=pathguard.d.ts.map