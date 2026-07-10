import { describe, expect, test } from "vitest"
import {
  parseResetTime,
  parseRetryAfter,
  type Now,
} from "../../src/wrapper/internal/detector/detector.ts"

describe("parseRetryAfter", () => {
  const cases: { name: string; in: string; want: number }[] = [
    { name: "H1: numeric seconds spelled out", in: "Retry after 30 seconds.", want: 30_000 },
    { name: "H2: numeric minutes spelled out", in: "Try again in 2 minutes.", want: 2 * 60_000 },
    { name: "H3: non-numeric phrasing", in: "try again in a moment", want: 0 },
    { name: "H4: empty string", in: "", want: 0 },
    { name: "H5: compact unit", in: "retry after 5s", want: 5_000 },
    { name: "H6: no numeric hint", in: "please try again later", want: 0 },
    { name: "hours unit", in: "try again in 1 hour", want: 3_600_000 },
    { name: "mid-message minutes", in: "the upstream said try again in 10 minutes please", want: 10 * 60_000 },
    { name: "zero rejected", in: "try again in 0 seconds", want: 0 },
  ]
  for (const tc of cases) {
    test(tc.name, () => {
      expect(parseRetryAfter(tc.in)).toBe(tc.want)
    })
  }
})

// nowIn builds a `Now` whose instant is the given wall-clock in `zone`.
function nowIn(zone: string, parts: string): Now {
  // parts is an ISO-like "YYYY-MM-DDTHH:MM" interpreted in `zone`.
  const m = /(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(parts)!
  const y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5]
  // Resolve wall-clock in zone to an instant via offset probing.
  const utcGuess = Date.UTC(y, mo - 1, d, h, mi, 0)
  const off = zoneOffsetMinutes(zone, new Date(utcGuess))
  const inst = utcGuess - off * 60_000
  return { date: new Date(inst), zone }
}

function zoneOffsetMinutes(zone: string, date: Date): number {
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
  const asUTC = Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour, +map.minute, +map.second)
  return (asUTC - date.getTime()) / 60_000
}

describe("parseResetTime", () => {
  const warsaw = "Europe/Warsaw"
  const la = "America/Los_Angeles"
  const utc = "UTC"

  const nowAfternoon = nowIn(warsaw, "2026-05-20T14:00")
  const nowEvening = nowIn(warsaw, "2026-05-20T22:00")

  const cases: {
    name: string
    in: string
    now: Now
    wantOK: boolean
    want?: Now
  }[] = [
    { name: "R1: verbatim banner — same-day future", in: "You've hit your session limit · resets 6:40pm (Europe/Warsaw)", now: nowAfternoon, wantOK: true, want: nowIn(warsaw, "2026-05-20T18:40") },
    { name: "R2: same banner past today rolls to tomorrow", in: "You've hit your session limit · resets 6:40pm (Europe/Warsaw)", now: nowEvening, wantOK: true, want: nowIn(warsaw, "2026-05-21T18:40") },
    { name: "R3: 12pm (noon) resolves to 12:00", in: "resets 12pm (UTC)", now: nowIn(utc, "2026-05-20T09:00"), wantOK: true, want: nowIn(utc, "2026-05-20T12:00") },
    { name: "R4: 12am (midnight) resolves next day", in: "resets 12am (UTC)", now: nowIn(utc, "2026-05-20T09:00"), wantOK: true, want: nowIn(utc, "2026-05-21T00:00") },
    { name: "R5: no TZ — caller location", in: "resets 5pm", now: nowIn(la, "2026-05-20T09:00"), wantOK: true, want: nowIn(la, "2026-05-20T17:00") },
    { name: "R6: 24-hour with minutes", in: "resets 18:40 (Europe/Warsaw)", now: nowAfternoon, wantOK: true, want: nowIn(warsaw, "2026-05-20T18:40") },
    { name: "R7: 'resets at' phrasing", in: "limit resets at 6:40pm (Europe/Warsaw)", now: nowAfternoon, wantOK: true, want: nowIn(warsaw, "2026-05-20T18:40") },
    { name: "R8: unrecognized TZ falls back", in: "resets 6:40pm (Atlantis/Lemuria)", now: nowAfternoon, wantOK: true, want: nowIn(warsaw, "2026-05-20T18:40") },
    { name: "R9: no clock-time → no match", in: "limit resets soon", now: nowAfternoon, wantOK: false },
    { name: "R10: bare single-digit 24h rejected", in: "resets 6 (UTC)", now: nowAfternoon, wantOK: false },
    { name: "R11: out-of-range minutes → no match", in: "resets 6:99pm (UTC)", now: nowAfternoon, wantOK: false },
    { name: "R12: empty string", in: "", now: nowAfternoon, wantOK: false },
  ]

  for (const tc of cases) {
    test(tc.name, () => {
      const got = parseResetTime(tc.in, tc.now)
      if (!tc.wantOK) {
        expect(got).toBeNull()
        return
      }
      expect(got).not.toBeNull()
      expect(got!.getTime()).toBe(tc.want!.date.getTime())
      expect(got!.getTime()).toBeGreaterThan(tc.now.date.getTime())
    })
  }
})
