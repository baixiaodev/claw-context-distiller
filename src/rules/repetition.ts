/**
 * context-distiller — Repetition elimination rule
 *
 * Detects and eliminates repetitive patterns in content:
 *  - Repeated log lines (exact dedup)
 *  - Duplicate error messages (exact dedup)
 *  - Repeated data rows (exact dedup)
 *  - Looping output patterns (block dedup)
 *  - **Templatized repetition** (same structure, different values)
 *    e.g., 200 objects each with Position/Components/Script fields,
 *    50 dbt models each with Schema/Materialization/Upstream/Downstream,
 *    80 vulnerability findings each with Severity/Depends on/fix available
 *
 * This rule has higher priority (runs before type-specific rules)
 * because repetition elimination is universally applicable.
 */

import { estimateTokens } from "../tokens.js";
import type { DistillerConfig, DistillResult, DistillRule, LlmDistillFn } from "../types.js";

/**
 * Detect and deduplicate repeated lines/patterns.
 */
function deduplicateLines(content: string): { result: string; deduplicated: boolean } {
  const lines = content.split("\n");
  if (lines.length < 10) return { result: content, deduplicated: false };

  // Count line frequencies (normalize whitespace)
  const freq = new Map<string, { count: number; firstIdx: number }>();
  for (let i = 0; i < lines.length; i++) {
    const normalized = lines[i].trim();
    if (!normalized) continue;
    const existing = freq.get(normalized);
    if (existing) {
      existing.count++;
    } else {
      freq.set(normalized, { count: 1, firstIdx: i });
    }
  }

  // Find lines that appear more than 3 times
  const repeatedLines = new Set<string>();
  for (const [line, info] of freq) {
    if (info.count > 3) {
      repeatedLines.add(line);
    }
  }

  if (repeatedLines.size === 0) return { result: content, deduplicated: false };

  // Rebuild content, keeping first occurrence + count annotation
  const seen = new Set<string>();
  const result: string[] = [];
  let suppressedCount = 0;

  for (const line of lines) {
    const normalized = line.trim();
    if (repeatedLines.has(normalized)) {
      if (!seen.has(normalized)) {
        seen.add(normalized);
        const count = freq.get(normalized)!.count;
        result.push(line);
        result.push(`  [↑ repeated ${count}× total, showing once]`);
      } else {
        suppressedCount++;
      }
    } else {
      if (suppressedCount > 0) {
        // Don't add another marker; the inline annotation handles it
        suppressedCount = 0;
      }
      result.push(line);
    }
  }

  return { result: result.join("\n"), deduplicated: true };
}

/**
 * Detect repeating block patterns (e.g., same 3-5 line block repeated).
 */
function deduplicateBlocks(content: string): { result: string; deduplicated: boolean } {
  const lines = content.split("\n");
  if (lines.length < 20) return { result: content, deduplicated: false };

  // Try block sizes 2-5
  for (const blockSize of [3, 4, 5, 2]) {
    const blockFreq = new Map<string, number>();
    for (let i = 0; i <= lines.length - blockSize; i++) {
      const block = lines.slice(i, i + blockSize).join("\n").trim();
      if (block.length < 20) continue; // Skip tiny blocks
      blockFreq.set(block, (blockFreq.get(block) ?? 0) + 1);
    }

    // Find blocks repeated 3+ times
    const repeatedBlocks = [...blockFreq.entries()]
      .filter(([, count]) => count >= 3)
      .sort((a, b) => b[1] - a[1]);

    if (repeatedBlocks.length === 0) continue;

    // For simplicity, handle the most repeated block
    const [topBlock, topCount] = repeatedBlocks[0];

    // Replace subsequent occurrences
    const result: string[] = [];
    let i = 0;
    let firstSeen = false;

    while (i < lines.length) {
      const candidate = lines.slice(i, i + blockSize).join("\n").trim();
      if (candidate === topBlock) {
        if (!firstSeen) {
          result.push(...lines.slice(i, i + blockSize));
          result.push(`[↑ block repeated ${topCount}× total, showing once]`);
          firstSeen = true;
        }
        i += blockSize;
      } else {
        result.push(lines[i]);
        i++;
      }
    }

    return { result: result.join("\n"), deduplicated: true };
  }

  return { result: content, deduplicated: false };
}

// ── Templatized repetition detection ──────────────────────────────────────
// Detects structural repetition where the *template* is the same but
// *values* differ. Example:
//   Model: staging_users           →  template: "Model: __VAL__"
//   Model: staging_orders          →  same template
//   Model: staging_products        →  same template
// If a template matches 5+ lines, we show 3 samples + count.

