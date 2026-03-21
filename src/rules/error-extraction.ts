/**
 * context-distiller — Error/critical-line extraction rule
 *
 * Problem: Head+tail truncation loses critical error/failure information
 * buried in the middle of verbose outputs (e.g., CI/CD logs, test results,
 * K8s pod logs, build outputs).
 *
 * Solution: Before truncation, scan for lines matching error/failure patterns
 * and ensure they are preserved in the distilled output.
 *
 * This rule has priority 8 — between repetition-elimination (5) and
 * category-specific rules (10). It extracts errors first, then the
 * category-specific rules handle what's left.
 *
 * Real-world scenarios from:
 * - Azure SRE Agent: K8s pod logs with OOM kills buried in 10K lines
 * - CI/CD pipelines: test failures between install and build stages
 * - Webpack/Vite builds: warnings scattered through 5000-line outputs
 */

import { estimateTokens } from "../tokens.js";
import type { DistillerConfig, DistillResult, DistillRule, LlmDistillFn } from "../types.js";

// Patterns that indicate error/failure/critical information
const ERROR_PATTERNS = [
  // Generic errors
  /\b(error|err|fatal|panic|exception|traceback|stack\s*trace)\b/i,
  // Test failures
  /\b(fail(ed|ure|ing)?|assert(ion)?.*fail|expect(ed)?.*but\s+(got|received|was))\b/i,
  // Process/system failures
  /\b(oom|out\s+of\s+memory|killed|segfault|core\s+dump|abort(ed)?|crash(ed)?)\b/i,
  // Build/compile errors
  /\b(syntax\s+error|compile\s+error|type\s+error|reference\s+error|undefined\s+(is\s+not|reference))\b/i,
  // Exit codes
  /\b(exit\s+(code|status)\s*[^0]|exited?\s+with\s+[^0]|return(ed)?\s+non-?zero)\b/i,
  // Warnings (lower priority but still useful)
  /\b(warn(ing)?|deprecat(ed|ion))\b/i,
  // K8s / Docker specific
  /\b(CrashLoopBackOff|ImagePullBackOff|ErrImagePull|OOMKilled|Evicted|BackOff)\b/i,
  // HTTP errors
  /\b([45]\d{2}\s+(error|forbidden|not\s+found|internal|bad\s+request|unauthorized|timeout))\b/i,
];

// Patterns for summary/result lines that should also be preserved
const SUMMARY_PATTERNS = [
  /^\s*(Tests?|Specs?|Suites?|Total|Pass(ed)?|Fail(ed)?|Skip(ped)?|Error)\s*[:=]/i,
  /^\s*\d+\s+(pass|fail|error|skip|pending)/i,
  /^\s*(PASS|FAIL|OK|ERROR)\s/,
  /^(Tests?|Ran)\s+\d+\s+/i,
  /^\s*✓|✗|✘|×|✔|❌|⚠/,
  /^\s*(BUILD|COMPILE|DEPLOY)\s+(SUCCESS|FAIL|ERROR)/i,
];

interface ExtractedLines {
  errors: Array<{ lineNum: number; line: string; severity: "error" | "warning" | "summary" }>;
  totalErrors: number;
  totalWarnings: number;
  totalSummary: number;
}

/**
 * Extract error/warning/summary lines from content.
 */
function extractCriticalLines(content: string): ExtractedLines {
  const lines = content.split("\n");
  const extracted: ExtractedLines = {
    errors: [],
    totalErrors: 0,
    totalWarnings: 0,
    totalSummary: 0,
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check for summary lines first
    if (SUMMARY_PATTERNS.some(p => p.test(trimmed))) {
      extracted.errors.push({ lineNum: i + 1, line, severity: "summary" });
      extracted.totalSummary++;
      continue;
    }

    // Check for error patterns
    let isError = false;
    let isWarning = false;
    for (const pattern of ERROR_PATTERNS) {
      if (pattern.test(trimmed)) {
        // Distinguish warnings from errors
        if (/\b(warn(ing)?|deprecat(ed|ion))\b/i.test(trimmed) && !/\b(error|fatal|fail)\b/i.test(trimmed)) {
          isWarning = true;
        } else {
          isError = true;
        }
        break;
      }
    }

    if (isError) {
      extracted.errors.push({ lineNum: i + 1, line, severity: "error" });
      extracted.totalErrors++;

      // Also grab 1-2 context lines after an error (stack trace / details)
      for (let j = 1; j <= 2 && i + j < lines.length; j++) {
        const nextLine = lines[i + j].trim();
        if (nextLine && (nextLine.startsWith("at ") || nextLine.startsWith("    ") ||
            nextLine.startsWith("  ") || nextLine.match(/^\s+\^/))) {
          extracted.errors.push({ lineNum: i + j + 1, line: lines[i + j], severity: "error" });
        }
      }
    } else if (isWarning) {
      extracted.errors.push({ lineNum: i + 1, line, severity: "warning" });
      extracted.totalWarnings++;
    }
  }

  return extracted;
}

