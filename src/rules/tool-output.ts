/**
 * context-distiller — Tool output truncation rule
 *
 * Handles verbose tool outputs by extracting key information and
 * truncating the rest. This is the most common distillation scenario.
 *
 * Strategy:
 *  1. If output looks like structured data (JSON/YAML), extract summary
 *  2. If output has clear sections, keep headers + first few lines per section
 *  3. Otherwise, keep head + tail with a truncation marker
 */

import { estimateTokens, truncateToTokenBudget } from "../tokens.js";
import type { DistillerConfig, DistillResult, DistillRule, LlmDistillFn } from "../types.js";

/**
 * Compact a single JSON value for summary display.
 * Truncates strings, summarizes nested structures.
 */
function compactJsonValue(val: unknown, depth = 0): unknown {
  if (val === null || val === undefined) return val;
  if (typeof val === "string") {
    return val.length > 60 ? val.slice(0, 50) + "…" : val;
  }
  if (typeof val !== "object") return val;
  if (depth > 1) {
    return Array.isArray(val) ? `[${val.length} items]` : `{${Object.keys(val).length} keys}`;
  }
  if (Array.isArray(val)) {
    if (val.length <= 2) return val.map(v => compactJsonValue(v, depth + 1));
    return [...val.slice(0, 2).map(v => compactJsonValue(v, depth + 1)), `… (${val.length - 2} more)`];
  }
  const obj = val as Record<string, unknown>;
  const keys = Object.keys(obj);
  const result: Record<string, unknown> = {};
  const limit = depth === 0 ? 6 : 3;
  for (const key of keys.slice(0, limit)) {
    result[key] = compactJsonValue(obj[key], depth + 1);
  }
  if (keys.length > limit) result["…"] = `${keys.length - limit} more keys`;
  return result;
}

/**
 * Detect if content looks like JSON and extract a structural summary.
 * Enhanced with:
 *  - Statistical summary for large arrays (count, field distribution, value ranges)
 *  - Compact nested object preview
 *  - Heterogeneous array detection
 */
