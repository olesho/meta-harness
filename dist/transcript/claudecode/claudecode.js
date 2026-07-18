// Reads Claude Code session transcripts. Claude Code writes one JSONL per
// session at ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl, where
// <encoded-cwd> is the cwd with every non-alphanumeric character replaced by
// '-'. Ported from harness-wrapper's claudecode/claudecode.go.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { wrap } from "../../internal/async/index.js";
import { ErrEmptySessionID, ErrEmptyWorkingDir, ErrSessionNotFound, } from "../errors.js";
import { usageFromClaudeJSONL } from "../usage.js";
import { events } from "./parseClaude.js";
// claudeCWDSanitize matches every character Claude Code rewrites when naming a
// project dir: anything that is not an ASCII letter or digit (including '.').
const claudeCWDSanitize = /[^A-Za-z0-9]/g;
// encodedCWD returns the directory-name-encoding Claude Code uses for project
// paths: every non-alphanumeric character becomes '-'.
export function encodedCWD(workingDir) {
    return workingDir.replace(claudeCWDSanitize, "-");
}
export class ClaudeCodeReader {
    // projectsRoot overrides the default ~/.claude/projects/ location.
    projectsRoot;
    constructor(projectsRoot = "") {
        this.projectsRoot = projectsRoot;
    }
    // read returns the canonical Event stream for the given Claude Code session
    // UUID. workingDir is required: Claude Code indexes transcripts by cwd.
    read(harnessSessionID, workingDir = "") {
        if (harnessSessionID === "") {
            throw wrap("claudecode transcript: empty session id", ErrEmptySessionID);
        }
        if (workingDir === "") {
            throw wrap("claudecode transcript: empty working dir", ErrEmptyWorkingDir);
        }
        const file = this.locate(harnessSessionID, workingDir);
        let data;
        try {
            data = readFileSync(file, "utf8");
        }
        catch (err) {
            throw wrap(`claudecode transcript: read ${file}`, err);
        }
        return events(data);
    }
    // readUsage returns the session's token totals (summed per API call), or null
    // when the transcript records no usage. Same locate rules as read().
    readUsage(harnessSessionID, workingDir = "") {
        if (harnessSessionID === "") {
            throw wrap("claudecode usage: empty session id", ErrEmptySessionID);
        }
        if (workingDir === "") {
            throw wrap("claudecode usage: empty working dir", ErrEmptyWorkingDir);
        }
        const file = this.locate(harnessSessionID, workingDir);
        let data;
        try {
            data = readFileSync(file, "utf8");
        }
        catch (err) {
            throw wrap(`claudecode usage: read ${file}`, err);
        }
        return usageFromClaudeJSONL(data);
    }
    resolveRoot() {
        if (this.projectsRoot !== "")
            return this.projectsRoot;
        return path.join(homedir(), ".claude", "projects");
    }
    // locate derives the project dir from the REALPATH of the cwd (Claude resolves
    // symlinks before encoding), then falls back to the path as given.
    locate(sessionID, workingDir) {
        const root = this.resolveRoot();
        const candidates = [];
        try {
            const resolved = realpathSync(workingDir);
            if (resolved !== workingDir)
                candidates.push(resolved);
        }
        catch {
            // EvalSymlinks failure → fall back to the path as given
        }
        candidates.push(workingDir);
        let firstPath = "";
        for (const wd of candidates) {
            const p = path.join(root, encodedCWD(wd), sessionID + ".jsonl");
            if (existsSync(p))
                return p;
            if (firstPath === "")
                firstPath = p;
        }
        throw wrap(`claudecode transcript: ${firstPath}`, ErrSessionNotFound);
    }
}
//# sourceMappingURL=claudecode.js.map