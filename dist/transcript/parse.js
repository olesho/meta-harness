// JSONL transcript parsing. Ported from harness-wrapper's parse.go. Malformed
// lines are skipped (never fatal), matching the Go reader.
// normalizeLineType ensures line.type is populated for all formats: Claude Code
// uses "type" while Cursor uses "role" for the same purpose.
function normalizeLineType(line) {
    if (line.type === "" && line.role) {
        line.type = line.role;
    }
}
// parseFromBytes parses transcript content. Malformed lines are skipped.
export function parseFromBytes(content) {
    const lines = [];
    for (const raw of content.split("\n")) {
        if (raw.length === 0)
            continue;
        let obj;
        try {
            obj = JSON.parse(raw);
        }
        catch {
            continue;
        }
        const line = {
            type: obj.type ?? "",
            role: obj.role,
            uuid: obj.uuid ?? "",
            message: obj.message,
            timestamp: obj.timestamp,
        };
        normalizeLineType(line);
        lines.push(line);
    }
    return lines;
}
//# sourceMappingURL=parse.js.map