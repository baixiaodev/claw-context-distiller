/**
 * context-distiller — File content distillation rule
 *
 * Handles verbose inline file reads by:
 *  1. Detecting file type and applying type-specific compression
 *  2. For code files: keep imports, exports, function signatures, class definitions
 *  3. For config files: keep structure with truncated values
 *  4. For logs/data: head+tail truncation
 */

import { estimateTokens, truncateToTokenBudget } from "../tokens.js";
import type { DistillerConfig, DistillResult, DistillRule, LlmDistillFn } from "../types.js";

/**
 * Detect if content looks like source code and extract structural summary.
 */
function tryCodeStructuralSummary(content: string, maxTokens: number): string | null {
  const lines = content.split("\n");

  // Heuristic: code files have imports, functions, classes
  const importLines = lines.filter(l =>
    l.match(/^\s*(import|from|require|use|using|#include|package)\s/),
  );
  const defLines = lines.filter(l =>
    l.match(/^\s*(export\s+)?(function|class|interface|type|const|let|var|def|fn|pub|struct|enum)\s/),
  );

  // Need at least some structural elements to classify as code
  if (importLines.length + defLines.length < 3) return null;

  const structural: string[] = [];
  let currentTokens = 0;

  // Keep imports
  if (importLines.length > 0) {
    structural.push("// Imports:");
    for (const line of importLines.slice(0, 15)) {
      const tokens = estimateTokens(line);
      if (currentTokens + tokens > maxTokens * 0.3) break;
      structural.push(line);
      currentTokens += tokens;
    }
    if (importLines.length > 15) {
      structural.push(`// … and ${importLines.length - 15} more imports`);
    }
    structural.push("");
  }

  // Keep definitions (signatures only)
  if (defLines.length > 0) {
    structural.push("// Definitions:");
    for (const line of defLines) {
      const tokens = estimateTokens(line);
      if (currentTokens + tokens > maxTokens * 0.8) {
        structural.push(`// … and ${defLines.length - structural.filter(l => l.startsWith("  ") || l.match(/^\s*(export|function|class)/)).length} more definitions`);
        break;
      }
      structural.push(line.trimEnd());
      currentTokens += tokens;
    }
  }

  structural.push("");
  structural.push(`// [File: ${lines.length} lines total, structural summary above]`);

  return structural.join("\n");
}

/**
 * Compact a JSON value for preview. Truncates strings, summarizes nested structures.
 */
function compactJsonValue(val: unknown, depth = 0): unknown {
  if (val === null || val === undefined) return val;
  if (typeof val === "string") return val.length > 60 ? val.slice(0, 50) + "…" : val;
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
 * Detect and compress config/JSON/YAML files.
 * Enhanced: for large JSON with many similar children, use statistical summary.
 */
function tryConfigSummary(content: string, maxTokens: number): string | null {
  const trimmed = content.trim();

  // JSON config/data
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);

      // === Enhanced: handle arrays with many similar objects ===
      if (Array.isArray(parsed) && parsed.length >= 10) {
        const objectItems = parsed.filter((v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v));
        if (objectItems.length > parsed.length * 0.5) {
          const allKeys = new Map<string, number>();
          for (const item of objectItems) {
            for (const k of Object.keys(item as Record<string, unknown>)) {
              allKeys.set(k, (allKeys.get(k) ?? 0) + 1);
            }
          }
          const sections: string[] = [];
          sections.push(`[JSON Array: ${parsed.length} items]`);
          const commonKeys = [...allKeys.entries()].filter(([, c]) => c >= objectItems.length * 0.5).map(([k]) => k);
          if (commonKeys.length > 0) sections.push(`Common fields: ${commonKeys.join(", ")}`);
          const sIdx = [0, Math.floor(parsed.length / 2), parsed.length - 1];
          sections.push(`Samples (index ${sIdx.join(", ")}):`);
          for (const si of sIdx) {
            sections.push(JSON.stringify(compactJsonValue(parsed[si]), null, 2));
          }
          return sections.join("\n");
        }
      }

      // === Enhanced: handle objects with many similar children ===
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const keys = Object.keys(parsed);

        if (keys.length >= 10) {
          let objectChildren = 0;
          const childKeyFreq = new Map<string, number>();
          for (const k of keys) {
            const v = parsed[k];
            if (typeof v === "object" && v !== null && !Array.isArray(v)) {
              objectChildren++;
              for (const ck of Object.keys(v)) {
                childKeyFreq.set(ck, (childKeyFreq.get(ck) ?? 0) + 1);
              }
            }
          }

          // Many object children → homogeneous collection (e.g., flake.lock nodes)
          if (objectChildren >= 5 && objectChildren > keys.length * 0.5) {
            const sections: string[] = [];
            sections.push(`[JSON Object: ${keys.length} keys, ${objectChildren} object children]`);

            const sortedChildKeys = [...childKeyFreq.entries()].sort((a, b) => b[1] - a[1]);
            const commonChildKeys = sortedChildKeys.filter(([, c]) => c >= objectChildren * 0.5);
            if (commonChildKeys.length > 0) {
              sections.push(`Child structure: ${commonChildKeys.map(([k]) => k).join(", ")}`);
            }

            // Sample entries
            const sampleKeys = keys.length <= 3 ? keys : [keys[0], keys[Math.floor(keys.length / 2)], keys[keys.length - 1]];
            sections.push(`\nSamples (${sampleKeys.length} of ${keys.length}):`);
            for (const sk of sampleKeys) {
              sections.push(`  "${sk}": ${JSON.stringify(compactJsonValue(parsed[sk]), null, 2).split("\n").join("\n  ")}`);
            }

            // Non-object keys shown fully
            const scalarKeys = keys.filter(k => typeof parsed[k] !== "object" || parsed[k] === null);
            if (scalarKeys.length > 0 && scalarKeys.length <= 10) {
              sections.push(`\nScalar fields:`);
              for (const sk of scalarKeys) sections.push(`  "${sk}": ${JSON.stringify(parsed[sk])}`);
            }

            return sections.join("\n");
          }

          // Object with nested arrays (e.g., Jupyter notebook with cells array)
          for (const k of keys) {
            const v = parsed[k];
            if (Array.isArray(v) && v.length >= 10) {
              const objItems = v.filter((item: unknown) => typeof item === "object" && item !== null && !Array.isArray(item));
              if (objItems.length > v.length * 0.5) {
                const sections: string[] = [];
                sections.push(`[JSON Object: ${keys.length} keys]`);

                // Non-array keys compactly
                for (const ok of keys) {
                  if (ok === k) continue;
                  sections.push(`  "${ok}": ${JSON.stringify(compactJsonValue(parsed[ok]))}`);
                }

                // Summarize array
                const arrKeys = new Map<string, number>();
                for (const item of objItems) {
                  for (const ik of Object.keys(item as Record<string, unknown>)) {
                    arrKeys.set(ik, (arrKeys.get(ik) ?? 0) + 1);
                  }
                }
                const common = [...arrKeys.entries()].filter(([, c]) => c >= objItems.length * 0.5).map(([k2]) => k2);
                sections.push(`\n  "${k}": [${v.length} items]`);
                if (common.length > 0) sections.push(`    Fields: ${common.join(", ")}`);
                const si = [0, Math.floor(v.length / 2), v.length - 1];
                sections.push(`    Samples (index ${si.join(", ")}):`);
                for (const idx of si) {
                  sections.push(`    ${JSON.stringify(compactJsonValue(v[idx]))}`);
                }
                return sections.join("\n");
              }
            }
          }
        }
      }

      // Fallback: simple truncation of values
      const summary = JSON.stringify(parsed, (key, value) => {
        if (typeof value === "string" && value.length > 100) {
          return value.slice(0, 80) + "…";
        }
        if (Array.isArray(value) && value.length > 5) {
          return [...value.slice(0, 3), `… (${value.length - 3} more)`];
        }
        return value;
      }, 2);

      if (estimateTokens(summary) < maxTokens) {
        return summary;
      }
    } catch {
      // Not JSON
    }
  }

  return null;
}

