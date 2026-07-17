export declare const lockStaleTTLMs = 30000;
export interface LockOptions {
    acquireTimeoutMs?: number;
    staleTTLMs?: number;
}
export declare function withLockedFile<T>(configPath: string, fn: () => T, opts?: LockOptions): T;
export declare function atomicWriteFileSync(configPath: string, data: string, mode?: number): void;
//# sourceMappingURL=lock.d.ts.map