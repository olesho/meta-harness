// Claude Code JSONL → canonical Event parser. Ported from harness-wrapper's
// claudecode/parse_claude.go (originally entireio/cli). Each Event is tagged
// source=file with a dedup-stable nativeID.

import {
  ContentTypeText,
  ContentTypeToolUse,
  TypeAssistant,
  TypeUser,
  type Line,
} from "../line.ts";
import {
  EventText,
  EventToolResult,
  EventToolUse,
  RoleAssistant,
  RoleTool,
  RoleUser,
  SourceFile,
  type Event,
} from "../event.ts";
import { parseFromBytes } from "../parse.ts";
import { stripIDEContextTags } from "../stripTags.ts";

// events parses a Claude Code JSONL transcript into the canonical event stream
// (one event per content block, tool-aware). Malformed lines are skipped.
export function events(data: string): Event[] {
  const lines = parseFromBytes(data);
  const out: Event[] = [];
  const seq = { v: 0 };
  for (const line of lines) {
    const ts = parseLineTimestamp(line.timestamp);
    switch (line.type) {
      case TypeUser:
        out.push(...userLineEvents(line, ts, seq));
        break;
      case TypeAssistant:
        out.push(...assistantLineEvents(line, ts, seq));
        break;
    }
  }
  return out;
}

function parseLineTimestamp(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

// textNativeID gives a per-source-stable id for a text event. The line uuid
// alone would collapse multiple blocks from one line, so the per-event seq
// disambiguates.
function textNativeID(lineUUID: string, seq: number): string {
  return `${SourceFile}:text:${lineUUID}:${seq}`;
}

interface UserBlock {
  type?: string;
  text?: string;
  tool_use_id?: string;
  content?: unknown;
}

function userLineEvents(
  line: Line,
  ts: Date | undefined,
  seq: { v: number },
): Event[] {
  const msg = line.message as { content?: unknown } | undefined;
  if (!msg || msg.content === undefined) return [];
  const content = msg.content;

  // String content (direct user prompt).
  if (typeof content === "string") {
    const text = stripIDEContextTags(content);
    if (text === "") return [];
    const e: Event = {
      seq: seq.v,
      timestamp: ts,
      role: RoleUser,
      type: EventText,
      text,
      uuid: line.uuid,
      source: SourceFile,
      nativeID: textNativeID(line.uuid, seq.v),
    };
    seq.v++;
    return [e];
  }

  if (!Array.isArray(content)) return [];
  const out: Event[] = [];
  for (const raw of content as UserBlock[]) {
    switch (raw.type) {
      case "text": {
        const txt = stripIDEContextTags(raw.text ?? "");
        if (txt === "") continue;
        out.push({
          seq: seq.v,
          timestamp: ts,
          role: RoleUser,
          type: EventText,
          text: txt,
          uuid: line.uuid,
          source: SourceFile,
          nativeID: textNativeID(line.uuid, seq.v),
        });
        seq.v++;
        break;
      }
      case "tool_result":
        out.push({
          seq: seq.v,
          timestamp: ts,
          role: RoleTool,
          type: EventToolResult,
          output: extractToolResultText(raw.content),
          toolUseID: raw.tool_use_id,
          uuid: line.uuid,
          source: SourceFile,
          nativeID: "tool-result:" + (raw.tool_use_id ?? ""),
        });
        seq.v++;
        break;
    }
  }
  return out;
}

interface AssistantBlock {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  input?: unknown;
}

function assistantLineEvents(
  line: Line,
  ts: Date | undefined,
  seq: { v: number },
): Event[] {
  const msg = line.message as { content?: unknown } | undefined;
  if (!msg || !Array.isArray(msg.content)) return [];
  const out: Event[] = [];
  for (const block of msg.content as AssistantBlock[]) {
    switch (block.type) {
      case ContentTypeText:
        if (!block.text) continue;
        out.push({
          seq: seq.v,
          timestamp: ts,
          role: RoleAssistant,
          type: EventText,
          text: block.text,
          uuid: line.uuid,
          source: SourceFile,
          nativeID: textNativeID(line.uuid, seq.v),
        });
        seq.v++;
        break;
      case ContentTypeToolUse: {
        const id = block.id ?? "";
        out.push({
          seq: seq.v,
          timestamp: ts,
          role: RoleAssistant,
          type: EventToolUse,
          toolName: block.name,
          toolUseID: id,
          toolInput:
            block.input !== undefined ? JSON.stringify(block.input) : undefined,
          uuid: line.uuid,
          source: SourceFile,
          nativeID: "tool-use:" + id,
        });
        seq.v++;
        break;
      }
    }
  }
  return out;
}

// extractToolResultText pulls the text out of a tool_result block's content,
// either an array of text blocks or a plain string.
function extractToolResultText(raw: unknown): string {
  if (Array.isArray(raw)) {
    let sb = "";
    for (const tb of raw as { type?: string; text?: string }[]) {
      if (tb.type === "text") sb += (tb.text ?? "") + "\n";
    }
    return sb;
  }
  if (typeof raw === "string") return raw;
  return "";
}