// Replace numbers, quoted strings, hex hashes, UUIDs, IPs, timestamps, and
// path-like segments with __VAL__ to create a structural fingerprint.
const TEMPLATIZE_PATTERNS: Array<[RegExp, string]> = [
  // UUIDs
  [/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, "__UUID__"],
  // Hex hashes (8+ chars)
  [/\b[0-9a-fA-F]{8,64}\b/g, "__HASH__"],
  // ISO timestamps
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\dZ]*/g, "__TIME__"],
  // Date patterns
  [/\d{4}-\d{2}-\d{2}/g, "__DATE__"],
  // IPs
  [/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g, "__IP__"],
  // Floating point numbers with decimals
  [/\b\d+\.\d+\b/g, "__NUM__"],
  // Integers (standalone, 2+ digits)
  [/\b\d{2,}\b/g, "__NUM__"],
  // Quoted strings
  [/"[^"]{1,80}"/g, '"__STR__"'],
  // Parenthesized content that looks like args/values
  [/\([^()]{4,60}\)/g, "(__ARGS__)"],
];

function templatizeLine(line: string): string {
  let t = line;
  for (const [re, repl] of TEMPLATIZE_PATTERNS) {
    t = t.replace(re, repl);
  }
  return t;
}

interface TemplateGroup {
  template: string;
  lines: string[];         // original lines
  indices: number[];       // line indices
}

/**
 * Detect templatized repetition and compress to samples + count.
 * Returns null if no significant templatized repetition found.
 */
function deduplicateTemplates(content: string): { result: string; deduplicated: boolean } {
  const lines = content.split("\n");
  if (lines.length < 20) return { result: content, deduplicated: false };

  // Build template groups
  const groups = new Map<string, TemplateGroup>();
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.length < 10) continue; // Skip short/empty lines
    const tpl = templatizeLine(trimmed);
    // Only consider templatized lines (must have at least one substitution)
    if (tpl === trimmed) continue;
    const g = groups.get(tpl);
    if (g) {
      g.lines.push(lines[i]);
      g.indices.push(i);
    } else {
      groups.set(tpl, { template: tpl, lines: [lines[i]], indices: [i] });
    }
  }

  // Find groups with 5+ matches (significant repetition)
  const bigGroups = [...groups.values()]
    .filter(g => g.lines.length >= 5)
    .sort((a, b) => b.lines.length - a.lines.length);

  if (bigGroups.length === 0) return { result: content, deduplicated: false };

  // Count how many lines are covered by template groups
  const coveredLines = new Set<number>();
  for (const g of bigGroups) {
    for (const idx of g.indices) coveredLines.add(idx);
  }

  // Only proceed if we can compress a significant portion (>30% of lines)
  if (coveredLines.size < lines.length * 0.25) {
    return { result: content, deduplicated: false };
  }

  // Build compressed output
  const suppressedIndices = new Set<number>();
  // For each group: keep first, middle, last sample; suppress the rest
  const sampleAnnotations = new Map<number, string>(); // lineIndex → annotation

  for (const g of bigGroups) {
    if (g.lines.length < 5) continue;
    const count = g.lines.length;
    const sampleIndices = [
      g.indices[0],
      g.indices[Math.floor(count / 2)],
      g.indices[count - 1],
    ];
    const uniqueSamples = [...new Set(sampleIndices)];
    for (const idx of g.indices) {
      if (!uniqueSamples.includes(idx)) {
        suppressedIndices.add(idx);
      }
    }
    // Add annotation after first sample
    sampleAnnotations.set(g.indices[0], `  [↑ ${count} similar lines matching pattern "${g.template.slice(0, 80)}${g.template.length > 80 ? "…" : ""}", showing 3 samples]`);
  }

  // Rebuild
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (suppressedIndices.has(i)) continue;
    result.push(lines[i]);
    const annotation = sampleAnnotations.get(i);
    if (annotation) result.push(annotation);
  }

  return { result: result.join("\n"), deduplicated: true };
}

// ── Multi-record structure detection ──────────────────────────────────────
// Detects repeated multi-line record blocks (e.g., dbt models, Unity objects,
// K8s pods, npm audit entries) where each record has the same *field names*
// but different *values*.
//
// Strategy: detect a repeating field-label prefix pattern, group records,
// then show a count summary + 3 sample records.

interface RecordBlock {
  startIdx: number;
  endIdx: number;
  lines: string[];
  fields: Map<string, string>;
}