/**
 * Build a distilled output that preserves critical information.
 */
function buildErrorPreservingOutput(
  content: string,
  extracted: ExtractedLines,
  maxTokens: number,
): string {
  const lines = content.split("\n");
  const totalLines = lines.length;

  // Budget allocation:
  // - Error section: up to 40% of budget
  // - Head (context): 35% of budget
  // - Tail (final state): 25% of budget
  const errorBudget = Math.round(maxTokens * 0.4);
  const headBudget = Math.round(maxTokens * 0.35);
  const tailBudget = maxTokens - errorBudget - headBudget;

  // 1. Build error section
  const errorSection: string[] = [];
  let errorTokens = 0;

  // Prioritize: errors > summaries > warnings
  const sorted = [
    ...extracted.errors.filter(e => e.severity === "error"),
    ...extracted.errors.filter(e => e.severity === "summary"),
    ...extracted.errors.filter(e => e.severity === "warning"),
  ];

  // Deduplicate by content
  const seenLines = new Set<string>();
  for (const entry of sorted) {
    const normalized = entry.line.trim();
    if (seenLines.has(normalized)) continue;
    seenLines.add(normalized);

    const lineTokens = estimateTokens(entry.line);
    if (errorTokens + lineTokens > errorBudget) break;
    errorSection.push(entry.line);
    errorTokens += lineTokens;
  }

  // 2. Build head section
  const headLines: string[] = [];
  let headTokens = 0;
  for (const line of lines) {
    const lt = estimateTokens(line);
    if (headTokens + lt > headBudget) break;
    headLines.push(line);
    headTokens += lt;
  }

  // 3. Build tail section
  const tailLines: string[] = [];
  let tailTokens = 0;
  for (let i = lines.length - 1; i >= headLines.length; i--) {
    const lt = estimateTokens(lines[i]);
    if (tailTokens + lt > tailBudget) break;
    tailLines.unshift(lines[i]);
    tailTokens += lt;
  }

  const omitted = totalLines - headLines.length - tailLines.length;

  // Assemble output
  const result: string[] = [...headLines];

  if (errorSection.length > 0 && omitted > 0) {
    result.push("");
    result.push(`[⚠ Extracted ${extracted.totalErrors} error(s), ${extracted.totalWarnings} warning(s), ${extracted.totalSummary} summary line(s) from ${omitted} omitted lines:]`);
    result.push(...errorSection);
    result.push("");
  }

  if (omitted > 0) {
    const notShown = omitted - (errorSection.length > 0 ? errorSection.length : 0);
    if (notShown > 0) {
      result.push(`[… ${notShown} other lines omitted …]`);
    }
  }

  result.push(...tailLines);
  return result.join("\n");
}

export const errorExtractionRule: DistillRule = {
  id: "error-extraction",
  description: "Extracts error/failure lines from verbose outputs before truncation to prevent critical info loss",
  appliesTo: ["tool_output"],
  priority: 8, // Between repetition (5) and tool-output-truncation (10)

  shouldDistill(content: string, tokens: number, config: DistillerConfig): boolean {
    if (tokens <= config.toolOutputMaxTokens) return false;

    // Only fire if there are actual error patterns in the content
    const lines = content.split("\n");
    let hasErrors = false;
    for (const line of lines) {
      for (const pattern of ERROR_PATTERNS) {
        if (pattern.test(line)) {
          hasErrors = true;
          break;
        }
      }
      if (hasErrors) break;
    }
    return hasErrors;
  },

  async distill(
    content: string,
    tokensBefore: number,
    config: DistillerConfig,
    _llmDistill?: LlmDistillFn,
  ): Promise<DistillResult> {
    const extracted = extractCriticalLines(content);

    // Only proceed if we found meaningful error content
    if (extracted.totalErrors === 0 && extracted.totalSummary === 0) {
      return { distilled: false, content, tokensBefore, tokensAfter: tokensBefore };
    }

    const result = buildErrorPreservingOutput(content, extracted, config.toolOutputMaxTokens);
    const tokensAfter = estimateTokens(result);

    // Only report as distilled if we actually saved tokens
    if (tokensAfter >= tokensBefore * 0.95) {
      return { distilled: false, content, tokensBefore, tokensAfter: tokensBefore };
    }

    return {
      distilled: true,
      content: result,
      tokensBefore,
      tokensAfter,
      rule: "error-extraction",
      ratio: tokensAfter / tokensBefore,
    };
  },
};
