// Reads Gemini CLI session transcripts. Gemini writes one JSONL per session at:
//   ~/.gemini/tmp/<project>/chats/session-<YYYY-MM-DDTHH-MM>-<short-id>.jsonl
// where <project> is the slug ~/.gemini/projects.json maps the cwd to, and
// <short-id> is the first 8 hex chars of the session UUID. Ported from
// harness-wrapper's gemini/gemini.go.

import { readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import { wrap } from "../../internal/async/index.ts"
import { ErrEmptySessionID, ErrSessionNotFound } from "../errors.ts"
import { EventText, SourceFile, type Event } from "../event.ts"

export class GeminiReader {
  // geminiRoot overrides the default ~/.gemini location.
  geminiRoot: string

  constructor(geminiRoot = "") {
    this.geminiRoot = geminiRoot
  }

  // read returns the canonical Event stream for the given Gemini session UUID.
  // workingDir is required: Gemini indexes session files by per-project slug.
  read(harnessSessionID: string, workingDir = ""): Event[] {
    if (harnessSessionID === "") {
      throw wrap("gemini transcript: empty session id", ErrEmptySessionID)
    }
    const file = this.locate(harnessSessionID, workingDir)
    return parseJSONL(file)
  }

  private resolveRoot(): string {
    if (this.geminiRoot !== "") return this.geminiRoot
    return path.join(homedir(), ".gemini")
  }

  // projectSlug returns the slug Gemini assigns to a working directory, looked
  // up in ~/.gemini/projects.json. Returns undefined if not mapped or missing.
  projectSlug(workingDir: string): string | undefined {
    const root = this.resolveRoot()
    let data: string
    try {
      data = readFileSync(path.join(root, "projects.json"), "utf8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw wrap("gemini transcript: read projects.json", err)
    }
    let projects: { projects?: Record<string, string> }
    try {
      projects = JSON.parse(data) as { projects?: Record<string, string> }
    } catch (err) {
      throw wrap("gemini transcript: parse projects.json", err)
    }
    const slug = projects.projects?.[workingDir]
    if (!slug) return undefined
    return slug
  }

  // locate consults the projects.json mapping first, then walks every
  // ~/.gemini/tmp/*/chats/ directory for a file matching the short id.
  private locate(sessionID: string, workingDir: string): string {
    const root = this.resolveRoot()
    const short = sessionShort(sessionID)
    const suffix = "-" + short + ".jsonl"

    if (workingDir !== "") {
      const slug = this.projectSlug(workingDir)
      if (slug) {
        const hit = findInChats(
          path.join(root, "tmp", slug, "chats"),
          sessionID,
          suffix,
        )
        if (hit) return hit
      }
    }

    const tmpRoot = path.join(root, "tmp")
    let entries: string[]
    try {
      entries = readdirSync(tmpRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch (err) {
      throw wrap(`gemini transcript: read ${tmpRoot}`, err)
    }
    for (const name of entries) {
      const hit = findInChats(path.join(tmpRoot, name, "chats"), sessionID, suffix)
      if (hit) return hit
    }
    throw wrap(
      `gemini transcript: no session file for ${sessionID} under ${tmpRoot}`,
      ErrSessionNotFound,
    )
  }
}

// parseFile parses a Gemini JSONL session transcript at an explicit path. Unlike
// read it does NOT locate the file.
export function parseFile(p: string): Event[] {
  return parseJSONL(p)
}

// findInChats looks for the session file in a single chats/ directory by
// filename suffix, confirming the embedded sessionId in the header line.
function findInChats(
  chatsDir: string,
  sessionID: string,
  suffix: string,
): string | undefined {
  let entries: string[]
  try {
    entries = readdirSync(chatsDir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
  } catch {
    return undefined
  }
  for (const name of entries) {
    if (!name.endsWith(suffix)) continue
    const p = path.join(chatsDir, name)
    if (confirmHeader(p, sessionID)) return p
  }
  return undefined
}

function confirmHeader(p: string, sessionID: string): boolean {
  let data: string
  try {
    data = readFileSync(p, "utf8")
  } catch {
    return false
  }
  const first = data.split("\n", 1)[0]
  if (!first) return false
  try {
    const hdr = JSON.parse(first) as { sessionId?: string }
    return hdr.sessionId === sessionID
  } catch {
    return false
  }
}

// sessionShort returns the first 8 hex chars of a session UUID.
export function sessionShort(id: string): string {
  const dash = id.indexOf("-")
  if (dash >= 0) id = id.slice(0, dash)
  if (id.length > 8) id = id.slice(0, 8)
  return id
}

interface GeminiLine {
  sessionId?: string
  projectHash?: string
  kind?: string
  role?: string
  parts?: { text?: string }[]
  type?: string
  message?: unknown
  timestamp?: string
}

function parseJSONL(p: string): Event[] {
  let data: string
  try {
    data = readFileSync(p, "utf8")
  } catch (err) {
    throw wrap(`gemini transcript: open ${p}`, err)
  }
  const out: Event[] = []
  let lineNo = 0
  for (const raw of data.split("\n")) {
    lineNo++
    if (raw.length === 0) continue
    let ln: GeminiLine
    try {
      ln = JSON.parse(raw) as GeminiLine
    } catch (err) {
      throw wrap(`gemini transcript: parse line ${lineNo} in ${p}`, err)
    }
    // Skip the metadata header.
    if (ln.kind && !ln.role && !ln.type) continue
    const role = normalizeRole(ln.role ?? "", ln.type ?? "")
    if (role === "") continue
    const text = extractText(ln)
    if (text === "") continue
    let ts: Date | undefined
    if (ln.timestamp) {
      const d = new Date(ln.timestamp)
      if (!Number.isNaN(d.getTime())) ts = d
    }
    out.push({ role, type: EventText, text, timestamp: ts, source: SourceFile })
  }
  return out
}

// normalizeRole maps observed role/type strings to the transcript vocabulary.
// Gemini uses "model" where other harnesses use "assistant".
function normalizeRole(role: string, typ: string): string {
  switch (role) {
    case "user":
      return "user"
    case "model":
    case "assistant":
      return "assistant"
    case "system":
      return "system"
  }
  switch (typ) {
    case "user":
      return "user"
    case "model":
    case "assistant":
      return "assistant"
    case "system":
    case "tool":
      return "system"
  }
  return ""
}

function extractText(ln: GeminiLine): string {
  if (ln.parts && ln.parts.length > 0) {
    const parts: string[] = []
    for (const part of ln.parts) {
      if (part.text) parts.push(part.text)
    }
    return parts.join("\n\n")
  }
  if (typeof ln.message === "string") return ln.message
  return ""
}
