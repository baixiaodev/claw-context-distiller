/**
 * context-distiller — Domain-aware distillation rule
 *
 * Applies domain-specific compression strategies for structured content
 * that generic rules handle poorly:
 *
 * 1. BibTeX bibliographies — keep author/title/year/venue, drop abstract/doi/url
 * 2. CSV/TSV tabular data — keep header + stats + sample rows
 * 3. YAML configs — compress long values, collapse deep nesting
 * 4. Markdown documents — keep headings + first paragraph per section
 *
 * This rule has priority 9 — between error-extraction (8) and
 * category-specific rules (10). It provides domain-aware compression
 * that generic rules can't match.
 */

import { estimateTokens } from "../tokens.js";
import type { DistillerConfig, DistillResult, DistillRule, LlmDistillFn } from "../types.js";

// ── BibTeX compression ─────────────────────────────────────────────────────

const BIBTEX_ENTRY_RE = /@(\w+)\s*\{([^,]*),/g;
const BIBTEX_FIELD_RE = /^\s*(\w+)\s*=\s*\{(.*)\}/;

// Fields to always keep (most useful for context)
const BIBTEX_KEEP_FIELDS = new Set(["author", "title", "year", "journal", "booktitle", "publisher", "volume", "number", "pages"]);
// Fields to always drop (verbose, not useful in context)
const BIBTEX_DROP_FIELDS = new Set(["abstract", "doi", "url", "issn", "isbn", "eprint", "archiveprefix", "primaryclass", "keywords", "note", "annote", "file", "biburl", "bibsource", "timestamp", "urldate"]);

interface BibEntry {
  type: string;
  key: string;
  fields: Map<string, string>;
}

function parseBibtex(content: string): BibEntry[] | null {
  const entries: BibEntry[] = [];
  // Simple BibTeX parser: find @type{key, ... } blocks
  const lines = content.split("\n");
  let current: BibEntry | null = null;
  let braceDepth = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // Start of a new entry
    const entryMatch = trimmed.match(/^@(\w+)\s*\{(.+?)(?:,\s*)?$/);
    if (entryMatch && braceDepth === 0) {
      if (current) entries.push(current);
      current = { type: entryMatch[1].toLowerCase(), key: entryMatch[2], fields: new Map() };
      braceDepth = 1;
      continue;
    }

    if (!current) continue;

    // Count braces
    for (const ch of trimmed) {
      if (ch === "{") braceDepth++;
      else if (ch === "}") braceDepth--;
    }

    if (braceDepth <= 0) {
      entries.push(current);
      current = null;
      braceDepth = 0;
      continue;
    }

    // Parse field = {value}
    const fieldMatch = trimmed.match(/^(\w+)\s*=\s*[{"](.+?)[}"],?\s*$/);
    if (fieldMatch) {
      current.fields.set(fieldMatch[1].toLowerCase(), fieldMatch[2]);
    }
  }
  if (current) entries.push(current);

  return entries.length >= 5 ? entries : null; // Only if we found enough entries
}

function compressBibtex(entries: BibEntry[]): string {
  const sections: string[] = [];
  sections.push(`[BibTeX: ${entries.length} entries]`);

  // Categorize by type
  const typeCounts = new Map<string, number>();
  for (const entry of entries) {
    typeCounts.set(entry.type, (typeCounts.get(entry.type) ?? 0) + 1);
  }
  sections.push(`Types: ${[...typeCounts.entries()].map(([t, c]) => `${t}(${c})`).join(", ")}`);

  // Year distribution
  const years = entries.map(e => parseInt(e.fields.get("year") ?? "")).filter(y => y > 1900);
  if (years.length > 0) {
    const minYear = Math.min(...years);
    const maxYear = Math.max(...years);
    sections.push(`Year range: ${minYear}–${maxYear}`);
  }

  // Venue distribution
  const venues = new Map<string, number>();
  for (const entry of entries) {
    const venue = entry.fields.get("journal") ?? entry.fields.get("booktitle") ?? entry.fields.get("publisher") ?? "unknown";
    const short = venue.length > 40 ? venue.slice(0, 37) + "…" : venue;
    venues.set(short, (venues.get(short) ?? 0) + 1);
  }
  const topVenues = [...venues.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (topVenues.length > 0) {
    sections.push(`Top venues: ${topVenues.map(([v, c]) => `${v}(${c})`).join(", ")}`);
  }

  sections.push("");
  sections.push("Entries:");

  // Compact entry list: one line per entry
  for (const entry of entries) {
    const author = entry.fields.get("author") ?? "?";
    const title = entry.fields.get("title") ?? "?";
    const year = entry.fields.get("year") ?? "?";
    const shortAuthor = author.length > 30 ? author.split(" and ")[0] + " et al." : author;
    const shortTitle = title.length > 60 ? title.slice(0, 57) + "…" : title;
    sections.push(`- [${entry.key}] ${shortAuthor} (${year}): ${shortTitle}`);
  }

  return sections.join("\n");
}

// ── CSV/TSV compression ────────────────────────────────────────────────────

function detectDelimiter(content: string): string | null {
  const firstLines = content.split("\n").slice(0, 5);

  // Quick reject: if first line looks like a log/command output, skip CSV detection.
  // Real CSV/TSV headers typically start with a letter and don't have brackets/pipes at start.
  const firstTrimmed = firstLines[0]?.trim() ?? "";
  if (firstTrimmed.startsWith("[") || firstTrimmed.startsWith("{") ||
      firstTrimmed.startsWith("#") || firstTrimmed.startsWith("//") ||
      firstTrimmed.startsWith("<!--")) {
    return null;
  }

  for (const delim of ["\t", ",", "|", ";"]) {
    const counts = firstLines.map(l => l.split(delim).length);
    // Require at least 3 columns and all first 5 lines consistent
    if (counts[0] > 2 && counts.every(c => c === counts[0])) {
      // Additional check: first line should have reasonable header-like fields
      // (no deep nesting, no function calls, no parenthesized args)
      const fields = firstLines[0].split(delim).map(f => f.trim());
      const hasReasonableHeaders = fields.every(f => f.length < 80 && !f.includes("(") && !f.includes("{"));
      if (hasReasonableHeaders) return delim;
    }
  }
  return null;
}

function compressCsv(content: string, delimiter: string, maxTokens: number): string {
  const lines = content.split("\n").filter(l => l.trim());
  if (lines.length < 5) return content;

  const header = lines[0].split(delimiter).map(h => h.trim().replace(/^"|"$/g, ""));
  const rows = lines.slice(1).map(l => l.split(delimiter).map(c => c.trim().replace(/^"|"$/g, "")));

  const sections: string[] = [];
  sections.push(`[Tabular data: ${rows.length} rows × ${header.length} columns]`);
  sections.push(`Columns: ${header.join(", ")}`);

  // Column type inference + stats
  for (let col = 0; col < Math.min(header.length, 10); col++) {
    const values = rows.map(r => r[col] ?? "").filter(v => v !== "");
    const numericValues = values.map(Number).filter(n => !isNaN(n));
    if (numericValues.length > values.length * 0.8) {
      const min = Math.min(...numericValues);
      const max = Math.max(...numericValues);
      const avg = numericValues.reduce((s, n) => s + n, 0) / numericValues.length;
      sections.push(`  ${header[col]}: numeric, range [${min.toFixed(2)}, ${max.toFixed(2)}], avg ${avg.toFixed(2)}`);
    } else {
      const unique = new Set(values);
      if (unique.size <= 10) {
        sections.push(`  ${header[col]}: categorical (${unique.size} unique): ${[...unique].slice(0, 5).join(", ")}${unique.size > 5 ? "…" : ""}`);
      } else {
        const sample = values.slice(0, 3).map(v => v.length > 30 ? v.slice(0, 27) + "…" : v);
        sections.push(`  ${header[col]}: text (${unique.size} unique), e.g.: ${sample.join(", ")}`);
      }
    }
  }
  if (header.length > 10) sections.push(`  … and ${header.length - 10} more columns`);

  // Sample rows from start, middle, end
  sections.push("");
  sections.push("Sample rows (first, middle, last):");
  const sampleIndices = [0, Math.floor(rows.length / 2), rows.length - 1];
  for (const idx of sampleIndices) {
    if (idx < rows.length) {
      const compact = rows[idx].map(v => v.length > 30 ? v.slice(0, 27) + "…" : v);
      sections.push(`  [${idx}] ${compact.join(delimiter + " ")}`);
    }
  }

  return sections.join("\n");
}

// ── Markdown compression ───────────────────────────────────────────────────

function compressMarkdown(content: string, maxTokens: number): string | null {
  const lines = content.split("\n");
  const headings = lines.filter(l => l.match(/^#{1,4}\s/));
  if (headings.length < 3) return null; // Not a structured document

  const sections: string[] = [];
  sections.push(`[Document: ${headings.length} sections, ${lines.length} lines]`);
  sections.push("");

  let currentTokens = 0;
  let currentHeading = "";
  let paragraphLines: string[] = [];

  for (const line of lines) {
    if (line.match(/^#{1,4}\s/)) {
      // Save previous section's first paragraph
      if (currentHeading && paragraphLines.length > 0) {
        const para = paragraphLines.slice(0, 3).join("\n");
        const paraTokens = estimateTokens(para);
        if (currentTokens + paraTokens < maxTokens * 0.8) {
          sections.push(para);
          if (paragraphLines.length > 3) sections.push(`  [… ${paragraphLines.length - 3} more lines in section]`);
          currentTokens += paraTokens;
        }
      }
      sections.push("");
      sections.push(line);
      currentHeading = line;
      paragraphLines = [];
      currentTokens += estimateTokens(line);
    } else if (line.trim()) {
      paragraphLines.push(line);
    }
  }
  // Last section
  if (paragraphLines.length > 0) {
    const para = paragraphLines.slice(0, 3).join("\n");
    sections.push(para);
    if (paragraphLines.length > 3) sections.push(`  [… ${paragraphLines.length - 3} more lines in section]`);
  }

  const result = sections.join("\n");
  return estimateTokens(result) < estimateTokens(content) * 0.7 ? result : null;
}

// ── Main rule ──────────────────────────────────────────────────────────────

function detectDomain(content: string): "bibtex" | "csv" | "markdown" | null {
  const trimmed = content.trim();

  // BibTeX: multiple @type{...} entries
  const bibMatches = trimmed.match(/@\w+\s*\{/g);
  if (bibMatches && bibMatches.length >= 3) return "bibtex";

  // CSV/TSV: consistent delimiter across lines
  if (detectDelimiter(content)) return "csv";

  // Markdown: multiple headings
  const headings = content.match(/^#{1,4}\s/gm);
  if (headings && headings.length >= 3) return "markdown";

  return null;
}

export const domainAwareRule: DistillRule = {
  id: "domain-aware",
  description: "Domain-specific compression for BibTeX, CSV/TSV, and Markdown documents",
  appliesTo: ["file_content", "tool_output"],
  priority: 4, // Highest priority — domain-specific compression beats generic repetition elimination

  shouldDistill(content: string, tokens: number, config: DistillerConfig): boolean {
    if (tokens <= config.fileContentMaxTokens) return false;
    return detectDomain(content) !== null;
  },

  async distill(
    content: string,
    tokensBefore: number,
    config: DistillerConfig,
    _llmDistill?: LlmDistillFn,
  ): Promise<DistillResult> {
    const domain = detectDomain(content);

    if (domain === "bibtex") {
      const entries = parseBibtex(content);
      if (entries) {
        const compressed = compressBibtex(entries);
        const tokensAfter = estimateTokens(compressed);
        if (tokensAfter < tokensBefore * 0.7) {
          return {
            distilled: true,
            content: compressed,
            tokensBefore,
            tokensAfter,
            rule: "domain-aware/bibtex",
            ratio: tokensAfter / tokensBefore,
          };
        }
      }
    }

    if (domain === "csv") {
      const delimiter = detectDelimiter(content)!;
      const compressed = compressCsv(content, delimiter, config.toolOutputMaxTokens);
      const tokensAfter = estimateTokens(compressed);
      if (tokensAfter < tokensBefore * 0.8) {
        return {
          distilled: true,
          content: compressed,
          tokensBefore,
          tokensAfter,
          rule: "domain-aware/csv",
          ratio: tokensAfter / tokensBefore,
        };
      }
    }

    if (domain === "markdown") {
      const compressed = compressMarkdown(content, config.fileContentMaxTokens);
      if (compressed) {
        const tokensAfter = estimateTokens(compressed);
        return {
          distilled: true,
          content: compressed,
          tokensBefore,
          tokensAfter,
          rule: "domain-aware/markdown",
          ratio: tokensAfter / tokensBefore,
        };
      }
    }

    return { distilled: false, content, tokensBefore, tokensAfter: tokensBefore };
  },
};