function tryJsonSummary(content: string, maxTokens: number): string | null {
  const trimmed = content.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return null;

  try {
    const parsed = JSON.parse(trimmed);

    if (Array.isArray(parsed)) {
      const len = parsed.length;
      if (len === 0) return `[JSON Array: 0 items]`;

      // Analyze the array structure
      const itemTypes = new Map<string, number>();
      const allKeys = new Map<string, number>();
      let objectItems = 0;

      for (const item of parsed) {
        const t = Array.isArray(item) ? "array" : typeof item;
        itemTypes.set(t, (itemTypes.get(t) ?? 0) + 1);
        if (t === "object" && item !== null) {
          objectItems++;
          for (const key of Object.keys(item)) {
            allKeys.set(key, (allKeys.get(key) ?? 0) + 1);
          }
        }
      }

      const sections: string[] = [];
      sections.push(`[JSON Array: ${len} items]`);

      // For arrays of objects — show field distribution
      if (objectItems > len * 0.8) {
        const sortedKeys = [...allKeys.entries()].sort((a, b) => b[1] - a[1]);
        const commonKeys = sortedKeys.filter(([, count]) => count >= len * 0.5);
        const rareKeys = sortedKeys.filter(([, count]) => count < len * 0.5);

        if (commonKeys.length > 0) {
          sections.push(`Common fields (${commonKeys.length}): ${commonKeys.map(([k]) => k).join(", ")}`);
        }
        if (rareKeys.length > 0) {
          sections.push(`Rare fields (${rareKeys.length}): ${rareKeys.slice(0, 5).map(([k, c]) => `${k}(${c}/${len})`).join(", ")}${rareKeys.length > 5 ? ` … ${rareKeys.length - 5} more` : ""}`);
        }

        // Show compact samples from different parts of the array
        const sampleIndices = len <= 3
          ? parsed.map((_: unknown, i: number) => i)
          : [0, Math.floor(len / 2), len - 1];
        const samples = sampleIndices.map((i: number) => compactJsonValue(parsed[i]));
        sections.push(`Samples (index ${sampleIndices.join(", ")}):`);
        sections.push(JSON.stringify(samples, null, 2));
      } else {
        // Mixed-type array — show type distribution
        const typeDesc = [...itemTypes.entries()].map(([t, c]) => `${t}: ${c}`).join(", ");
        sections.push(`Item types: ${typeDesc}`);
        const sample = parsed.slice(0, 2).map((v: unknown) => compactJsonValue(v));
        sections.push(`First ${sample.length} items:`);
        sections.push(JSON.stringify(sample, null, 2));
      }

      if (len > 3) sections.push(`… and ${len - 3} more items`);
      return sections.join("\n");
    }

    if (typeof parsed === "object" && parsed !== null) {
      const keys = Object.keys(parsed);

      // Detect nested structures with many similar children (e.g., flake.lock, notebook)
      // Check if most values are objects with similar structure
      if (keys.length > 5) {
        const valueTypes = new Map<string, number>();
        let objectChildren = 0;
        const childKeyFreq = new Map<string, number>();

        for (const key of keys) {
          const val = parsed[key];
          const t = Array.isArray(val) ? "array" : typeof val;
          valueTypes.set(t, (valueTypes.get(t) ?? 0) + 1);
          if (t === "object" && val !== null) {
            objectChildren++;
            for (const ck of Object.keys(val)) {
              childKeyFreq.set(ck, (childKeyFreq.get(ck) ?? 0) + 1);
            }
          }
        }

        // Many object children with similar structure → homogeneous collection
        if (objectChildren >= 5 && objectChildren > keys.length * 0.5) {
          const sections: string[] = [];
          sections.push(`[JSON Object: ${keys.length} keys, ${objectChildren} object children]`);

          // Common child fields
          const sortedChildKeys = [...childKeyFreq.entries()].sort((a, b) => b[1] - a[1]);
          const commonChildKeys = sortedChildKeys.filter(([, c]) => c >= objectChildren * 0.5);
          if (commonChildKeys.length > 0) {
            sections.push(`Child object fields: ${commonChildKeys.map(([k]) => k).join(", ")}`);
          }

          // Value type distribution
          const typeDesc = [...valueTypes.entries()].map(([t, c]) => `${t}: ${c}`).join(", ");
          sections.push(`Value types: ${typeDesc}`);

          // Sample 3 keys: first, middle, last
          const sampleKeys = keys.length <= 3
            ? keys
            : [keys[0], keys[Math.floor(keys.length / 2)], keys[keys.length - 1]];
          sections.push(`\nSample entries (${sampleKeys.length} of ${keys.length}):`);
          for (const sk of sampleKeys) {
            const compact = compactJsonValue(parsed[sk], 0);
            sections.push(`  "${sk}": ${JSON.stringify(compact)}`);
          }

          // Non-object keys shown fully
          const nonObjectKeys = keys.filter(k => {
            const v = parsed[k];
            return typeof v !== "object" || v === null || Array.isArray(v);
          });
          if (nonObjectKeys.length > 0 && nonObjectKeys.length <= 10) {
            sections.push(`\nScalar/array fields:`);
            for (const k of nonObjectKeys.slice(0, 8)) {
              const v = parsed[k];
              const display = typeof v === "string" && v.length > 60 ? v.slice(0, 57) + "…" : JSON.stringify(v);
              sections.push(`  "${k}": ${display}`);
            }
            if (nonObjectKeys.length > 8) sections.push(`  … and ${nonObjectKeys.length - 8} more`);
          }

          return sections.join("\n");
        }

        // Special: detect "cells" or "hits" arrays inside the object
        for (const arrayKey of keys) {
          const val = parsed[arrayKey];
          if (Array.isArray(val) && val.length >= 10) {
            // Recursively summarize this nested array
            const objectItems = val.filter((v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v));
            if (objectItems.length > val.length * 0.5) {
              const sections: string[] = [];
              sections.push(`[JSON Object: ${keys.length} keys]`);

              // Non-array keys shown compactly
              for (const k of keys) {
                if (k === arrayKey) continue;
                const v = parsed[k];
                if (typeof v === "object" && v !== null) {
                  sections.push(`  "${k}": ${JSON.stringify(compactJsonValue(v, 0))}`);
                } else {
                  sections.push(`  "${k}": ${JSON.stringify(v)}`);
                }
              }

              // Summarize the array
              const allKeys = new Map<string, number>();
              for (const item of objectItems) {
                for (const ik of Object.keys(item as Record<string, unknown>)) {
                  allKeys.set(ik, (allKeys.get(ik) ?? 0) + 1);
                }
              }
              const commonKeys = [...allKeys.entries()].filter(([, c]) => c >= objectItems.length * 0.5).map(([k]) => k);
              sections.push(`\n  "${arrayKey}": [${val.length} items]`);
              if (commonKeys.length > 0) {
                sections.push(`    Fields: ${commonKeys.join(", ")}`);
              }
              const sampleIdx = [0, Math.floor(val.length / 2), val.length - 1];
              sections.push(`    Samples (index ${sampleIdx.join(", ")}):`);
              for (const si of sampleIdx) {
                sections.push(`    ${JSON.stringify(compactJsonValue(val[si], 0))}`);
              }
              return sections.join("\n");
            }
          }
        }
      }

      if (keys.length > 10) {
        // Large object — compact preview with value types
        const preview = compactJsonValue(parsed) as Record<string, unknown>;
        return [
          `[JSON Object: ${keys.length} keys]`,
          JSON.stringify(preview, null, 2),
        ].join("\n");
      }
      if (keys.length > 5) {
        // Medium object — show with truncated values
        const preview = compactJsonValue(parsed) as Record<string, unknown>;
        return JSON.stringify(preview, null, 2);
      }
    }
  } catch {
    // Not valid JSON
  }

  return null;
}