/**
 * Try to detect multi-line records with consistent field labels.
 * Looks for patterns like:
 *   Label1: value1
 *   Label2: value2
 *   ...
 * repeated N times.
 */
function deduplicateRecords(content: string): { result: string; deduplicated: boolean } {
  const lines = content.split("\n");
  if (lines.length < 30) return { result: content, deduplicated: false };

  // Detect "key: value" or "key = value" field patterns
  const FIELD_RE = /^(\s{0,4})(\w[\w\s-]{0,30})\s*[:=]\s*(.+)/;

  // First pass: identify field label frequency
  const labelFreq = new Map<string, number>();
  for (const line of lines) {
    const m = line.match(FIELD_RE);
    if (m) {
      const label = m[2].trim().toLowerCase();
      labelFreq.set(label, (labelFreq.get(label) ?? 0) + 1);
    }
  }

  // Find labels that appear 5+ times (record field candidates)
  const recordLabels = new Set<string>();
  for (const [label, count] of labelFreq) {
    if (count >= 5) recordLabels.add(label);
  }

  if (recordLabels.size < 2) return { result: content, deduplicated: false };

  // Second pass: group into records
  // A record starts with a line that contains a known field label and
  // is preceded by a blank line or a "header" line (non-field line).
  const records: RecordBlock[] = [];
  let currentRecord: RecordBlock | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(FIELD_RE);
    if (m) {
      const label = m[2].trim().toLowerCase();
      if (recordLabels.has(label)) {
        // Check if this is a new record (first field or after a gap)
        if (!currentRecord) {
          // Start might be the line before if it looks like a header
          const headerIdx = i > 0 && !lines[i - 1].match(FIELD_RE) && lines[i - 1].trim() ? i - 1 : i;
          currentRecord = { startIdx: headerIdx, endIdx: i, lines: [], fields: new Map() };
          if (headerIdx < i) currentRecord.lines.push(lines[headerIdx]);
        }
        currentRecord.lines.push(line);
        currentRecord.fields.set(label, m[3].trim());
        currentRecord.endIdx = i;
      } else if (currentRecord) {
        // Non-record field inside a record — include it
        currentRecord.lines.push(line);
        currentRecord.endIdx = i;
      }
    } else if (currentRecord) {
      // Non-field line
      const trimmed = line.trim();
      if (!trimmed) {
        // Blank line — end of record
        records.push(currentRecord);
        currentRecord = null;
      } else {
        // Non-empty non-field line — include in current record
        currentRecord.lines.push(line);
        currentRecord.endIdx = i;
      }
    }
  }
  if (currentRecord) records.push(currentRecord);

  // Need at least 5 records to be worth compressing
  if (records.length < 5) return { result: content, deduplicated: false };

  // Check that records have consistent structure (>60% share 2+ labels)
  const commonLabelsPerRecord = records.map(r =>
    [...r.fields.keys()].filter(k => recordLabels.has(k)).length
  );
  const avgCommon = commonLabelsPerRecord.reduce((s, n) => s + n, 0) / records.length;
  if (avgCommon < 2) return { result: content, deduplicated: false };

  // Build compressed output
  const totalRecords = records.length;
  const suppressed = new Set<number>(); // line indices to suppress

  // Keep first, middle, last record samples
  const sampleRecordIndices = [0, Math.floor(totalRecords / 2), totalRecords - 1];
  const uniqueSampleRecords = [...new Set(sampleRecordIndices)];

  for (let ri = 0; ri < records.length; ri++) {
    if (!uniqueSampleRecords.includes(ri)) {
      for (let li = records[ri].startIdx; li <= records[ri].endIdx; li++) {
        suppressed.add(li);
      }
    }
  }

  // Collect field value statistics
  const fieldStats = new Map<string, { values: Set<string>; sample: string[] }>();
  for (const r of records) {
    for (const [label, val] of r.fields) {
      let stats = fieldStats.get(label);
      if (!stats) {
        stats = { values: new Set(), sample: [] };
        fieldStats.set(label, stats);
      }
      stats.values.add(val);
      if (stats.sample.length < 3) stats.sample.push(val.length > 40 ? val.slice(0, 37) + "…" : val);
    }
  }

  // Insert summary annotation after first sample record
  const annotationIdx = records[0].endIdx;
  const statsLines: string[] = [];
  statsLines.push(`\n[↑ ${totalRecords} records with similar structure, showing 3 samples]`);
  statsLines.push(`[Record fields: ${[...recordLabels].join(", ")}]`);
  for (const [label, stats] of fieldStats) {
    if (!recordLabels.has(label)) continue;
    if (stats.values.size <= 5) {
      statsLines.push(`  ${label}: ${[...stats.values].slice(0, 5).join(", ")}`);
    } else {
      statsLines.push(`  ${label}: ${stats.values.size} unique values, e.g.: ${stats.sample.join(", ")}`);
    }
  }
  statsLines.push("");

  // Rebuild output
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (suppressed.has(i)) continue;
    result.push(lines[i]);
    if (i === annotationIdx) {
      result.push(...statsLines);
    }
  }

  const resultStr = result.join("\n");
  const tokensAfter = estimateTokens(resultStr);
  const tokensBefore = estimateTokens(content);
  // Only if meaningful compression
  if (tokensAfter >= tokensBefore * 0.85) return { result: content, deduplicated: false };

  return { result: resultStr, deduplicated: true };
}

