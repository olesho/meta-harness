// JSONL transcript parsing. Ported from harness-wrapper's parse.go. Malformed
// lines are skipped (never fatal), matching the Go reader.

import type { Line } from "./line.ts";

interface RawLine {
  type?: string;
  role?: string;
  uuid?: string;
  message?: unknown;
  timestamp?: string;
}

// normalizeLineType ensures line.type is populated for all formats: Claude Code
// uses "type" while Cursor uses "role" for the same purpose.
function normalizeLineType(line: Line): void {
  if (line.type === "" && line.role) {
    line.type = line.role;
  }
}

// parseFromBytes parses transcript content. Malformed lines are skipped.
export function parseFromBytes(content: string): Line[] {
  const lines: Line[] = [];
  for (const raw of content.split("\n")) {
    if (raw.length === 0) continue;
    let obj: RawLine;
    try {
      obj = JSON.parse(raw) as RawLine;
    } catch {
      continue;
    }
    const line: Line = {
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
