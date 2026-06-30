// Output-inspection helpers shared by the classifiers.

/** Strip ANSI/CSI escape sequences, leaving the printable text. */
export function stripANSIEscapes(s: string): string {
  let out = ""
  let inEscape = false
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (inEscape) {
      // A final byte in the @..~ range ends the escape sequence.
      if (c >= 0x40 && c <= 0x7e) inEscape = false
      continue
    }
    if (c === 0x1b) {
      inEscape = true
      continue
    }
    out += s[i]
  }
  return out
}

const costQuotaPatterns = [
  "blocked by cost",
  "cost limit",
  "quota exceeded",
  "rate limit",
  "rate-limit",
  "usage limit",
  "session limit",
  "you've hit your limit",
  "you have hit your limit",
  "you've hit your session limit",
  "you have hit your session limit",
  "limit resets",
  "resets at",
  "extra usage",
]

/**
 * Report whether output contains a cost/quota/rate fingerprint, returning the
 * matched phrase. Returns "" when nothing matched.
 */
export function isCostOrQuotaLimited(output: string): string {
  const normalized = stripANSIEscapes(output).toLowerCase()
  for (const pattern of costQuotaPatterns) {
    if (normalized.includes(pattern)) return pattern
  }
  return ""
}
