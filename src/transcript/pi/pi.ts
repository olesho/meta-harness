// Reads pi coding-agent session transcripts (@earendil-works/pi-coding-agent).
//
// pi writes one JSONL per session at:
//   <config>/sessions/--<cwd-slug>--/<timestamp>_<uuid>.jsonl
// where <config> defaults to ~/.pi/agent (overridable via PI_CODING_AGENT_DIR)
// and <cwd-slug> is the cwd with separators rendered as hyphens, wrapped in
// "--" … "--". The reader returns the lossy Turn view (matching pi.go).

import { readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import { wrap } from "../../internal/async/index.ts"
import { ErrEmptySessionID, ErrSessionNotFound } from "../errors.ts"
import type { Turn } from "../event.ts"
import { cleanPosix } from "../pathutil.ts"

export class PiReader {
  // root overrides the pi agent config directory (the ~/.pi/agent equivalent).
  // Empty means consult PI_CODING_AGENT_DIR then fall back to ~/.pi/agent.
  root: string
  // sessionsDir_ pins the exact sessions dir the launcher used (highest
  // precedence). Empty means derive from root/env.
  private sessionsDir_: string

  // The constructor accepts either the legacy positional `root` string or an
  // options bag, kept backward-compatible so existing `new PiReader(root)` /
  // `new PiReader()` callers keep working.
  constructor(opts: string | { root?: string; sessionsDir?: string } = "") {
    if (typeof opts === "string") {
      this.root = opts
      this.sessionsDir_ = ""
    } else {
      this.root = opts.root ?? ""
      this.sessionsDir_ = opts.sessionsDir ?? ""
    }
  }

  // read returns the ordered list of turns for the given pi session UUID.
  read(harnessSessionID: string, workingDir = ""): Turn[] {
    if (harnessSessionID === "") {
      throw wrap("pi transcript: empty session id", ErrEmptySessionID)
    }
    const file = this.locate(harnessSessionID, workingDir)
    return parseJSONL(file)
  }

  private configDir(): string {
    if (this.root !== "") return this.root
    const env = process.env.PI_CODING_AGENT_DIR
    if (env) return env
    return path.join(homedir(), ".pi", "agent")
  }

  private sessionsDir(): string {
    // Precedence: pinned launch dir › root/sessions › PI_CODING_AGENT_SESSION_DIR
    // › ${PI_CODING_AGENT_DIR||~/.pi/agent}/sessions.
    if (this.sessionsDir_ !== "") return this.sessionsDir_
    if (this.root !== "") return path.join(this.root, "sessions")
    const direct = process.env.PI_CODING_AGENT_SESSION_DIR
    if (direct) return direct
    return path.join(this.configDir(), "sessions")
  }

  // locate first probes the per-cwd slug directory and, failing that, walks
  // every sessions/*/ directory. A filename-contains-id match is confirmed
  // against the file's header "id".
  private locate(sessionID: string, workingDir: string): string {
    const sessionsDir = this.sessionsDir()

    if (workingDir !== "") {
      const slugDir = path.join(sessionsDir, slugForCwd(workingDir))
      const hit = findInDir(slugDir, sessionID)
      if (hit) return hit
    }

    let entries: string[]
    try {
      entries = readdirSync(sessionsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch (err) {
      // A missing sessions dir is the fresh-session case — surface it as the
      // ErrSessionNotFound sentinel so callers can fall back to store history.
      // Genuine failures (permissions, etc.) keep propagating raw.
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        throw wrap(
          `pi transcript: no session file for ${sessionID} under ${sessionsDir}`,
          ErrSessionNotFound,
        )
      }
      throw wrap(`pi transcript: read ${sessionsDir}`, err)
    }
    for (const name of entries) {
      const hit = findInDir(path.join(sessionsDir, name), sessionID)
      if (hit) return hit
    }
    throw wrap(
      `pi transcript: no session file for ${sessionID} under ${sessionsDir}`,
      ErrSessionNotFound,
    )
  }
}

// findInDir looks for a session file in a single directory whose name contains
// sessionID and whose header "id" confirms the match.
function findInDir(dir: string, sessionID: string): string | undefined {
  let entries: string[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
  } catch {
    return undefined // absent dir → no match
  }
  for (const name of entries) {
    if (!name.endsWith(".jsonl") || !name.includes(sessionID)) continue
    const p = path.join(dir, name)
    if (confirmHeader(p, sessionID)) return p
  }
  return undefined
}

// confirmHeader reads the first line of path and returns true when its "id"
// matches sessionID.
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
    const hdr = JSON.parse(first) as { id?: string }
    return hdr.id === sessionID
  } catch {
    return false
  }
}

// slugForCwd renders a working directory the way pi names its per-cwd session
// directory: separators become hyphens, wrapped in "--".
export function slugForCwd(cwd: string): string {
  const trimmed = cleanPosix(cwd).replace(/^\/+/, "").replace(/\/+$/, "")
  return "--" + trimmed.replace(/\//g, "-") + "--"
}

interface PiMessage {
  role?: string
  content?: unknown
}

interface PiLine {
  type?: string
  timestamp?: string
  message?: PiMessage
}

function parseJSONL(p: string): Turn[] {
  let data: string
  try {
    data = readFileSync(p, "utf8")
  } catch (err) {
    throw wrap(`pi transcript: open ${p}`, err)
  }
  const out: Turn[] = []
  let lineNo = 0
  for (const raw of data.split("\n")) {
    lineNo++
    if (raw.length === 0) continue
    let ln: PiLine
    try {
      ln = JSON.parse(raw) as PiLine
    } catch (err) {
      throw wrap(`pi transcript: parse line ${lineNo} in ${p}`, err)
    }
    // Only message lines carry conversation content.
    if (ln.type !== "message" || !ln.message) continue
    const role = normalizeRole(ln.message.role ?? "")
    if (role === "") continue
    const text = extractText(ln.message.content)
    if (text === "") continue
    let ts: Date | undefined
    if (ln.timestamp) {
      const d = new Date(ln.timestamp)
      if (!Number.isNaN(d.getTime())) ts = d
    }
    out.push({ role, text, timestamp: ts })
  }
  return out
}

// normalizeRole maps pi's roles to the transcript vocabulary. Tool results fold
// into "system".
function normalizeRole(role: string): string {
  switch (role) {
    case "user":
      return "user"
    case "assistant":
      return "assistant"
    case "toolResult":
    case "tool":
    case "system":
      return "system"
  }
  return ""
}

// extractText pulls displayable text out of a message "content" field, which pi
// encodes either as a bare string or an array of typed blocks. Only "text"
// blocks contribute; multiple are joined with a blank line.
function extractText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const b of content) {
      if (b && typeof b === "object") {
        const block = b as { type?: string; text?: string }
        if (block.type === "text" && block.text) parts.push(block.text)
      }
    }
    return parts.join("\n\n")
  }
  return ""
}
