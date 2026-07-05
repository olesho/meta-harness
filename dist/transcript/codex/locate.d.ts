interface SessionMetaPayload {
    session_id?: string;
    cwd?: string;
}
export declare function walkJSONL(root: string): string[];
export declare function locateLatestSession(sessionsRoot: string, workingDir: string): string | undefined;
export declare function readSessionMeta(p: string): SessionMetaPayload | undefined;
export {};
//# sourceMappingURL=locate.d.ts.map