export const repetitionEliminationRule: DistillRule = {
  id: "repetition-elimination",
  description: "Detects and eliminates repeated lines, log entries, block patterns, and templatized/record repetition",
  appliesTo: ["tool_output", "file_content", "text"],
  priority: 5, // Runs before type-specific rules

  shouldDistill(content: string, tokens: number, _config: DistillerConfig): boolean {
    // Only fire if content is reasonably large
    if (tokens <= 200 || content.split("\n").length <= 15) return false;

    // Skip JSON content — let tryJsonSummary in tool-output handle it better.
    // JSON content has lots of repeating structural characters ({, }, [, ]) that
    // line-level dedup will strip incorrectly while losing the actual data.
    const trimmed = content.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      // Quick check: if it looks like JSON (first char + valid-ish structure)
      try {
        JSON.parse(trimmed);
        return false; // Valid JSON — skip repetition, let JSON summary handle it
      } catch {
        // Not valid JSON, continue with repetition rules
      }
    }

    return true;
  },

  async distill(
    content: string,
    tokensBefore: number,
    _config: DistillerConfig,
    _llmDistill?: LlmDistillFn,
  ): Promise<DistillResult> {
    // Strategy order: records → lines → blocks → templates
    // Records first because structured data (dbt, Unity, npm audit) benefits most
    // from record-level compression vs simple line dedup.

    // 1. Try multi-line record deduplication (same field labels, different values)
    const recordResult = deduplicateRecords(content);
    if (recordResult.deduplicated) {
      const tokensAfter = estimateTokens(recordResult.result);
      // Records must achieve < 40% compression to beat line/block dedup
      if (tokensAfter < tokensBefore * 0.40) {
        return {
          distilled: true,
          content: recordResult.result,
          tokensBefore,
          tokensAfter,
          rule: "repetition-elimination/records",
          ratio: tokensAfter / tokensBefore,
        };
      }
    }

    // 2. Try line deduplication (exact matches)
    const lineResult = deduplicateLines(content);
    if (lineResult.deduplicated) {
      const tokensAfter = estimateTokens(lineResult.result);
      if (tokensAfter < tokensBefore * 0.85) {
        return {
          distilled: true,
          content: lineResult.result,
          tokensBefore,
          tokensAfter,
          rule: "repetition-elimination/lines",
          ratio: tokensAfter / tokensBefore,
        };
      }
    }

    // 3. Try block deduplication (exact block matches)
    const blockResult = deduplicateBlocks(content);
    if (blockResult.deduplicated) {
      const tokensAfter = estimateTokens(blockResult.result);
      if (tokensAfter < tokensBefore * 0.85) {
        return {
          distilled: true,
          content: blockResult.result,
          tokensBefore,
          tokensAfter,
          rule: "repetition-elimination/blocks",
          ratio: tokensAfter / tokensBefore,
        };
      }
    }

    // 4. Try templatized line deduplication (same structure, different values)
    // But skip if content has error patterns — let error-extraction (P8) handle it
    // Use strict threshold (< 25%) because template dedup can interfere with
    // more effective downstream rules (error-extraction, head-tail truncation)
    const hasErrorPatterns = /\b(error|fatal|fail(ed|ure)?|panic|crash|exception)\b/i.test(content);
    if (!hasErrorPatterns) {
      const templateResult = deduplicateTemplates(content);
      if (templateResult.deduplicated) {
        const tokensAfter = estimateTokens(templateResult.result);
        if (tokensAfter < tokensBefore * 0.25) {
          return {
            distilled: true,
            content: templateResult.result,
            tokensBefore,
            tokensAfter,
            rule: "repetition-elimination/templates",
            ratio: tokensAfter / tokensBefore,
          };
        }
      }
    }

    return { distilled: false, content, tokensBefore, tokensAfter: tokensBefore };
  },
};