export const fileContentDistillRule: DistillRule = {
  id: "file-content-distill",
  description: "Compresses inline file content by extracting structural summaries",
  appliesTo: ["file_content"],
  priority: 10,

  shouldDistill(content: string, tokens: number, config: DistillerConfig): boolean {
    return tokens > config.fileContentMaxTokens;
  },

  async distill(
    content: string,
    tokensBefore: number,
    config: DistillerConfig,
    llmDistill?: LlmDistillFn,
  ): Promise<DistillResult> {
    const targetTokens = config.fileContentMaxTokens;

    // Strategy 1: Config file compression
    const configSummary = tryConfigSummary(content, targetTokens);
    if (configSummary) {
      const tokensAfter = estimateTokens(configSummary);
      return {
        distilled: true,
        content: configSummary,
        tokensBefore,
        tokensAfter,
        rule: "file-content-distill/config",
        ratio: tokensAfter / tokensBefore,
      };
    }

    // Strategy 2: Code structural summary
    const codeSummary = tryCodeStructuralSummary(content, targetTokens);
    if (codeSummary) {
      const tokensAfter = estimateTokens(codeSummary);
      if (tokensAfter < tokensBefore * 0.7) {
        return {
          distilled: true,
          content: codeSummary,
          tokensBefore,
          tokensAfter,
          rule: "file-content-distill/code-structure",
          ratio: tokensAfter / tokensBefore,
        };
      }
    }

    // Strategy 3: LLM summarization for large files
    if (llmDistill && tokensBefore > targetTokens * 2.5) {
      try {
        const summarized = await llmDistill({
          content,
          instruction: [
            "Summarize this file content, preserving:",
            "- File type and purpose",
            "- Key definitions, exports, and interfaces",
            "- Important configuration values",
            "- Notable patterns or issues",
            `Target length: ~${targetTokens} tokens.`,
          ].join("\n"),
          maxOutputTokens: Math.round(targetTokens * 1.1),
        });
        const tokensAfter = estimateTokens(summarized);
        return {
          distilled: true,
          content: `[Distilled file content]\n${summarized}`,
          tokensBefore,
          tokensAfter: tokensAfter + 5,
          rule: "file-content-distill/llm",
          ratio: tokensAfter / tokensBefore,
        };
      } catch {
        // Fall through
      }
    }

    // Strategy 4: Simple truncation
    const truncated = truncateToTokenBudget(content, targetTokens);
    const tokensAfter = estimateTokens(truncated);

    return {
      distilled: true,
      content: truncated,
      tokensBefore,
      tokensAfter,
      rule: "file-content-distill/truncate",
      ratio: tokensAfter / tokensBefore,
    };
  },
};