/**
 * Detect and summarize file listings (e.g., ls, find, tree output).
 */
function tryFileListingSummary(content: string): string | null {
  const lines = content.split("\n").filter(l => l.trim());

  // Heuristic: >20 lines where most look like file paths
  if (lines.length < 20) return null;

  const pathLikeLines = lines.filter(l =>
    l.includes("/") || l.includes("\\") || l.match(/^\s*([-drwx]+\s+|total\s+|\d+\s+)/),
  );

  if (pathLikeLines.length / lines.length < 0.6) return null;

  // Extract directory structure summary
  const dirs = new Set<string>();
  const extensions = new Map<string, number>();
  let fileCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.includes("/")) {
      const parts = trimmed.split("/");
      if (parts.length > 1) {
        dirs.add(parts.slice(0, -1).join("/"));
      }
      const ext = trimmed.match(/\.(\w+)$/)?.[1];
      if (ext) {
        extensions.set(ext, (extensions.get(ext) ?? 0) + 1);
      }
      fileCount++;
    }
  }

  const topExtensions = [...extensions.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([ext, count]) => `  .${ext}: ${count}`)
    .join("\n");

  return [
    `[File listing: ${fileCount} files in ${dirs.size} directories]`,
    `Top extensions:\n${topExtensions}`,
    `Sample paths:`,
    lines.slice(0, 5).join("\n"),
    `… and ${Math.max(0, lines.length - 5)} more entries`,
  ].join("\n");
}

/**
 * Head+tail truncation with section awareness.
 */
