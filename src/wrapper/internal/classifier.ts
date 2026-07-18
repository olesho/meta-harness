// The classifier resolution + the public one-shot ClassifyOutput entry point.

import { isCostOrQuotaLimited, stripANSIEscapes } from "./ansi.ts";
import {
  noClassification,
  type Classification,
  type Classifier,
  type ClassifierInput,
} from "./classification.ts";
import { costClass } from "./errorclass.ts";
import { HarnessAdapter, matchTransportRetry } from "./harnessAdapter.ts";
import { Patterns as claudePatterns } from "./harness/claude.ts";
import { Patterns as codexPatterns } from "./harness/codex.ts";
import { Patterns as cursorPatterns } from "./harness/cursor.ts";
import { Patterns as opencodePatterns } from "./harness/opencode.ts";
import { Patterns as piPatterns } from "./harness/pi.ts";
import { StatusBlockedByCost } from "./status.ts";

/**
 * resolveClassifier picks the Classifier for a harness. Order:
 *  1. an explicit classifier (when supplied),
 *  2. a per-harness classifier matching the harness name,
 *  3. a generic default that detects cost/quota patterns.
 */
export function resolveClassifier(
  harness: string,
  classifier?: Classifier | null,
): Classifier {
  if (classifier) return classifier;
  switch (harness.trim().toLowerCase()) {
    case "claude":
    case "claude-code":
      return new HarnessAdapter(claudePatterns);
    case "codex":
      return new HarnessAdapter(codexPatterns);
    case "cursor":
      return new HarnessAdapter(cursorPatterns);
    case "opencode":
      return new HarnessAdapter(opencodePatterns);
    case "pi":
      return new HarnessAdapter(piPatterns);
  }
  return new DefaultClassifier();
}

/**
 * DefaultClassifier is the built-in fallback. It only escalates to
 * blocked_by_cost when recent output matches a known cost/quota fingerprint,
 * and only after the wrapper has decided the run looks idle.
 */
export class DefaultClassifier implements Classifier {
  classify(input: ClassifierInput): Classification {
    if (!input.idle) return noClassification();
    const phrase = isCostOrQuotaLimited(input.recentOutput);
    if (phrase !== "") {
      return {
        ...noClassification(),
        status: StatusBlockedByCost,
        class: costClass(phrase),
        reason: phrase,
        terminal: true,
      };
    }
    const transport = matchTransportRetry(
      stripANSIEscapes(input.recentOutput).toLowerCase(),
    );
    if (transport) return transport;
    return noClassification();
  }
}

/**
 * ClassifyOutput runs the resolved per-harness classifier as a one-shot over a
 * finished output blob. Idle is forced on so the Cost/Retry/transport patterns
 * are eligible; Quiet is left off so a trailing interactive prompt in a dead
 * process's tail is not misreported as waiting_for_input. Returns the zero
 * Classification when nothing matches.
 */
export function classifyOutput(
  harness: string,
  output: string,
): Classification {
  return resolveClassifier(harness).classify({
    recentOutput: output,
    idle: true,
    quiet: false,
  });
}
