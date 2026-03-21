/**
 * context-distiller — Token estimation utilities
 *
 * CJK-aware token estimation matching lossless-claw's convention:
 *   - CJK characters: ~1.5 tokens each
 *   - ASCII/Latin characters: ~4 characters per token
 */

// CJK Unicode ranges
const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u2e80-\u2eff\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uffef\uac00-\ud7af]/g;

/**
 * Estimate token count for a string, CJK-aware.
 * Matches the convention used across lossless-claw's 5 files.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  const cjkMatches = text.match(CJK_REGEX);
  const cjkCount = cjkMatches?.length ?? 0;
  const asciiCount = text.length - cjkCount;

  return Math.ceil(cjkCount / 1.5 + asciiCount / 4);
}

/**
 * Truncate text to approximately the given token budget.
 * Preserves complete sentences/lines where possible.
 */
export function truncateToTokenBudget(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;

  const lines = text.split("\n");
  const result: string[] = [];
  let currentTokens = 0;

  for (const line of lines) {
    const lineTokens = estimateTokens(line);
    if (currentTokens + lineTokens > maxTokens) {
      // Try to fit a partial line if we haven't started yet
      if (result.length === 0) {
        // Character-level truncation for the first line
        const ratio = maxTokens / lineTokens;
        const charLimit = Math.floor(line.length * ratio * 0.9); // 10% safety margin
        result.push(line.slice(0, charLimit) + "…");
      }
      break;
    }
    result.push(line);
    currentTokens += lineTokens;
  }

  if (result.length < lines.length) {
    result.push(`\n[… truncated, ${lines.length - result.length} more lines]`);
  }

  return result.join("\n");
}
