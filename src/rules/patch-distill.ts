/**
 * context-distiller — Patch/diff distillation rule
 *
 * Compresses verbose diffs by keeping only the change summary
 * and a configurable number of context lines.
 *
 * Strategy:
 *  1. Parse unified diff format
 *  2. Keep file headers and hunk markers
 *  3. Keep changed lines (+/-) with minimal context
 *  4. Add a summary of total changes
 */

import { estimateTokens } from "../tokens.js";
import type { DistillerConfig, DistillResult, DistillRule, LlmDistillFn } from "../types.js";

interface DiffStats {
  files: number;
  additions: number;
  deletions: number;
  hunks: number;
}

/**
 * Parse a unified diff and extract statistics.
 */
function parseDiffStats(content: string): DiffStats {
  const lines = content.split("\n");
  let files = 0;
  let additions = 0;
  let deletions = 0;
  let hunks = 0;

  for (const line of lines) {
    if (line.startsWith("diff ") || line.startsWith("---") && !line.startsWith("--- ")) {
      // skip
    } else if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      files++;
    } else if (line.startsWith("@@")) {
      hunks++;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      additions++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions++;
    }
  }

  // Deduplicate: each file has both +++ and ---
  files = Math.max(1, Math.ceil(files / 2));

  return { files, additions, deletions, hunks };
}

/**
 * Compress a unified diff to essential changes only.
 */
function compressDiff(content: string, maxContextLines: number): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let inHunk = false;
  let contextBuffer: string[] = [];
  let lastChangeIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Always keep file headers and hunk markers
    if (line.startsWith("diff ") || line.startsWith("---") || line.startsWith("+++")) {
      // Flush any trailing context (limited)
      if (contextBuffer.length > 0) {
        result.push(...contextBuffer.slice(-maxContextLines));
        contextBuffer = [];
      }
      result.push(line);
      inHunk = false;
      continue;
    }

    if (line.startsWith("@@")) {
      if (contextBuffer.length > 0) {
        result.push(...contextBuffer.slice(-maxContextLines));
        contextBuffer = [];
      }
      result.push(line);
      inHunk = true;
      lastChangeIdx = -1;
      continue;
    }

    if (!inHunk) continue;

    // Changed lines — always keep
    if (line.startsWith("+") || line.startsWith("-")) {
      // Include limited pre-context
      if (contextBuffer.length > 0) {
        result.push(...contextBuffer.slice(-maxContextLines));
        contextBuffer = [];
      }
      result.push(line);
      lastChangeIdx = result.length;
      continue;
    }

    // Context lines — buffer them
    contextBuffer.push(line);

    // If we have too many buffered context lines after last change, flush with limit
    if (contextBuffer.length > maxContextLines * 2 && lastChangeIdx > -1) {
      const kept = contextBuffer.slice(0, maxContextLines);
      const remaining = contextBuffer.length - maxContextLines;
      result.push(...kept);
      if (remaining > 0) {
        result.push(`  [… ${remaining} unchanged lines …]`);
      }
      contextBuffer = [];
    }
  }

  // Flush remaining context
  if (contextBuffer.length > maxContextLines) {
    result.push(...contextBuffer.slice(0, maxContextLines));
    result.push(`  [… ${contextBuffer.length - maxContextLines} unchanged lines …]`);
  } else {
    result.push(...contextBuffer);
  }

  return result.join("\n");
}

export const patchDistillRule: DistillRule = {
  id: "patch-distill",
  description: "Compresses diffs/patches by keeping change lines with minimal context",
  appliesTo: ["patch"],
  priority: 10,

  shouldDistill(content: string, tokens: number, config: DistillerConfig): boolean {
    return tokens > config.patchMaxTokens;
  },

  async distill(
    content: string,
    tokensBefore: number,
    config: DistillerConfig,
    _llmDistill?: LlmDistillFn,
  ): Promise<DistillResult> {
    const stats = parseDiffStats(content);

    // Determine context lines based on aggressiveness
    const contextLines = config.aggressiveness === "aggressive" ? 1
      : config.aggressiveness === "moderate" ? 2 : 3;

    const compressed = compressDiff(content, contextLines);
    let tokensAfter = estimateTokens(compressed);

    // If still too large after compression, add summary header and truncate
    let finalContent = compressed;
    if (tokensAfter > config.patchMaxTokens * 1.5) {
      const summary = [
        `[Patch summary: ${stats.files} file(s), +${stats.additions}/-${stats.deletions}, ${stats.hunks} hunk(s)]`,
        compressed.split("\n").slice(0, Math.ceil(config.patchMaxTokens / 3)).join("\n"),
        `[… diff truncated]`,
      ].join("\n");
      finalContent = summary;
      tokensAfter = estimateTokens(summary);
    }

    return {
      distilled: true,
      content: finalContent,
      tokensBefore,
      tokensAfter,
      rule: "patch-distill",
      ratio: tokensAfter / tokensBefore,
    };
  },
};
