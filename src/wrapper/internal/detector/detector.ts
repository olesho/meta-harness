// Generic pattern primitives for harness classifiers. Patterns are matched
// against the recent harness output (typically the last ~64KB), with ANSI
// escapes already stripped.
//
// This is the TS port of pkg/wrapper/internal/detector. Durations are
// represented as milliseconds (the TS analogue of Go's time.Duration), and
// absolute times as JS Date instants. Because JS Date carries no IANA
// location, `Now` pairs an instant with the zone used to resolve banners that
// omit a timezone.

/** A wall-clock instant paired with the IANA zone used to resolve it. */
export interface Now {
  /** The absolute instant ("now"). */
  date: Date
  /** IANA timezone name used when a banner omits its own TZ. */
  zone: string
}

/** What an APIErrorMatcher returns when it recognizes an upstream API error. */
export interface APIErrorHit {
  /** HTTP status code, or 0 when the output had no numeric code. */
  code: number
  /** Human-readable detail extracted from the matched line. */
  message: string
  /** Suggested wait in milliseconds, or 0 when no hint was parseable. */
  retryAfter: number
}

/** Inspects already-ANSI-stripped output for a recognized API error. */
export type APIErrorMatcher = (stripped: string) => APIErrorHit | null

/** What a SessionLimitMatcher returns on a session-limit banner. */
export interface SessionLimitHit {
  /** Human-readable detail extracted from the matched banner. */
  message: string
  /** Absolute reset instant, or null when none was parseable. */
  resumeAt: Date | null
}

/** Inspects already-ANSI-stripped output for a recognized session-limit banner. */
export type SessionLimitMatcher = (
  stripped: string,
  now: Now,
) => SessionLimitHit | null

/** Per-harness fingerprints a classifier consults. */
export interface Patterns {
  cost?: string[]
  retry?: string[]
  prompt?: string[]
  apiError?: APIErrorMatcher | null
  sessionLimit?: SessionLimitMatcher | null
}

// retryAfterRE captures "in N seconds", "after N minutes", "after Ns", etc.
// A bare number is not matched because the unit is required to disambiguate.
const retryAfterRE =
  /(?:try\s+again|retry)[^.\n]*?(?:in|after)\s+(\d+)\s*(s\b|sec|second|m\b|min|minute|h\b|hr|hour)s?/i

/**
 * Scan an API-error message for a numeric retry hint and return it as a
 * duration in milliseconds. Returns 0 when no hint was found or the unit was
 * not recognized.
 */
export function parseRetryAfter(msg: string): number {
  const m = retryAfterRE.exec(msg)
  if (!m) return 0
  const n = parseInt(m[1], 10)
  if (isNaN(n) || n <= 0) return 0
  switch (m[2].toLowerCase()) {
    case "s":
    case "sec":
    case "second":
      return n * 1000
    case "m":
    case "min":
    case "minute":
      return n * 60_000
    case "h":
    case "hr":
    case "hour":
      return n * 3_600_000
  }
  return 0
}

// resetTimeRE captures the "resets <clock-time> (<TZ>)" tail of a session-limit
// banner. 12-hour ("6pm", "6:40pm"), 24-hour ("18:40"); optional TZ in parens.
const resetTimeRE =
  /resets?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i

function isValidZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz })
    return true
  } catch {
    return false
  }
}

// getOffsetMinutes returns the (zone - UTC) offset in minutes at `date`.
function getOffsetMinutes(zone: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
  const map: Record<string, string> = {}
  for (const p of dtf.formatToParts(date)) map[p.type] = p.value
  const asUTC = Date.UTC(
    +map.year,
    +map.month - 1,
    +map.day,
    +map.hour,
    +map.minute,
    +map.second,
  )
  return (asUTC - date.getTime()) / 60_000
}

// wallToInstant resolves a wall-clock (y/mo/d h:mi) in `zone` to an instant.
function wallToInstant(
  zone: string,
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
): Date {
  const utcGuess = Date.UTC(y, mo - 1, d, h, mi, 0)
  const off = getOffsetMinutes(zone, new Date(utcGuess))
  let inst = utcGuess - off * 60_000
  const off2 = getOffsetMinutes(zone, new Date(inst))
  if (off2 !== off) inst = utcGuess - off2 * 60_000
  return new Date(inst)
}

function partsInZone(
  zone: string,
  date: Date,
): { year: number; month: number; day: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
  const map: Record<string, string> = {}
  for (const p of dtf.formatToParts(date)) map[p.type] = p.value
  return { year: +map.year, month: +map.month, day: +map.day }
}

/**
 * Scan text for a "resets HH:MM(am|pm) (TZ)" hint and return the next future
 * absolute instant at which the limit is expected to reset. Returns null when
 * no parseable hint was found.
 */
export function parseResetTime(text: string, now: Now): Date | null {
  const m = resetTimeRE.exec(text)
  if (!m) return null
  let hour = parseInt(m[1], 10)
  if (isNaN(hour) || hour < 0 || hour > 23) return null
  let minute = 0
  if (m[2]) {
    minute = parseInt(m[2], 10)
    if (isNaN(minute) || minute < 0 || minute > 59) return null
  }
  const ampm = (m[3] ?? "").toLowerCase()
  switch (ampm) {
    case "am":
      if (hour < 1 || hour > 12) return null
      if (hour === 12) hour = 0
      break
    case "pm":
      if (hour < 1 || hour > 12) return null
      if (hour !== 12) hour += 12
      break
    default:
      // 24-hour form. Reject single-digit hours without a minute component.
      if (!m[2]) return null
      if (hour > 23) return null
  }
  let zone = now.zone
  const tz = (m[4] ?? "").trim()
  if (tz !== "" && isValidZone(tz)) zone = tz
  const { year, month, day } = partsInZone(zone, now.date)
  let resume = wallToInstant(zone, year, month, day, hour, minute)
  if (!(resume.getTime() > now.date.getTime())) {
    resume = new Date(resume.getTime() + 24 * 3_600_000)
  }
  return resume
}

/**
 * Return the first pattern that appears as a substring of `haystack`, or "" if
 * none match. Caller is expected to pre-lowercase `haystack`.
 */
export function matchAny(haystack: string, patterns: string[] | undefined): string {
  if (!patterns) return ""
  for (const p of patterns) {
    if (p === "") continue
    if (haystack.includes(p)) return p
  }
  return ""
}

/**
 * Return the first pattern that the trailing non-empty line of `haystack` ends
 * with (case-insensitive), or "" if none match.
 */
export function matchPromptSuffix(
  haystack: string,
  patterns: string[] | undefined,
): string {
  if (!patterns) return ""
  const tail = lastNonEmptyLine(haystack)
  if (tail === "") return ""
  const tailLower = tail.replace(/[ \t]+$/, "").toLowerCase()
  for (const p of patterns) {
    if (p === "") continue
    if (tailLower.endsWith(p.toLowerCase())) return p
  }
  return ""
}

function lastNonEmptyLine(s: string): string {
  let end = s.length
  while (end > 0) {
    while (
      end > 0 &&
      (s[end - 1] === "\n" ||
        s[end - 1] === "\r" ||
        s[end - 1] === " " ||
        s[end - 1] === "\t")
    ) {
      end--
    }
    let start = end
    while (start > 0 && s[start - 1] !== "\n") start--
    const line = s.slice(start, end)
    if (line !== "") return line
    if (start === 0) return ""
    end = start - 1
  }
  return ""
}
