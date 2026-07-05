export declare class RecentOutputBuffer {
    private readonly limit;
    private buf;
    constructor(limit: number);
    write(p: Uint8Array): void;
    string(): string;
}
export declare function newRecentOutput(limit: number): RecentOutputBuffer;
//# sourceMappingURL=recentOutput.d.ts.map