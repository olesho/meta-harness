// apierror — the harness already knows why a turn failed, and writes it down.
//
// Claude Code records a failed turn in its own session transcript as a
// synthetic assistant line — model "<synthetic>", the rendered error as its
// only text block — carrying `isApiErrorMessage: true` and a machine-readable
// `error` tag. Every layer between that file and a consumer used to drop both
// fields, so a wall was recovered by re-reading the rendered SCREEN with
// anchored regexes, and a billing failure had no representation at all. Worse,
// the rendered error IS an assistant bubble, so the screen path persisted the
// turn as a SUCCESS whose reply was "API Error: 529 Overloaded".
//
// This module reads the tag instead. It is a categorical statement from the
// harness about its own API call, not an inference from prose: an agent that
// merely PRINTS "credit balance too low" cannot produce one.
//
// Three rules keep it from over-reaching:
//
//   - CORRELATION. Only an entry at or beyond the pre-send watermark can speak
//     for this turn. A resumed session's transcript holds every earlier turn's
//     tags, and a stale one must never condemn a healthy turn.
//   - LAST WORD ONLY. The tag must be on the LATEST assistant entry. A turn that
//     hit a 529, retried, and then answered is a success; its transcript holds
//     both.
//   - NO GUESSING. A tag outside the mapped vocabulary yields no verdict, which
//     leaves the screen relabels in charge — exactly the old behaviour.
//
// Port of harness-wrapper's pkg/chat/apierror.go (PR #64), checked against the
// vendored conformance corpus in test/corpus/apierror/.

import {
  CodeAuthRequired,
  CodeBillingWall,
  CodeUsageLimited,
  ReasonAuthRequired,
  ReasonBillingWall,
  ReasonUsageLimited,
  type TurnCode,
} from "./types.ts";
import { RoleAssistant } from "../transcript/event.ts";

/** What a transcript tag decided about a turn. */
export interface ApiErrorVerdict {
  /**
   * The canonical `Turn.reason` for a WALL; empty for every other mapped tag,
   * which get a generic errored reason naming the tag instead.
   */
  reason: string;
  /**
   * The wall token; absent for every non-wall verdict. Absent means "not a
   * wall", never "unclassified".
   */
  code?: TurnCode;
  /** The harness's own tag, carried into the reason as evidence. */
  tag: string;
  /** The rendered error the harness printed. */
  text: string;
}

/**
 * Claude Code's `error` vocabulary, mapped onto a verdict.
 *
 * Seven tags name a WALL — a condition no retry fixes on its own — and carry a
 * code. `rate_limit` is a wall but a self-healing one, hence the usage reason
 * rather than billing. `account_on_hold` is BILLING, not auth: renewing the login
 * would not change it, and that distinction decides whether a consumer retries.
 *
 * Three more error the turn without a code: real failures the harness recorded,
 * so completing them would hand back an error string as the agent's answer, but
 * not walls — a 500 must not sit beside an unpayable account.
 *
 * Deliberately ABSENT, so they yield no verdict and fall through unchanged:
 *   invalid_request   — a prompt problem, not a failure of the environment.
 *   max_output_tokens — the reply hit its ceiling; the turn ran and produced output.
 *   unknown           — the harness declined to classify it, so we do too.
 *   policy_denied     — not an API-error tag: `error` also carries hook results
 *                       ("warn", "debug", "policy_denied"), which is why the
 *                       parser gates on isApiErrorMessage.
 */
const apiErrorClasses: ReadonlyMap<
  string,
  { reason: string; code?: TurnCode }
> = new Map([
  ["billing_error", { reason: ReasonBillingWall, code: CodeBillingWall }],
  ["account_on_hold", { reason: ReasonBillingWall, code: CodeBillingWall }],
  [
    "authentication_failed",
    { reason: ReasonAuthRequired, code: CodeAuthRequired },
  ],
  [
    "oauth_org_not_allowed",
    { reason: ReasonAuthRequired, code: CodeAuthRequired },
  ],
  [
    "verification_required",
    { reason: ReasonAuthRequired, code: CodeAuthRequired },
  ],
  [
    "cloud_credential_error",
    { reason: ReasonAuthRequired, code: CodeAuthRequired },
  ],
  ["rate_limit", { reason: ReasonUsageLimited, code: CodeUsageLimited }],
  ["server_error", { reason: "" }],
  ["overloaded", { reason: "" }],
  ["model_not_found", { reason: "" }],
]);

/** A transcript turn as far as this module needs it. */
export interface TaggedTurn {
  role: string;
  text: string;
  apiError?: string;
}

/**
 * apiErrorVerdictFrom applies the LAST WORD ONLY rule: scan backwards from the
 * end for the most recent assistant entry at or beyond the watermark, and let
 * only THAT entry decide. A tagged entry followed by a real reply means the
 * harness retried and succeeded. `null` watermark ("could not establish how far
 * the transcript already extended") is a decline, never a zero.
 */
export function apiErrorVerdictFrom(
  turns: readonly TaggedTurn[],
  watermark: number | null,
): ApiErrorVerdict | null {
  if (watermark === null || watermark < 0) return null;
  for (let i = turns.length - 1; i >= watermark; i--) {
    const t = turns[i];
    if (t.role !== RoleAssistant) continue;
    // The latest assistant entry is a real reply: whatever failed before it,
    // the turn recovered.
    if (!t.apiError) return null;
    const cls = apiErrorClasses.get(t.apiError);
    // A tag outside the vocabulary — a newer harness, or a deliberately
    // unmapped one. Decline rather than guess.
    if (cls === undefined) return null;
    return {
      reason: cls.reason,
      ...(cls.code !== undefined ? { code: cls.code } : {}),
      tag: t.apiError,
      text: t.text,
    };
  }
  return null;
}

/** Bounds how much of the harness's rendered error rides in the reason. */
export const apiErrorDetailCap = 240;

/**
 * turnReason renders the `Turn.reason` for a verdict: the canonical wall reason
 * where there is one, otherwise a generic errored reason naming the harness.
 * Either way the harness's own tag and its rendered text ride along as the
 * evidence, so an operator reads WHY, in the harness's own words.
 */
export function turnReason(v: ApiErrorVerdict, harness: string): string {
  const head = v.reason !== "" ? v.reason : `${harness}: harness API error`;
  let detail = `harness tag: ${v.tag}`;
  const text = oneLineCapped(v.text, apiErrorDetailCap);
  if (text !== "") detail += `; ${text}`;
  return `${head} (${detail})`;
}

/**
 * oneLineCapped flattens text to a single line and truncates it on a character
 * boundary so a reason stays safe in a log line or a JSON state file.
 *
 * The cap is in UTF-8 BYTES, as in harness-wrapper (Go's len() counts bytes),
 * and the cut backs up to a code-point boundary; counting UTF-16 units instead
 * would render a different reason than the Go side for the same non-ASCII text.
 */
export function oneLineCapped(s: string, max: number): string {
  const flat = s.replace(/[\n\r\t]/g, " ").trim();
  const bytes = new TextEncoder().encode(flat);
  if (bytes.length <= max) return flat;
  let cut = max;
  // A UTF-8 continuation byte is 0b10xxxxxx; back up to a leading byte.
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--;
  return new TextDecoder().decode(bytes.subarray(0, cut)).trim() + "…";
}
