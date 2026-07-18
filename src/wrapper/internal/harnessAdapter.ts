// harnessAdapter turns a per-harness pattern set into a Classifier. Pattern
// matching always runs on stripped output so ANSI escapes do not interfere.

import { stripANSIEscapes } from "./ansi.ts";
import {
  noClassification,
  type Classification,
  type Classifier,
  type ClassifierInput,
} from "./classification.ts";
import {
  matchAny,
  matchPromptSuffix,
  type APIErrorHit,
  type Now,
  type Patterns,
  type SessionLimitHit,
} from "./detector/detector.ts";
import {
  classFromHTTPCode,
  costClass,
  ErrRateLimited,
  retryClass,
} from "./errorclass.ts";
import {
  StatusAPIError,
  StatusBlockedByCost,
  StatusRetryLater,
  StatusWaitingForInput,
} from "./status.ts";

// transportRetryPatterns are provider-independent transport/network failures
// that warrant a respawn-after-backoff. Shared by every classifier.
const transportRetryPatterns = [
  "connection refused",
  "econnrefused",
  "connection reset",
  "econnreset",
  "no route to host",
  "ehostunreach",
  "network is unreachable",
  "fetch failed",
  "socket hang up",
  "eai_again",
];

/**
 * Report a StatusRetryLater classification when `lower` (already lowercased,
 * ANSI-stripped) contains a transport-failure fingerprint, else null.
 */
export function matchTransportRetry(lower: string): Classification | null {
  const hit = matchAny(lower, transportRetryPatterns);
  if (hit !== "") {
    return {
      ...noClassification(),
      status: StatusRetryLater,
      class: retryClass(hit),
      reason: hit,
      terminal: true,
    };
  }
  return null;
}

/** The IANA timezone of the local system, for resolving session-limit banners. */
function localNow(): Now {
  return {
    date: new Date(),
    zone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  };
}

export class HarnessAdapter implements Classifier {
  readonly patterns: Patterns;

  constructor(patterns: Patterns) {
    this.patterns = patterns;
  }

  classify(input: ClassifierInput): Classification {
    const stripped = stripANSIEscapes(input.recentOutput);

    if (this.patterns.apiError) {
      const hit = this.patterns.apiError(stripped);
      if (hit) {
        return {
          ...noClassification(),
          status: StatusAPIError,
          class: classFromHTTPCode(hit.code),
          reason: formatAPIErrorReason(hit),
          terminal: false,
          httpCode: hit.code,
          retryAfter: hit.retryAfter,
        };
      }
    }

    if (this.patterns.sessionLimit) {
      const hit = this.patterns.sessionLimit(stripped, localNow());
      if (hit) {
        return {
          ...noClassification(),
          status: StatusBlockedByCost,
          class: ErrRateLimited, // a usage/session limit resets — transient
          reason: formatSessionLimitReason(hit),
          terminal: true,
          resumeAt: hit.resumeAt,
        };
      }
    }

    const lower = stripped.toLowerCase();

    if (input.idle) {
      const cost = matchAny(lower, this.patterns.cost);
      if (cost !== "") {
        return {
          ...noClassification(),
          status: StatusBlockedByCost,
          class: costClass(cost),
          reason: cost,
          terminal: true,
        };
      }
      const retry = matchAny(lower, this.patterns.retry);
      if (retry !== "") {
        return {
          ...noClassification(),
          status: StatusRetryLater,
          class: retryClass(retry),
          reason: retry,
          terminal: true,
        };
      }
      const transport = matchTransportRetry(lower);
      if (transport) return transport;
    }

    if (input.quiet) {
      const prompt = matchPromptSuffix(stripped, this.patterns.prompt);
      if (prompt !== "") {
        return {
          ...noClassification(),
          status: StatusWaitingForInput,
          reason: "prompt detected: " + prompt,
          terminal: false,
        };
      }
    }

    return noClassification();
  }
}

function formatAPIErrorReason(hit: APIErrorHit): string {
  if (hit.code === 0) return "api error: " + hit.message;
  return `api error ${hit.code}: ${hit.message}`;
}

function rfc3339(d: Date): string {
  // Go formats ResumeAt with time.RFC3339 (offset form). A plain ISO string is
  // close enough for the human-readable reason text.
  return d.toISOString();
}

function formatSessionLimitReason(hit: SessionLimitHit): string {
  if (!hit.resumeAt) return "session limit reached: " + hit.message;
  return `session limit reached, resumes at ${rfc3339(hit.resumeAt)}: ${hit.message}`;
}