function headTailTruncation(content: string, maxTokens: number): string {
  const lines = content.split("\n");
  const totalLines = lines.length;

  // Allocate 60% head, 40% tail
  const headBudget = Math.round(maxTokens * 0.6);
  const tailBudget = maxTokens - headBudget;

  const headLines: string[] = [];
  let headTokens = 0;
  for (const line of lines) {
    const lt = estimateTokens(line);
    if (headTokens + lt > headBudget) break;
    headLines.push(line);
    headTokens += lt;
  }

  const tailLines: string[] = [];
  let tailTokens = 0;
  for (let i = lines.length - 1; i >= headLines.length; i--) {
    const lt = estimateTokens(lines[i]);
    if (tailTokens + lt > tailBudget) break;
    tailLines.unshift(lines[i]);
    tailTokens += lt;
  }

  const omitted = totalLines - headLines.length - tailLines.length;
  if (omitted <= 0) {
    return content;
  }

  return [
    ...headLines,
    `\n[… ${omitted} lines omitted (${estimateTokens(content) - headTokens - tailTokens} tokens) …]\n`,
    ...tailLines,
  ].join("\n");
}

export const toolOutputTruncationRule: DistillRule = {
  id: "tool-output-truncation",
  description: "Truncates verbose tool outputs using structured extraction or head+tail strategy",
  appliesTo: ["tool_output"],
  priority: 10,

  shouldDistill(content: string, tokens: number, config: DistillerConfig): boolean {
    return tokens > config.toolOutputMaxTokens;
  },

  async distill(
    content: string,
    tokensBefore: number,
    config: DistillerConfig,
    llmDistill?: LlmDistillFn,
  ): Promise<DistillResult> {
    const targetTokens = config.toolOutputMaxTokens;

    // Strategy 1: Try JSON summary
    const jsonSummary = tryJsonSummary(content, targetTokens);
    if (jsonSummary) {
      const tokensAfter = estimateTokens(jsonSummary);
      if (tokensAfter < tokensBefore * 0.8) {
        return {
          distilled: true,
          content: jsonSummary,
          tokensBefore,
          tokensAfter,
          rule: "tool-output-truncation/json",
          ratio: tokensAfter / tokensBefore,
        };
      }
    }

    // Strategy 2: Try file listing summary
    const listingSummary = tryFileListingSummary(content);
    if (listingSummary) {
      const tokensAfter = estimateTokens(listingSummary);
      return {
        distilled: true,
        content: listingSummary,
        tokensBefore,
        tokensAfter,
        rule: "tool-output-truncation/listing",
        ratio: tokensAfter / tokensBefore,
      };
    }

    // Strategy 3: LLM-powered summarization (if available and content is large enough)
    if (llmDistill && tokensBefore > targetTokens * 2) {
      try {
        const summarized = await llmDistill({
          content,
          instruction: [
            "Summarize this tool output, preserving:",
            "- Key findings, results, and conclusions",
            "- Error messages and warnings",
            "- Important data points and values",
            "- File paths and identifiers",
            "Remove: verbose logs, repeated patterns, boilerplate, raw data dumps.",
            `Target length: ~${targetTokens} tokens.`,
          ].join("\n"),
          maxOutputTokens: Math.round(targetTokens * 1.2),
        });
        const tokensAfter = estimateTokens(summarized);
        return {
          distilled: true,
          content: `[Distilled tool output]\n${summarized}`,
          tokensBefore,
          tokensAfter: tokensAfter + 5, // account for header
          rule: "tool-output-truncation/llm",
          ratio: tokensAfter / tokensBefore,
        };
      } catch {
        // Fall through to simple truncation
      }
    }

    // Strategy 4: Head+tail truncation
    const truncated = headTailTruncation(content, targetTokens);
    const tokensAfter = estimateTokens(truncated);

    return {
      distilled: true,
      content: truncated,
      tokensBefore,
      tokensAfter,
      rule: "tool-output-truncation/head-tail",
      ratio: tokensAfter / tokensBefore,
    };
  },
};
