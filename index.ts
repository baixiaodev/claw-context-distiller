/**
 * context-distiller — OpenClaw Plugin Entry
 *
 * Intelligent Part distillation for OpenClaw context management.
 *
 * This plugin hooks into the message pipeline to compress verbose content
 * (tool outputs, patches, file reads) before they enter LCM's context window.
 * It operates via two hooks:
 *
 *  1. `tool_result_persist` — Intercepts tool results before session persistence,
 *     distilling verbose outputs inline. This is the primary compression point.
 *
 *  2. `before_message_write` — Catches any remaining verbose content in
 *     assistant/user messages that wasn't covered by tool_result_persist.
 *
 * The plugin does NOT replace the context engine — it enhances whatever
 * context engine is active (typically lossless-claw) by reducing the raw
 * material that enters the context pipeline.
 */

import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { resolveConfig, getAggressivenessMultiplier } from "./src/config.js";
import { DistillerEngine, classifyContent } from "./src/distiller.js";
import { estimateTokens, truncateToTokenBudget } from "./src/tokens.js";
import { testDistillerTool } from "./src/tools/test-tool.js";
import {
  toolOutputTruncationRule,
  patchDistillRule,
  fileContentDistillRule,
  repetitionEliminationRule,
  errorExtractionRule,
  domainAwareRule,
} from "./src/rules/index.js";
import { StatsStore } from "./src/stats-store.js";
import type { DistillerConfig, LlmDistillFn, PartCategory } from "./src/types.js";

// ── LLM integration ─────────────────────────────────────────────────────────

/**
 * Build the LLM distillation function from plugin API.
 * Uses the same model resolution pattern as lossless-claw.
 */
function buildLlmDistillFn(
  api: OpenClawPluginApi,
  config: DistillerConfig,
): LlmDistillFn | undefined {
  return async ({ content, instruction, maxOutputTokens }) => {
    // Dynamic import of pi-ai (same pattern as lossless-claw)
    const piAiModuleId = "@mariozechner/pi-ai";
    const mod = await import(piAiModuleId) as {
      completeSimple?: (
        model: Record<string, unknown>,
        request: { systemPrompt?: string; messages: Array<{ role: string; content: unknown; timestamp?: number }> },
        options: { apiKey?: string; maxTokens: number; temperature?: number },
      ) => Promise<Record<string, unknown> & { content?: Array<{ type: string; text?: string }> }>;
      getEnvApiKey?: (provider: string) => string | undefined;
    };

    if (typeof mod.completeSimple !== "function") {
      throw new Error("pi-ai completeSimple not available");
    }

    // Resolve model — prefer plugin-specific config, then system default
    const modelRef = config.distillModel ??
      process.env.CONTEXT_DISTILLER_MODEL ??
      undefined;

    let provider: string;
    let modelId: string;

    if (modelRef?.includes("/")) {
      const [p, ...rest] = modelRef.split("/");
      provider = p.trim();
      modelId = rest.join("/").trim();
    } else {
      provider = config.distillProvider ??
        process.env.CONTEXT_DISTILLER_PROVIDER ??
        "ollama";
      modelId = modelRef ?? "qwen3:8b";
    }

    // Resolve API key
    let apiKey: string | undefined;
    if (typeof mod.getEnvApiKey === "function") {
      apiKey = mod.getEnvApiKey(provider);
    }

    // Resolve provider config from openclaw.json
    const providerConfig = (() => {
      const cfg = api.config as { models?: { providers?: Record<string, unknown> } };
      const providers = cfg.models?.providers;
      if (!providers) return {};
      const entry = providers[provider];
      return (entry && typeof entry === "object") ? entry as Record<string, unknown> : {};
    })();

    const resolvedModel = {
      id: modelId,
      name: modelId,
      provider,
      api: (typeof providerConfig.api === "string" ? providerConfig.api : "openai-responses"),
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_000,
      maxTokens: maxOutputTokens ?? 1024,
      baseUrl: typeof providerConfig.baseUrl === "string" ? providerConfig.baseUrl : "",
    };

    const result = await mod.completeSimple(
      resolvedModel,
      {
        systemPrompt: "You are a concise summarizer. Follow the instruction precisely.",
        messages: [
          {
            role: "user",
            content: `${instruction}\n\n---\n\n${content}`,
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey,
        maxTokens: maxOutputTokens ?? 1024,
        temperature: 0.2,
      },
    );

    const text = Array.isArray(result.content)
      ? result.content
          .filter((block: { type: string; text?: string }) => block.type === "text" && block.text)
          .map((block: { type: string; text?: string }) => block.text!)
          .join("\n")
      : "";

    if (!text.trim()) {
      throw new Error("LLM returned empty response");
    }

    return text.trim();
  };
}

// ── Tool definitions ────────────────────────────────────────────────────────

function createDistillStatusTool(engine: DistillerEngine, statsStore: StatsStore): AnyAgentTool {
  return {
    name: "distill_status",
    description: "Show context distiller statistics and current configuration",
    parameters: {
      type: "object",
      properties: {
        reset: {
          type: "boolean",
          description: "Reset all accumulated statistics",
        },
      },
    },
    async execute(params: { reset?: boolean }) {
      const sessionStats = engine.getStats();
      const persistent = statsStore.getStats();
      const config = engine.getConfig();
      const rules = engine.getRules();

      // Format relative time for readability
      const relativeTime = (ts: number | null) => {
        if (!ts) return "never";
        const diff = Date.now() - ts;
        if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
        if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
        if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
        return `${Math.round(diff / 86_400_000)}d ago`;
      };

      const report = [
        "## Context Distiller Status",
        "",
        "### 📊 Lifetime Statistics (across all sessions)",
        `- Total distillations: **${persistent.totalDistillations}**`,
        `- Total tokens saved: **${persistent.totalTokensSaved.toLocaleString()}**`,
        `- Messages processed: ${persistent.totalMessagesProcessed}`,
        `- Plugin loaded: ${persistent.loadCount} time(s)`,
        persistent.firstDistilledAt
          ? `- First distillation: ${new Date(persistent.firstDistilledAt).toISOString()}`
          : "- First distillation: never",
        persistent.lastDistilledAt
          ? `- Last distillation: ${relativeTime(persistent.lastDistilledAt)} (${new Date(persistent.lastDistilledAt).toISOString()})`
          : "- Last distillation: never",
        "",
        "### 🔄 Current Session",
        `- Distillations this session: ${sessionStats.distillations}`,
        `- Tokens saved this session: ${sessionStats.tokensSaved.toLocaleString()}`,
        "",
        "### Rule Hit Counts (lifetime)",
        ...Object.entries(persistent.ruleHits)
          .sort(([, a], [, b]) => b - a)
          .map(([rule, count]) => `- ${rule}: ${count}`),
        Object.keys(persistent.ruleHits).length === 0 ? "- (none yet — distillation hasn't triggered)" : "",
        "",
        "### Configuration",
        `- Enabled: ${config.enabled}`,
        `- Aggressiveness: ${config.aggressiveness}`,
        `- Tool output max tokens: ${config.toolOutputMaxTokens}`,
        `- Patch max tokens: ${config.patchMaxTokens}`,
        `- File content max tokens: ${config.fileContentMaxTokens}`,
        `- Distill model: ${config.distillModel ?? "(system default)"}`,
        `- Preserve patterns: ${config.preservePatterns.length > 0 ? config.preservePatterns.map(p => p.source).join(", ") : "(none)"}`,
        "",
        "### Registered Rules",
        ...rules.map(r => `- [P${r.priority}] ${r.id}: ${r.description}`),
      ].join("\n");

      if (params.reset) {
        engine.resetStats();
        statsStore.reset();
      }

      return report;
    },
  } as unknown as AnyAgentTool;
}

function createDistillConfigureTool(engine: DistillerEngine): AnyAgentTool {
  return {
    name: "distill_configure",
    description: "Update context distiller configuration at runtime",
    parameters: {
      type: "object",
      properties: {
        enabled: {
          type: "boolean",
          description: "Enable or disable the distiller",
        },
        aggressiveness: {
          type: "string",
          enum: ["conservative", "moderate", "aggressive"],
          description: "Compression aggressiveness level",
        },
        toolOutputMaxTokens: {
          type: "number",
          description: "Maximum tokens for tool outputs before distillation (100-5000)",
        },
        patchMaxTokens: {
          type: "number",
          description: "Maximum tokens for patches before distillation (100-3000)",
        },
        fileContentMaxTokens: {
          type: "number",
          description: "Maximum tokens for file content before distillation (200-5000)",
        },
      },
    },
    async execute(params: Record<string, unknown>) {
      const patch: Partial<DistillerConfig> = {};

      if (typeof params.enabled === "boolean") {
        patch.enabled = params.enabled;
      }
      if (typeof params.aggressiveness === "string" &&
          ["conservative", "moderate", "aggressive"].includes(params.aggressiveness)) {
        patch.aggressiveness = params.aggressiveness as DistillerConfig["aggressiveness"];
      }
      if (typeof params.toolOutputMaxTokens === "number") {
        patch.toolOutputMaxTokens = Math.max(100, Math.min(5000, Math.round(params.toolOutputMaxTokens)));
      }
      if (typeof params.patchMaxTokens === "number") {
        patch.patchMaxTokens = Math.max(100, Math.min(3000, Math.round(params.patchMaxTokens)));
      }
      if (typeof params.fileContentMaxTokens === "number") {
        patch.fileContentMaxTokens = Math.max(200, Math.min(5000, Math.round(params.fileContentMaxTokens)));
      }

      if (Object.keys(patch).length === 0) {
        return "No valid configuration changes provided.";
      }

      engine.updateConfig(patch);
      return `Configuration updated: ${JSON.stringify(patch, null, 2)}`;
    },
  } as unknown as AnyAgentTool;
}

// ── Synchronous distillation for sync hooks ─────────────────────────────────
// Gateway's tool_result_persist hook is strictly synchronous — any Promise
// returned is silently ignored. Therefore we implement a pure-sync distillation
// path that avoids all async/await/Promise constructs.

/**
 * Synchronous line deduplication — mirrors repetition.ts logic but fully sync.
 */
function syncDeduplicateLines(content: string): string | null {
  const lines = content.split("\n");
  if (lines.length < 10) return null;

  const freq = new Map<string, { count: number }>();
  for (const line of lines) {
    const normalized = line.trim();
    if (!normalized) continue;
    const existing = freq.get(normalized);
    if (existing) existing.count++;
    else freq.set(normalized, { count: 1 });
  }

  const repeatedLines = new Set<string>();
  for (const [line, info] of freq) {
    if (info.count > 3) repeatedLines.add(line);
  }
  if (repeatedLines.size === 0) return null;

  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of lines) {
    const normalized = line.trim();
    if (repeatedLines.has(normalized)) {
      if (!seen.has(normalized)) {
        seen.add(normalized);
        result.push(line);
        result.push(`  [↑ repeated ${freq.get(normalized)!.count}× total, showing once]`);
      }
    } else {
      result.push(line);
    }
  }
  const out = result.join("\n");
  return estimateTokens(out) < estimateTokens(content) * 0.85 ? out : null;
}

/**
 * Synchronous multi-line record deduplication.
 * Detects repeated field-label structures (e.g., dbt models, npm audit entries)
 * and compresses to 3 sample records + statistics.
 */
function syncDeduplicateRecords(content: string): string | null {
  const lines = content.split("\n");
  if (lines.length < 30) return null;

  const FIELD_RE = /^(\s{0,4})(\w[\w\s-]{0,30})\s*[:=]\s*(.+)/;
  const labelFreq = new Map<string, number>();
  for (const line of lines) {
    const m = line.match(FIELD_RE);
    if (m) {
      const label = m[2].trim().toLowerCase();
      labelFreq.set(label, (labelFreq.get(label) ?? 0) + 1);
    }
  }

  const recordLabels = new Set<string>();
  for (const [label, count] of labelFreq) {
    if (count >= 5) recordLabels.add(label);
  }
  if (recordLabels.size < 2) return null;

  // Group into records
  interface SimpleRecord { startIdx: number; endIdx: number; fields: Map<string, string> }
  const records: SimpleRecord[] = [];
  let current: SimpleRecord | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(FIELD_RE);
    if (m) {
      const label = m[2].trim().toLowerCase();
      if (recordLabels.has(label)) {
        if (!current) {
          const headerIdx = i > 0 && !lines[i - 1].match(FIELD_RE) && lines[i - 1].trim() ? i - 1 : i;
          current = { startIdx: headerIdx, endIdx: i, fields: new Map() };
        }
        current.fields.set(label, m[3].trim());
        current.endIdx = i;
      } else if (current) {
        current.endIdx = i;
      }
    } else if (current) {
      if (!line.trim()) {
        records.push(current);
        current = null;
      } else {
        current.endIdx = i;
      }
    }
  }
  if (current) records.push(current);
  if (records.length < 5) return null;

  // Keep 3 sample records, suppress rest
  const totalRecords = records.length;
  const sampleIdx = [0, Math.floor(totalRecords / 2), totalRecords - 1];
  const uniqueSamples = [...new Set(sampleIdx)];
  const suppressed = new Set<number>();
  for (let ri = 0; ri < records.length; ri++) {
    if (!uniqueSamples.includes(ri)) {
      for (let li = records[ri].startIdx; li <= records[ri].endIdx; li++) suppressed.add(li);
    }
  }

  // Build stats
  const fieldStats = new Map<string, { values: Set<string> }>();
  for (const r of records) {
    for (const [label, val] of r.fields) {
      let s = fieldStats.get(label);
      if (!s) { s = { values: new Set() }; fieldStats.set(label, s); }
      s.values.add(val.length > 40 ? val.slice(0, 37) + "…" : val);
    }
  }

  const statsLines: string[] = [];
  statsLines.push(`\n[↑ ${totalRecords} records with similar structure, showing 3 samples]`);
  for (const [label, stats] of fieldStats) {
    if (!recordLabels.has(label)) continue;
    if (stats.values.size <= 5) {
      statsLines.push(`  ${label}: ${[...stats.values].slice(0, 5).join(", ")}`);
    } else {
      statsLines.push(`  ${label}: ${stats.values.size} unique values`);
    }
  }
  statsLines.push("");

  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (suppressed.has(i)) continue;
    result.push(lines[i]);
    if (i === records[0].endIdx) result.push(...statsLines);
  }
  return result.join("\n");
}

/**
 * Synchronous head+tail truncation.
 * Enhanced: handles single-line / few-line content via character-level truncation
 * instead of producing empty head+tail (the "6 tokens" disaster).
 */
function syncHeadTailTruncation(content: string, maxTokens: number): string {
  const lines = content.split("\n");

  // ── Guard: if very few lines but lots of tokens, do character-level truncation ──
  // This prevents the disaster where a single-line JSON blob gets 0 head + 0 tail = empty
  if (lines.length <= 3) {
    return truncateToTokenBudget(content, maxTokens);
  }

  const headBudget = Math.round(maxTokens * 0.6);
  const tailBudget = maxTokens - headBudget;

  const headLines: string[] = [];
  let headTokens = 0;
  for (const line of lines) {
    const lt = estimateTokens(line);
    if (headTokens + lt > headBudget) {
      // If we haven't collected ANY head lines yet, take a partial first line
      if (headLines.length === 0) {
        const ratio = Math.max(0.1, headBudget / lt);
        const charLimit = Math.floor(line.length * ratio * 0.9);
        if (charLimit > 20) {
          headLines.push(line.slice(0, charLimit) + "…");
          headTokens = headBudget;
        }
      }
      break;
    }
    headLines.push(line);
    headTokens += lt;
  }

  const tailLines: string[] = [];
  let tailTokens = 0;
  for (let i = lines.length - 1; i >= headLines.length; i--) {
    const lt = estimateTokens(lines[i]);
    if (tailTokens + lt > tailBudget) {
      // If we haven't collected any tail lines, take a partial last line
      if (tailLines.length === 0) {
        const ratio = Math.max(0.1, tailBudget / lt);
        const charLimit = Math.floor(lines[i].length * ratio * 0.9);
        if (charLimit > 20) {
          tailLines.unshift("…" + lines[i].slice(-charLimit));
          tailTokens = tailBudget;
        }
      }
      break;
    }
    tailLines.unshift(lines[i]);
    tailTokens += lt;
  }

  const omitted = lines.length - headLines.length - tailLines.length;
  if (omitted <= 0) return content;

  return [...headLines, `\n[… ${omitted} lines omitted …]\n`, ...tailLines].join("\n");
}

// ── Content intelligence: detect high-value content types ──────────────────

/**
 * Content value classification — determines how aggressively to compress.
 * Higher value = higher token budget = more content preserved.
 */
type ContentValueLevel = "low" | "medium" | "high" | "critical";

interface ContentAnalysis {
  value: ContentValueLevel;
  /** Budget multiplier: 1.0 = default, 3.0 = triple budget, etc. */
  budgetMultiplier: number;
  /** Detected content subtype for choosing the best compression strategy */
  subtype:
    | "search_results"    // Web/API search results — critical for research tasks
    | "api_response"      // Structured API response with useful data
    | "data_output"       // Tables, CSV, JSON data
    | "install_log"       // Package install / build output — usually low value
    | "usage_help"        // --help / usage text — low value
    | "error_output"      // Error messages — medium value
    | "file_listing"      // ls/find output
    | "generic";          // Unclassified
  /** Hint for the preferred compression strategy */
  preferredStrategy?: "json_summary" | "smart_truncate" | "head_tail" | "preserve";
}

/**
 * Analyze content to determine its value and optimal compression strategy.
 * This is the key intelligence layer that prevents over-compression of
 * high-value outputs like search results.
 */
function analyzeContent(content: string): ContentAnalysis {
  const trimmed = content.trim();
  const lowerContent = trimmed.slice(0, 2000).toLowerCase();

  // ── Search results detection (CRITICAL value) ──
  // Pattern 1: JSON search results with common search API fields
  const searchJsonPatterns = [
    /\bresults?\b.*\burl\b/i,
    /\btitle\b.*\bsnippet\b/i,
    /\bquery\b.*\bresults?\b/i,
    /\bsearch_results?\b/i,
    /\borganic_results?\b/i,
    /\banswer\b.*\bresults?\b/i,
  ];

  // Pattern 2: Tavily/Google/Bing-like JSON structures
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (isSearchResult(parsed)) {
        return {
          value: "critical",
          budgetMultiplier: 4.0,
          subtype: "search_results",
          preferredStrategy: "json_summary",
        };
      }
      if (isApiResponse(parsed)) {
        return {
          value: "high",
          budgetMultiplier: 4.0,
          subtype: "api_response",
          preferredStrategy: "json_summary",
        };
      }
    } catch { /* not valid JSON — check if it contains JSON embedded in text */ }
  }

  // Pattern 3: Text output containing search results (non-JSON)
  // e.g., output from scripts that format search results
  if (searchJsonPatterns.some(p => p.test(lowerContent))) {
    // Look for embedded JSON
    const jsonStart = trimmed.indexOf("{");
    const jsonArrayStart = trimmed.indexOf("[");
    const firstJson = Math.min(
      jsonStart >= 0 ? jsonStart : Infinity,
      jsonArrayStart >= 0 ? jsonArrayStart : Infinity,
    );
    if (firstJson < trimmed.length && firstJson < 500) {
      try {
        // Try parsing from the first JSON-like character
        const jsonSlice = trimmed.slice(firstJson);
        const parsed = JSON.parse(jsonSlice);
        if (isSearchResult(parsed)) {
          return {
            value: "critical",
            budgetMultiplier: 4.0,
            subtype: "search_results",
            preferredStrategy: "json_summary",
          };
        }
      } catch { /* partial JSON, fall through */ }
    }
  }

  // ── URL-rich content (HIGH value — likely fetched web pages or search results) ──
  const urlCount = (content.match(/https?:\/\/[^\s)}\]"']+/g) ?? []).length;
  if (urlCount >= 3) {
    return {
      value: "high",
      budgetMultiplier: 2.5,
      subtype: "data_output",
      preferredStrategy: "smart_truncate",
    };
  }

  // ── Install/build logs (LOW value) ──
  const installPatterns = [
    /\b(npm|yarn|pip|brew|apt|cargo)\s+(install|add|update)/i,
    /\bdownloading\b.*\bpackage/i,
    /\balready\s+satisfied/i,
    /\bsuccessfully\s+installed/i,
    /\bcollecting\b.*\bfrom/i,
    /\b(added|removed|updated)\s+\d+\s+package/i,
    /\bnpm\s+warn/i,
  ];
  const installMatchCount = installPatterns.filter(p => p.test(lowerContent)).length;
  if (installMatchCount >= 2) {
    return {
      value: "low",
      budgetMultiplier: 0.8,
      subtype: "install_log",
      preferredStrategy: "head_tail",
    };
  }

  // ── Usage/help text (LOW value) ──
  const helpPatterns = [
    /^usage:\s/im,
    /\b(--help|-h)\b.*\bshow\s+(this\s+)?help/i,
    /\boptions?\s*:/i,
    /\bcommands?\s*:/i,
    /^\s{2,}(-\w|--\w)/m,
  ];
  const helpMatchCount = helpPatterns.filter(p => p.test(lowerContent)).length;
  if (helpMatchCount >= 2) {
    return {
      value: "low",
      budgetMultiplier: 0.6,
      subtype: "usage_help",
      preferredStrategy: "head_tail",
    };
  }

  // ── Error output (MEDIUM value) ──
  for (const p of SYNC_ERROR_PATTERNS) {
    if (p.test(lowerContent)) {
      return {
        value: "medium",
        budgetMultiplier: 1.2,
        subtype: "error_output",
      };
    }
  }

  // ── Default: generic tool output ──
  return {
    value: "medium",
    budgetMultiplier: 1.0,
    subtype: "generic",
  };
}

/**
 * Check if a parsed JSON value looks like search API results.
 */
function isSearchResult(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object") return false;

  // Array of results with url/title/snippet fields
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return false;
    const sample = parsed.slice(0, 3);
    const hasSearchFields = sample.some((item: unknown) => {
      if (!item || typeof item !== "object") return false;
      const keys = Object.keys(item as Record<string, unknown>);
      const lowerKeys = keys.map(k => k.toLowerCase());
      return (
        (lowerKeys.includes("url") || lowerKeys.includes("link") || lowerKeys.includes("href")) &&
        (lowerKeys.includes("title") || lowerKeys.includes("name"))
      );
    });
    if (hasSearchFields) return true;
  }

  // Object with results array
  const obj = parsed as Record<string, unknown>;
  const resultKeys = ["results", "organic_results", "search_results", "items", "entries", "data"];
  for (const key of resultKeys) {
    const val = obj[key];
    if (Array.isArray(val) && val.length > 0) {
      return isSearchResult(val);
    }
  }

  // Tavily-style response: has query + results
  if (typeof obj.query === "string" && (Array.isArray(obj.results) || typeof obj.answer === "string")) {
    return true;
  }

  return false;
}

/**
 * Check if a parsed JSON value is a structured API response worth preserving.
 */
function isApiResponse(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj);

  // Has both data fields and meta fields
  const dataKeys = keys.filter(k => {
    const v = obj[k];
    return Array.isArray(v) || (typeof v === "object" && v !== null);
  });
  const scalarKeys = keys.filter(k => {
    const v = obj[k];
    return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
  });

  // Looks like an API response: mix of data + metadata
  return dataKeys.length >= 1 && scalarKeys.length >= 1 && keys.length >= 3;
}

// ── Enhanced JSON summary with search-result awareness ──────────────────────

/**
 * Synchronous JSON summary extraction.
 * Enhanced: special handling for search results to preserve URLs, titles, snippets.
 */
function syncTryJsonSummary(content: string, maxTokens: number): string | null {
  const trimmed = content.trim();

  // Try to find and parse JSON in the content
  let parsed: unknown;
  let jsonContent = trimmed;

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { parsed = JSON.parse(trimmed); } catch { /* not valid JSON */ }
  }

  // If not pure JSON, try to extract embedded JSON
  if (!parsed) {
    const jsonStart = trimmed.indexOf("{");
    const jsonArrayStart = trimmed.indexOf("[");
    const firstJson = Math.min(
      jsonStart >= 0 ? jsonStart : Infinity,
      jsonArrayStart >= 0 ? jsonArrayStart : Infinity,
    );
    if (firstJson < trimmed.length && firstJson < 500) {
      jsonContent = trimmed.slice(firstJson);
      try { parsed = JSON.parse(jsonContent); } catch { /* partial JSON */ }
    }
  }

  if (!parsed) return null;

  // ── Search results: extract structured summaries preserving key info ──
  if (isSearchResult(parsed)) {
    return summarizeSearchResults(parsed, maxTokens);
  }

  // ── Arrays of objects ──
  if (Array.isArray(parsed)) {
    const sample = parsed.slice(0, 5);
    const keys = sample.length > 0 && typeof sample[0] === "object" && sample[0] !== null
      ? Object.keys(sample[0]).join(", ") : "mixed";

    const sampleJson = JSON.stringify(sample, null, 2);
    const budget = maxTokens * 4; // character budget ≈ maxTokens * 4
    return [
      `[JSON Array: ${parsed.length} items, fields: ${keys}]`,
      `Sample (first ${sample.length}):`,
      sampleJson.length > budget ? sampleJson.slice(0, budget) + "\n…" : sampleJson,
      parsed.length > 5 ? `\n… and ${parsed.length - 5} more items` : "",
    ].filter(Boolean).join("\n");
  }

  // ── API response with body text: preserve key metadata + leading paragraphs ──
  // Many web_fetch results contain {url, title, markdown/text, description, ...}
  // We extract the body text and keep leading paragraphs for context.
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    const keys = Object.keys(obj);

    // Check for web_fetch-like structure with body content
    const bodyFields = ["markdown", "text", "content", "body", "description"];
    const bodyKey = bodyFields.find(k => typeof obj[k] === "string" && (obj[k] as string).length > 500);
    const metaKeys = keys.filter(k => k !== bodyKey);

    if (bodyKey && metaKeys.length >= 2) {
      const body = String(obj[bodyKey]);
      const metaEntries: string[] = [];

      // Keep small scalar metadata fields
      for (const k of metaKeys) {
        const v = obj[k];
        if (typeof v === "string" && v.length < 200) {
          metaEntries.push(`  ${k}: ${v}`);
        } else if (typeof v === "number" || typeof v === "boolean") {
          metaEntries.push(`  ${k}: ${v}`);
        } else if (Array.isArray(v) && v.length <= 3 && v.every(item => typeof item === "string" && item.length < 100)) {
          metaEntries.push(`  ${k}: ${JSON.stringify(v)}`);
        }
      }

      // Preserve leading paragraphs from body (up to budget)
      const metaSection = metaEntries.length > 0
        ? `[API Response — ${metaEntries.join("\n")}]`
        : `[API Response]`;

      const metaTokens = estimateTokens(metaSection);
      const remainingBudget = Math.max(200, maxTokens - metaTokens);

      // Split body into paragraphs and keep as many as fit
      const paragraphs = body.split(/\n\s*\n/).filter(p => p.trim());
      const keptParagraphs: string[] = [];
      let paraTokens = 0;

      for (const para of paragraphs) {
        const pt = estimateTokens(para);
        if (paraTokens + pt > remainingBudget && keptParagraphs.length > 0) {
          break;
        }
        keptParagraphs.push(para);
        paraTokens += pt;
      }

      const kept = paragraphs.length - keptParagraphs.length;
      const result = [
        metaSection,
        "",
        ...keptParagraphs,
        ...(kept > 0 ? [`\n[… ${kept} more paragraph(s) omitted …]`] : []),
      ].join("\n");

      const resultTokens = estimateTokens(result);
      if (resultTokens < estimateTokens(trimmed) * 0.9) return result;
    }
  }

  // ── Objects ──
  if (typeof parsed === "object" && parsed !== null) {
    const obj = parsed as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length > 10) {
      const preview: Record<string, unknown> = {};
      for (const key of keys.slice(0, 10)) {
        const val = obj[key];
        preview[key] = Array.isArray(val)
          ? `[Array: ${val.length} items]`
          : typeof val === "object" && val !== null
            ? `{Object: ${Object.keys(val).length} keys}`
            : val;
      }
      return [
        `[JSON Object: ${keys.length} keys]`,
        JSON.stringify(preview, null, 2),
        `… and ${keys.length - 10} more keys`,
      ].join("\n");
    }
    // Smaller objects: preserve more detail
    const compact = JSON.stringify(parsed, null, 2);
    if (estimateTokens(compact) <= maxTokens * 1.2) return compact;
    return compact.slice(0, maxTokens * 4) + "\n[… truncated]";
  }

  return null;
}

/**
 * Summarize search results preserving the most valuable information:
 * URLs, titles, snippets/content previews.
 */
function summarizeSearchResults(parsed: unknown, maxTokens: number): string {
  const results: Array<Record<string, unknown>> = [];

  // Extract the actual results array
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (item && typeof item === "object") results.push(item as Record<string, unknown>);
    }
  } else if (typeof parsed === "object" && parsed !== null) {
    const obj = parsed as Record<string, unknown>;
    // Look for results in common keys
    for (const key of ["results", "organic_results", "search_results", "items", "data"]) {
      if (Array.isArray(obj[key])) {
        for (const item of obj[key] as unknown[]) {
          if (item && typeof item === "object") results.push(item as Record<string, unknown>);
        }
        break;
      }
    }
    // Also capture top-level answer/summary if present
    if (typeof obj.answer === "string") {
      results.unshift({ _type: "answer", content: obj.answer } as Record<string, unknown>);
    }
  }

  if (results.length === 0) {
    return `[Search results: 0 items]`;
  }

  const sections: string[] = [];
  sections.push(`[Search results: ${results.length} items]`);

  let currentTokens = estimateTokens(sections[0]);
  const budget = maxTokens;

  for (let i = 0; i < results.length; i++) {
    const item = results[i];

    // Handle answer blocks
    if (item._type === "answer") {
      const answerText = String(item.content ?? "").slice(0, 500);
      const line = `\nAnswer: ${answerText}`;
      const lt = estimateTokens(line);
      if (currentTokens + lt > budget) {
        sections.push(`\n… and ${results.length - i} more items (budget exceeded)`);
        break;
      }
      sections.push(line);
      currentTokens += lt;
      continue;
    }

    // Extract common search result fields
    const title = String(item.title ?? item.name ?? "").slice(0, 120);
    const url = String(item.url ?? item.link ?? item.href ?? "").slice(0, 200);
    const snippet = String(
      item.snippet ?? item.content ?? item.description ?? item.text ?? item.summary ?? "",
    ).slice(0, 300);
    const score = item.score ?? item.relevance_score ?? item.rank;

    const parts: string[] = [];
    parts.push(`\n[${i + 1}] ${title}`);
    if (url) parts.push(`    URL: ${url}`);
    if (snippet) parts.push(`    ${snippet}`);
    if (score !== undefined) parts.push(`    Score: ${score}`);

    const block = parts.join("\n");
    const lt = estimateTokens(block);
    if (currentTokens + lt > budget) {
      sections.push(`\n… and ${results.length - i} more items (budget exceeded)`);
      break;
    }
    sections.push(block);
    currentTokens += lt;
  }

  return sections.join("\n");
}

/**
 * Synchronous file listing summary.
 */
function syncTryFileListingSummary(content: string): string | null {
  const lines = content.split("\n").filter(l => l.trim());
  if (lines.length < 20) return null;

  const pathLikeLines = lines.filter(l =>
    l.includes("/") || l.includes("\\") || l.match(/^\s*([-drwx]+\s+|total\s+|\d+\s+)/),
  );
  if (pathLikeLines.length / lines.length < 0.6) return null;

  const dirs = new Set<string>();
  const extensions = new Map<string, number>();
  let fileCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.includes("/")) {
      const parts = trimmed.split("/");
      if (parts.length > 1) dirs.add(parts.slice(0, -1).join("/"));
      const ext = trimmed.match(/\.(\w+)$/)?.[1];
      if (ext) extensions.set(ext, (extensions.get(ext) ?? 0) + 1);
      fileCount++;
    }
  }

  const topExtensions = [...extensions.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([ext, count]) => `  .${ext}: ${count}`).join("\n");

  return [
    `[File listing: ${fileCount} files in ${dirs.size} directories]`,
    `Top extensions:\n${topExtensions}`,
    `Sample paths:`, lines.slice(0, 5).join("\n"),
    `… and ${Math.max(0, lines.length - 5)} more entries`,
  ].join("\n");
}

/**
 * Synchronous diff compression.
 */
function syncCompressDiff(content: string, maxContextLines: number): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let inHunk = false;
  let contextBuffer: string[] = [];
  let lastChangeIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("diff ") || line.startsWith("---") || line.startsWith("+++")) {
      if (contextBuffer.length > 0) { result.push(...contextBuffer.slice(-maxContextLines)); contextBuffer = []; }
      result.push(line); inHunk = false; continue;
    }
    if (line.startsWith("@@")) {
      if (contextBuffer.length > 0) { result.push(...contextBuffer.slice(-maxContextLines)); contextBuffer = []; }
      result.push(line); inHunk = true; lastChangeIdx = -1; continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+") || line.startsWith("-")) {
      if (contextBuffer.length > 0) { result.push(...contextBuffer.slice(-maxContextLines)); contextBuffer = []; }
      result.push(line); lastChangeIdx = result.length; continue;
    }
    contextBuffer.push(line);
    if (contextBuffer.length > maxContextLines * 2 && lastChangeIdx > -1) {
      const kept = contextBuffer.slice(0, maxContextLines);
      result.push(...kept);
      if (contextBuffer.length - maxContextLines > 0) result.push(`  [… ${contextBuffer.length - maxContextLines} unchanged lines …]`);
      contextBuffer = [];
    }
  }
  if (contextBuffer.length > maxContextLines) {
    result.push(...contextBuffer.slice(0, maxContextLines));
    result.push(`  [… ${contextBuffer.length - maxContextLines} unchanged lines …]`);
  } else {
    result.push(...contextBuffer);
  }
  return result.join("\n");
}

/**
 * Synchronous code structural summary.
 */
function syncTryCodeStructuralSummary(content: string, maxTokens: number): string | null {
  const lines = content.split("\n");
  const importLines = lines.filter(l => l.match(/^\s*(import|from|require|use|using|#include|package)\s/));
  const defLines = lines.filter(l => l.match(/^\s*(export\s+)?(function|class|interface|type|const|let|var|def|fn|pub|struct|enum)\s/));
  if (importLines.length + defLines.length < 3) return null;

  const structural: string[] = [];
  let currentTokens = 0;
  if (importLines.length > 0) {
    structural.push("// Imports:");
    for (const line of importLines.slice(0, 15)) {
      const t = estimateTokens(line);
      if (currentTokens + t > maxTokens * 0.3) break;
      structural.push(line); currentTokens += t;
    }
    if (importLines.length > 15) structural.push(`// … and ${importLines.length - 15} more imports`);
    structural.push("");
  }
  if (defLines.length > 0) {
    structural.push("// Definitions:");
    for (const line of defLines) {
      const t = estimateTokens(line);
      if (currentTokens + t > maxTokens * 0.8) { structural.push(`// … and more definitions`); break; }
      structural.push(line.trimEnd()); currentTokens += t;
    }
  }
  structural.push(""); structural.push(`// [File: ${lines.length} lines total, structural summary above]`);
  return structural.join("\n");
}

/**
 * Synchronous config/JSON summary.
 */
function syncTryConfigSummary(content: string, maxTokens: number): string | null {
  const trimmed = content.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return null;
  try {
    const parsed = JSON.parse(trimmed);

    // Enhanced: arrays of similar objects
    if (Array.isArray(parsed) && parsed.length >= 10) {
      const objItems = parsed.filter((v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v));
      if (objItems.length > parsed.length * 0.5) {
        const allKeys = new Map<string, number>();
        for (const item of objItems) for (const k of Object.keys(item as Record<string, unknown>)) allKeys.set(k, (allKeys.get(k) ?? 0) + 1);
        const common = [...allKeys.entries()].filter(([, c]) => c >= objItems.length * 0.5).map(([k]) => k);
        const s = [`[JSON Array: ${parsed.length} items]`];
        if (common.length > 0) s.push(`Common fields: ${common.join(", ")}`);
        const si = [0, Math.floor(parsed.length / 2), parsed.length - 1];
        s.push(`Samples:`);
        for (const i of si) s.push(JSON.stringify(parsed[i], null, 2).split("\n").slice(0, 6).join("\n"));
        return s.join("\n");
      }
    }

    // Enhanced: objects with many similar children
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const keys = Object.keys(parsed);
      if (keys.length >= 10) {
        let objChildren = 0;
        for (const k of keys) if (typeof parsed[k] === "object" && parsed[k] !== null && !Array.isArray(parsed[k])) objChildren++;
        if (objChildren >= 5 && objChildren > keys.length * 0.5) {
          const s = [`[JSON Object: ${keys.length} keys, ${objChildren} object children]`];
          const sk = keys.length <= 3 ? keys : [keys[0], keys[Math.floor(keys.length / 2)], keys[keys.length - 1]];
          s.push(`Samples (${sk.length} of ${keys.length}):`);
          for (const k of sk) s.push(`  "${k}": ${JSON.stringify(parsed[k]).slice(0, 100)}`);
          const scalars = keys.filter(k => typeof parsed[k] !== "object" || parsed[k] === null);
          if (scalars.length > 0 && scalars.length <= 8) {
            s.push(`Scalars:`);
            for (const k of scalars) s.push(`  "${k}": ${JSON.stringify(parsed[k])}`);
          }
          return s.join("\n");
        }

        // Object with large nested array
        for (const k of keys) {
          const v = parsed[k];
          if (Array.isArray(v) && v.length >= 10) {
            const s = [`[JSON Object: ${keys.length} keys, "${k}" has ${v.length} items]`];
            for (const ok of keys) { if (ok === k) continue; s.push(`  "${ok}": ${JSON.stringify(parsed[ok]).slice(0, 80)}`); }
            const si = [0, Math.floor(v.length / 2), v.length - 1];
            s.push(`  "${k}" samples:`);
            for (const i of si) s.push(`    ${JSON.stringify(v[i]).slice(0, 120)}`);
            return s.join("\n");
          }
        }
      }
    }

    // Fallback: simple truncation
    const summary = JSON.stringify(parsed, (_key, value) => {
      if (typeof value === "string" && value.length > 100) return value.slice(0, 80) + "…";
      if (Array.isArray(value) && value.length > 5) return [...value.slice(0, 3), `… (${value.length - 3} more)`];
      return value;
    }, 2);
    if (estimateTokens(summary) < maxTokens) return summary;
  } catch { /* not JSON */ }
  return null;
}

// Error patterns for sync error extraction (mirrors error-extraction.ts)
const SYNC_ERROR_PATTERNS = [
  /\b(error|err|fatal|panic|exception|traceback|stack\s*trace)\b/i,
  /\b(fail(ed|ure|ing)?|assert(ion)?.*fail|expect(ed)?.*but\s+(got|received|was))\b/i,
  /\b(oom|out\s+of\s+memory|killed|segfault|core\s+dump|abort(ed)?|crash(ed)?)\b/i,
  /\b(syntax\s+error|compile\s+error|type\s+error|reference\s+error)\b/i,
  /\b(exit\s+(code|status)\s*[^0]|exited?\s+with\s+[^0])\b/i,
  /\b(CrashLoopBackOff|OOMKilled|ImagePullBackOff)\b/i,
];

const SYNC_SUMMARY_PATTERNS = [
  /^\s*(Tests?|Specs?|Suites?|Total|Pass(ed)?|Fail(ed)?|Error)\s*[:=]/i,
  /^\s*\d+\s+(pass|fail|error|skip)/i,
  /^\s*(PASS|FAIL|OK|ERROR)\s/,
  /^\s*✓|✗|✘|×|✔|❌|⚠/,
  /^\s*(BUILD|COMPILE|DEPLOY)\s+(SUCCESS|FAIL|ERROR)/i,
];

/**
 * Synchronous error extraction — preserves error/failure lines from verbose output.
 */
function syncExtractErrors(
  content: string,
  tokens: number,
  maxTokens: number,
): { distilled: boolean; content: string; tokens: number; rule: string } | null {
  const lines = content.split("\n");

  // Check if there are any error patterns
  let hasErrors = false;
  for (const line of lines) {
    for (const pattern of SYNC_ERROR_PATTERNS) {
      if (pattern.test(line)) { hasErrors = true; break; }
    }
    if (hasErrors) break;
  }
  if (!hasErrors) return null;

  // Extract error/summary lines
  const errorLines: string[] = [];
  const summaryLines: string[] = [];
  const seenLines = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (SYNC_SUMMARY_PATTERNS.some(p => p.test(trimmed))) {
      if (!seenLines.has(trimmed)) { summaryLines.push(line); seenLines.add(trimmed); }
      continue;
    }
    for (const pattern of SYNC_ERROR_PATTERNS) {
      if (pattern.test(trimmed)) {
        if (!seenLines.has(trimmed)) {
          errorLines.push(line);
          seenLines.add(trimmed);
          // Also grab 1 context line after error
          if (i + 1 < lines.length) {
            const next = lines[i + 1].trim();
            if (next && (next.startsWith("at ") || next.startsWith("  "))) {
              errorLines.push(lines[i + 1]);
            }
          }
        }
        break;
      }
    }
  }

  if (errorLines.length === 0 && summaryLines.length === 0) return null;

  // Build error-preserving output
  const errorBudget = Math.round(maxTokens * 0.4);
  const headBudget = Math.round(maxTokens * 0.35);
  const tailBudget = maxTokens - errorBudget - headBudget;

  // Head
  const headOut: string[] = [];
  let ht = 0;
  for (const line of lines) {
    const lt = estimateTokens(line);
    if (ht + lt > headBudget) break;
    headOut.push(line); ht += lt;
  }

  // Error section
  const errorSection: string[] = [];
  let et = 0;
  for (const line of [...errorLines, ...summaryLines]) {
    const lt = estimateTokens(line);
    if (et + lt > errorBudget) break;
    errorSection.push(line); et += lt;
  }

  // Tail
  const tailOut: string[] = [];
  let tt = 0;
  for (let i = lines.length - 1; i >= headOut.length; i--) {
    const lt = estimateTokens(lines[i]);
    if (tt + lt > tailBudget) break;
    tailOut.unshift(lines[i]); tt += lt;
  }

  const result = [
    ...headOut,
    "",
    `[⚠ Extracted ${errorLines.length} error(s), ${summaryLines.length} summary line(s):]`,
    ...errorSection,
    "",
    `[… ${lines.length - headOut.length - tailOut.length} lines omitted …]`,
    ...tailOut,
  ].join("\n");

  const resultTokens = estimateTokens(result);
  if (resultTokens >= tokens * 0.95) return null;

  return { distilled: true, content: result, tokens: resultTokens, rule: "error-extraction" };
}

/**
 * Synchronous domain-aware detection and compression.
 */
function syncDomainAware(
  content: string,
  tokens: number,
  category: PartCategory,
  config: DistillerConfig,
): { distilled: boolean; content: string; tokens: number; rule: string } | null {
  // BibTeX detection
  const bibMatches = content.match(/@\w+\s*\{/g);
  if (bibMatches && bibMatches.length >= 3) {
    const compressed = syncCompressBibtex(content);
    if (compressed) {
      const t = estimateTokens(compressed);
      if (t < tokens * 0.7) {
        return { distilled: true, content: compressed, tokens: t, rule: "domain-aware/bibtex" };
      }
    }
  }

  // CSV/TSV detection
  const firstLines = content.split("\n").slice(0, 5);
  for (const delim of ["\t", ",", "|"]) {
    const counts = firstLines.map(l => l.split(delim).length);
    if (counts[0] > 2 && counts.every(c => c === counts[0])) {
      const compressed = syncCompressCsv(content, delim, config.toolOutputMaxTokens);
      if (compressed) {
        const t = estimateTokens(compressed);
        if (t < tokens * 0.8) {
          return { distilled: true, content: compressed, tokens: t, rule: "domain-aware/csv" };
        }
      }
      break;
    }
  }

  return null;
}

/**
 * Synchronous BibTeX compression.
 */
function syncCompressBibtex(content: string): string | null {
  const lines = content.split("\n");
  const entries: Array<{ key: string; type: string; author: string; title: string; year: string }> = [];
  let currentType = "";
  let currentKey = "";
  let currentFields = new Map<string, string>();
  let braceDepth = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    const entryMatch = trimmed.match(/^@(\w+)\s*\{(.+?)(?:,\s*)?$/);
    if (entryMatch && braceDepth === 0) {
      if (currentKey) {
        entries.push({
          key: currentKey, type: currentType,
          author: currentFields.get("author") ?? "?",
          title: currentFields.get("title") ?? "?",
          year: currentFields.get("year") ?? "?",
        });
      }
      currentType = entryMatch[1].toLowerCase();
      currentKey = entryMatch[2];
      currentFields = new Map();
      braceDepth = 1;
      continue;
    }
    if (braceDepth > 0) {
      for (const ch of trimmed) { if (ch === "{") braceDepth++; else if (ch === "}") braceDepth--; }
      if (braceDepth <= 0) {
        entries.push({
          key: currentKey, type: currentType,
          author: currentFields.get("author") ?? "?",
          title: currentFields.get("title") ?? "?",
          year: currentFields.get("year") ?? "?",
        });
        currentKey = ""; braceDepth = 0;
        continue;
      }
      const fieldMatch = trimmed.match(/^(\w+)\s*=\s*[{"](.+?)[}"],?\s*$/);
      if (fieldMatch) currentFields.set(fieldMatch[1].toLowerCase(), fieldMatch[2]);
    }
  }
  if (currentKey) {
    entries.push({
      key: currentKey, type: currentType,
      author: currentFields.get("author") ?? "?",
      title: currentFields.get("title") ?? "?",
      year: currentFields.get("year") ?? "?",
    });
  }

  if (entries.length < 3) return null;

  const typeCounts = new Map<string, number>();
  for (const e of entries) typeCounts.set(e.type, (typeCounts.get(e.type) ?? 0) + 1);
  const years = entries.map(e => parseInt(e.year)).filter(y => y > 1900);

  const result = [
    `[BibTeX: ${entries.length} entries]`,
    `Types: ${[...typeCounts.entries()].map(([t, c]) => `${t}(${c})`).join(", ")}`,
    years.length > 0 ? `Year range: ${Math.min(...years)}–${Math.max(...years)}` : "",
    "",
    "Entries:",
    ...entries.map(e => {
      const shortAuthor = e.author.length > 30 ? e.author.split(" and ")[0] + " et al." : e.author;
      const shortTitle = e.title.length > 60 ? e.title.slice(0, 57) + "…" : e.title;
      return `- [${e.key}] ${shortAuthor} (${e.year}): ${shortTitle}`;
    }),
  ].filter(Boolean).join("\n");

  return result;
}

/**
 * Synchronous CSV compression.
 */
function syncCompressCsv(content: string, delimiter: string, maxTokens: number): string | null {
  const lines = content.split("\n").filter(l => l.trim());
  if (lines.length < 5) return null;

  const header = lines[0].split(delimiter).map(h => h.trim().replace(/^"|"$/g, ""));
  const rows = lines.slice(1).map(l => l.split(delimiter).map(c => c.trim().replace(/^"|"$/g, "")));

  const sections: string[] = [];
  sections.push(`[Tabular data: ${rows.length} rows × ${header.length} columns]`);
  sections.push(`Columns: ${header.join(", ")}`);

  // Column stats for first 8 columns
  for (let col = 0; col < Math.min(header.length, 8); col++) {
    const values = rows.map(r => r[col] ?? "").filter(v => v !== "");
    const numericValues = values.map(Number).filter(n => !isNaN(n));
    if (numericValues.length > values.length * 0.8) {
      const min = Math.min(...numericValues);
      const max = Math.max(...numericValues);
      sections.push(`  ${header[col]}: numeric [${min}, ${max}]`);
    } else {
      const unique = new Set(values);
      sections.push(`  ${header[col]}: ${unique.size} unique values`);
    }
  }

  // Sample rows
  sections.push(`Sample rows:`);
  const indices = [0, Math.floor(rows.length / 2), rows.length - 1];
  for (const idx of indices) {
    if (idx < rows.length) {
      const compact = rows[idx].map(v => v.length > 25 ? v.slice(0, 22) + "…" : v);
      sections.push(`  [${idx}] ${compact.join(delimiter + " ")}`);
    }
  }

  return sections.join("\n");
}

/**
 * Fully synchronous distillation — no Promises, no async, no microtask reliance.
 * Enhanced with content-aware intelligence: analyzes content to dynamically
 * adjust token budgets and choose optimal compression strategies.
 *
 * Key improvements over v1:
 * 1. Content analysis detects search results, API responses, help text, etc.
 * 2. High-value content (search results) gets 3-4x higher token budget
 * 3. Low-value content (install logs, help text) gets compressed more aggressively
 * 4. JSON search results are preserved with structured summaries instead of head-tail
 * 5. Single-line content is handled via character-level truncation (no more "6 tokens")
 */
function distillSync(
  content: string,
  tokens: number,
  category: PartCategory,
  config: DistillerConfig,
): { distilled: boolean; content: string; tokens: number; rule: string } | null {
  const multiplier = getAggressivenessMultiplier(config.aggressiveness);

  // Get base threshold for category
  let baseThreshold: number;
  switch (category) {
    case "tool_output":  baseThreshold = Math.round(config.toolOutputMaxTokens * multiplier); break;
    case "patch":        baseThreshold = Math.round(config.patchMaxTokens * multiplier); break;
    case "file_content": baseThreshold = Math.round(config.fileContentMaxTokens * multiplier); break;
    default:             return null;
  }

  // ── Content intelligence: analyze and adjust budget ──
  let effectiveThreshold = baseThreshold;
  let effectiveBudget = baseThreshold; // How many tokens to preserve after compression
  let analysis: ContentAnalysis | null = null;

  if (category === "tool_output") {
    analysis = analyzeContent(content);
    effectiveThreshold = Math.round(baseThreshold * analysis.budgetMultiplier);
    effectiveBudget = Math.round(baseThreshold * analysis.budgetMultiplier);
  }

  // Below (dynamically adjusted) threshold — skip
  if (tokens <= effectiveThreshold) return null;

  // ── Strategy selection based on content analysis ──

  // CRITICAL path: search results — always use JSON summary to preserve URLs/titles/snippets
  if (analysis?.subtype === "search_results") {
    const jsonSummary = syncTryJsonSummary(content, effectiveBudget);
    if (jsonSummary) {
      const resultTokens = estimateTokens(jsonSummary);
      if (resultTokens < tokens) {
        return { distilled: true, content: jsonSummary, tokens: resultTokens, rule: "smart/search-results" };
      }
    }
    // Fallback: even for search results, do smart truncation with high budget
    const truncated = syncHeadTailTruncation(content, effectiveBudget);
    return { distilled: true, content: truncated, tokens: estimateTokens(truncated), rule: "smart/search-fallback" };
  }

  // HIGH value: API responses — prefer JSON summary
  if (analysis?.subtype === "api_response") {
    const jsonSummary = syncTryJsonSummary(content, effectiveBudget);
    if (jsonSummary) {
      const resultTokens = estimateTokens(jsonSummary);
      if (resultTokens < tokens) {
        return { distilled: true, content: jsonSummary, tokens: resultTokens, rule: "smart/api-response" };
      }
    }
  }

  // Rule 1 (P4): Domain-aware — BibTeX, CSV, Markdown
  const domainResult = syncDomainAware(content, tokens, category, config);
  if (domainResult) return domainResult;

  // Rule 2 (P5): Repetition elimination (applies to all categories)
  // Skip JSON content — let JSON summary handle it more effectively
  if (tokens > 200 && content.split("\n").length > 15) {
    const trimmed = content.trim();
    let isJson = false;
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try { JSON.parse(trimmed); isJson = true; } catch { /* not JSON */ }
    }

    if (!isJson) {
      // Try record dedup first (threshold < 40%)
      const recordDedup = syncDeduplicateRecords(content);
      if (recordDedup) {
        const rTokens = estimateTokens(recordDedup);
        if (rTokens < tokens * 0.40) {
          return { distilled: true, content: recordDedup, tokens: rTokens, rule: "repetition-elimination/records" };
        }
      }

      // Then try line dedup
      const deduped = syncDeduplicateLines(content);
      if (deduped) {
        return { distilled: true, content: deduped, tokens: estimateTokens(deduped), rule: "repetition-elimination/lines" };
      }
    }
  }

  // Rule 3 (P8): Error extraction — for tool_output with error patterns
  if (category === "tool_output") {
    const errorResult = syncExtractErrors(content, tokens, effectiveBudget);
    if (errorResult) return errorResult;
  }

  // Rule 4+ (P10): Category-specific distillation
  switch (category) {
    case "tool_output": {
      // Try JSON summary (for non-search JSON content that wasn't caught above)
      const jsonSummary = syncTryJsonSummary(content, effectiveBudget);
      if (jsonSummary && estimateTokens(jsonSummary) < tokens * 0.8) {
        return { distilled: true, content: jsonSummary, tokens: estimateTokens(jsonSummary), rule: "tool-output-truncation/json" };
      }
      // Try file listing summary
      const listingSummary = syncTryFileListingSummary(content);
      if (listingSummary) {
        return { distilled: true, content: listingSummary, tokens: estimateTokens(listingSummary), rule: "tool-output-truncation/listing" };
      }
      // Head+tail truncation with effective budget
      const truncated = syncHeadTailTruncation(content, effectiveBudget);
      return { distilled: true, content: truncated, tokens: estimateTokens(truncated), rule: "tool-output-truncation/head-tail" };
    }

    case "patch": {
      const contextLines = config.aggressiveness === "aggressive" ? 1
        : config.aggressiveness === "moderate" ? 2 : 3;
      const compressed = syncCompressDiff(content, contextLines);
      let finalContent = compressed;
      let afterTokens = estimateTokens(compressed);
      if (afterTokens > config.patchMaxTokens * 1.5) {
        // Count stats manually
        let additions = 0, deletions = 0, hunks = 0, files = 0;
        for (const line of content.split("\n")) {
          if (line.startsWith("+++ ") || line.startsWith("--- ")) files++;
          else if (line.startsWith("@@")) hunks++;
          else if (line.startsWith("+") && !line.startsWith("+++")) additions++;
          else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
        }
        files = Math.max(1, Math.ceil(files / 2));
        finalContent = [
          `[Patch summary: ${files} file(s), +${additions}/-${deletions}, ${hunks} hunk(s)]`,
          compressed.split("\n").slice(0, Math.ceil(config.patchMaxTokens / 3)).join("\n"),
          `[… diff truncated]`,
        ].join("\n");
        afterTokens = estimateTokens(finalContent);
      }
      return { distilled: true, content: finalContent, tokens: afterTokens, rule: "patch-distill" };
    }

    case "file_content": {
      // Try config summary
      const configSummary = syncTryConfigSummary(content, config.fileContentMaxTokens);
      if (configSummary) {
        return { distilled: true, content: configSummary, tokens: estimateTokens(configSummary), rule: "file-content-distill/config" };
      }
      // Try code structural summary
      const codeSummary = syncTryCodeStructuralSummary(content, config.fileContentMaxTokens);
      if (codeSummary && estimateTokens(codeSummary) < tokens * 0.7) {
        return { distilled: true, content: codeSummary, tokens: estimateTokens(codeSummary), rule: "file-content-distill/code-structure" };
      }
      // Simple truncation
      const truncated = truncateToTokenBudget(content, config.fileContentMaxTokens);
      return { distilled: true, content: truncated, tokens: estimateTokens(truncated), rule: "file-content-distill/truncate" };
    }
  }

  return null;
}

// ── Layered Recall: summary + section index + full-text access ──────────
//
// For large user/assistant messages (e.g. memory-reflection injection),
// instead of naive truncation, we produce a structured envelope that lets
// the agent understand the gist without losing access to the full content.
//
// The envelope contains:
// 1. Summary — keypoint extraction from the original text (sync, rule-based)
// 2. Section Index — logical segment map with topic + line range
// 3. Full-text Access — session file path + timestamp for on-demand retrieval
//
// This way the agent can "understand" the message's purpose and decide
// whether to retrieve the full text via read_file.

interface SectionEntry {
  startLine: number;
  endLine: number;
  heading?: string;
  topic: string;
  chars: number;
}

/**
 * Split content into logical sections based on structural cues.
 * Returns an array of SectionEntry with approximate line ranges and topic hints.
 */
function syncBuildSectionIndex(content: string): SectionEntry[] {
  const lines = content.split("\n");
  const sections: SectionEntry[] = [];
  let currentStart = 0;
  let currentHeading: string | undefined;
  let currentTopicLines: string[] = [];
  let currentChars = 0;

  const flush = (endLine: number) => {
    if (endLine > currentStart) {
      const topic = currentHeading
        || currentTopicLines.filter(l => l.trim().length > 20).slice(0, 2).join(" ").trim()
        || "(unlabeled section)";
      sections.push({
        startLine: currentStart + 1,
        endLine,
        heading: currentHeading || undefined,
        topic: topic.length > 120 ? topic.slice(0, 117) + "..." : topic,
        chars: currentChars,
      });
    }
    currentStart = endLine;
    currentHeading = undefined;
    currentTopicLines = [];
    currentChars = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    currentChars += line.length + 1;

    const headingMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headingMatch) {
      flush(i);
      currentHeading = headingMatch[2].trim();
      currentStart = i;
      continue;
    }

    const labeledSeparatorMatch = line.match(/^[-=]{3,}\s*(.+?)\s*[-=]{3,}$/);
    if (labeledSeparatorMatch && i > currentStart + 2) {
      flush(i);
      currentHeading = labeledSeparatorMatch[1].trim();
      currentStart = i;
      continue;
    }

    if (trimmed === "```" && i > currentStart + 3) {
      continue;
    }

    if (line.match(/^---+$|^===+$/) && i > currentStart + 2) {
      flush(i);
      continue;
    }

    if (
      currentTopicLines.length < 3 &&
      trimmed.length > 10 &&
      !line.startsWith("#") &&
      !line.startsWith("```")
    ) {
      currentTopicLines.push(trimmed);
    }
  }

  flush(lines.length);
  return sections;
}

/**
 * Extract keypoint summary from content lines.
 * Uses a sync, rule-based approach: picks high-signal lines
 * (headings, bullet points, lines with key patterns) while
 * deduplicating similar lines.
 *
 * Returns a formatted summary string, or null if extraction fails.
 */
function syncExtractKeypointSummary(
  content: string,
  maxLines: number,
): string | null {
  const lines = content.split("\n");
  if (lines.length < 8) return null;

  const keypointSet = new Set<string>();
  const keypointLines: string[] = [];

  const pushKeypoint = (value: string, dedupeKey?: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const normalized = (dedupeKey ?? trimmed).slice(0, 120).toLowerCase();
    if (keypointSet.has(normalized)) return;
    keypointSet.add(normalized);
    keypointLines.push(trimmed.length > 220 ? trimmed.slice(0, 217) + "..." : trimmed);
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (/^#{1,4}\s+/.test(trimmed)) {
      const heading = trimmed.replace(/^#+\s*/, "");
      if (heading.length > 2) pushKeypoint(trimmed, heading);
      if (keypointLines.length >= maxLines) break;
      continue;
    }

    if (/^[-*]\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed)) {
      const normalized = trimmed.replace(/^[-*\d.)\s]+/, "");
      if (normalized.length > 10) pushKeypoint(trimmed, normalized);
      if (keypointLines.length >= maxLines) break;
      continue;
    }

    // Structured table headers, e.g. NAME READY STATUS / COMMAND PID USER
    if (/^[A-Z][A-Z0-9_./ -]{3,}(?:\s{2,}|\t)[A-Z][A-Z0-9_./ -]{2,}/.test(trimmed)) {
      pushKeypoint(`[table] ${trimmed}`, `table:${trimmed}`);
      if (keypointLines.length >= maxLines) break;
      continue;
    }

    // KEY=value env/config lines
    if (/^[A-Z_][A-Z0-9_]*=/.test(trimmed)) {
      const key = trimmed.split("=")[0] ?? "";
      if (/^(PATH|HOME|PWD|USER|SHELL|LANG|NODE_ENV|DATABASE_URL|REDIS_URL|OPENCLAW_|CONTEXT_DISTILLER_)/.test(key)) {
        pushKeypoint(trimmed, `env:${key}`);
        if (keypointLines.length >= maxLines) break;
        continue;
      }
    }

    // file:line content / grep / compiler / stack samples
    if (
      /^\S+\.\w+:\d+(?::\d+)?[: ]/.test(trimmed) ||
      /^File\s+".+",\s+line\s+\d+/.test(trimmed) ||
      /^(\.\/|\/|[A-Za-z]:\\)/.test(trimmed)
    ) {
      pushKeypoint(trimmed, `path:${trimmed.replace(/\d+/g, "#")}`);
      if (keypointLines.length >= maxLines) break;
      continue;
    }

    // CSV / TSV / pipe header-like lines
    if ((trimmed.match(/,/g)?.length ?? 0) >= 3 || (trimmed.match(/\|/g)?.length ?? 0) >= 3 || (trimmed.match(/\t/g)?.length ?? 0) >= 2) {
      const fieldCount = Math.max(
        trimmed.split(",").length,
        trimmed.split("|").length,
        trimmed.split("\t").length,
      );
      if (fieldCount >= 4 && !/^\d/.test(trimmed)) {
        pushKeypoint(`[fields] ${trimmed}`, `fields:${trimmed}`);
        if (keypointLines.length >= maxLines) break;
        continue;
      }
    }

    if (/(?:decided|confirmed|fixed|changed|updated|created|deleted|error|fail|success|result|conclusion|note|important|warning|assertion|exception|traceback|timeout|deprecated|vulnerab|compiled successfully|passing|failing|plan:|found \d+ errors?)/i.test(trimmed)) {
      pushKeypoint(trimmed);
    }

    if (keypointLines.length >= maxLines) break;
  }

  if (keypointLines.length < 3) return null;
  return keypointLines.join("\n");
}

/**
 * Build the layered-recall envelope for a large message.
 *
 * @param content The original message content
 * @param role The message role (user/assistant)
 * @param sessionId Optional session ID for full-text access pointer
 * @param timestamp Optional timestamp for provenance
 * @param config Distiller config (for thresholds)
 * @returns The compressed envelope string, or null if no compression needed
 */
function syncLayeredRecall(
  content: string,
  role: string,
  sessionId?: string,
  timestamp?: string,
  config?: DistillerConfig,
): { envelope: string; rule: string } | null {
  const tokens = estimateTokens(content);
  const threshold = config?.messageMaxTokens ?? 3000;
  const maxSummaryLines = config?.messageSummaryMaxLines ?? 40;

  if (tokens <= threshold) return null;

  const lines = content.split("\n");
  const totalLines = lines.length;
  const totalChars = content.length;
  const sections = syncBuildSectionIndex(content);
  const analysis = analyzeContent(content);

  const summaryBudget = Math.max(200, Math.round(threshold * 0.45));
  const activeConfig = config ?? {
    enabled: true,
    toolOutputMaxTokens: 1200,
    patchMaxTokens: 600,
    fileContentMaxTokens: 1000,
    messageMaxTokens: 3000,
    messageSummaryMaxLines: 40,
    aggressiveness: "moderate" as const,
    preservePatterns: [],
    distillModel: undefined,
    distillProvider: undefined,
  };

  const capSummary = (value: string | null | undefined): string | null => {
    if (!value?.trim()) return null;
    const cappedLines = value.split("\n").slice(0, maxSummaryLines).join("\n");
    return estimateTokens(cappedLines) <= summaryBudget
      ? cappedLines
      : truncateToTokenBudget(cappedLines, summaryBudget);
  };

  let summary = capSummary(syncExtractKeypointSummary(content, maxSummaryLines));

  const extractRepresentativeSamples = (allLines: string[], maxSamples = 6): string[] => {
    const candidates = allLines
      .map(l => l.trim())
      .filter(l => l && l.length > 5 && !/^[-=]{3,}\s*.*\s*[-=]{3,}$/.test(l));
    if (candidates.length === 0) return [];

    const indexes = [0, Math.floor(candidates.length / 4), Math.floor(candidates.length / 2), Math.floor(candidates.length * 3 / 4), candidates.length - 1];
    const unique = [...new Set(indexes)]
      .filter(i => i >= 0 && i < candidates.length)
      .slice(0, maxSamples);

    const seen = new Set<string>();
    const samples: string[] = [];
    for (const idx of unique) {
      const value = candidates[idx];
      const normalized = value.replace(/\d+/g, "#").slice(0, 140).toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      samples.push(value.length > 220 ? value.slice(0, 217) + "..." : value);
      if (samples.length >= maxSamples) break;
    }
    return samples;
  };

  const summarizeEnvLike = (text: string): string | null => {
    const envLines = text.split("\n").map(l => l.trim()).filter(l => /^[A-Z_][A-Z0-9_]*=/.test(l));
    if (envLines.length < 5) return null;
    const preferred = envLines.filter(l => /^(PATH|HOME|PWD|USER|SHELL|LANG|NODE_ENV|DATABASE_URL|REDIS_URL|OPENCLAW_|CONTEXT_DISTILLER_)/.test(l));
    const sample = (preferred.length > 0 ? preferred : envLines).slice(0, 8);
    return [`[Environment-like output: ${envLines.length} variables]`, ...sample].join("\n");
  };

  const summarizeDockerImagesLike = (text: string): string | null => {
    const rows = text.split("\n").filter(l => l.trim());
    if (rows.length < 4 || !/^REPOSITORY\s+TAG\s+IMAGE ID/i.test(rows[0])) return null;
    const images = rows.slice(1);
    return [
      `[Docker images: ${images.length} entries]`,
      ...images.slice(0, 5),
      ...(images.length > 5 ? [`... and ${images.length - 5} more images`] : []),
    ].join("\n");
  };

  const summarizeKubectlPodsLike = (text: string): string | null => {
    const rows = text.split("\n").filter(l => l.trim());
    if (rows.length < 4 || !/^NAME\s+READY\s+STATUS/i.test(rows[0])) return null;
    const pods = rows.slice(1);
    const statuses = new Map<string, number>();
    for (const row of pods) {
      const cols = row.trim().split(/\s+/);
      const status = cols[2] ?? "unknown";
      statuses.set(status, (statuses.get(status) ?? 0) + 1);
    }
    return [
      `[Kubernetes pods: ${pods.length} entries]`,
      `Statuses: ${[...statuses.entries()].map(([k, v]) => `${k}(${v})`).join(", ")}`,
      ...pods.slice(0, 5),
      ...(pods.length > 5 ? [`... and ${pods.length - 5} more pods`] : []),
    ].join("\n");
  };

  const summarizeDuLike = (text: string): string | null => {
    const rows = text.split("\n").map(l => l.trim()).filter(l => /^\S+\s+\.?\//.test(l) || /^\S+\s+\.$/.test(l));
    if (rows.length < 5) return null;
    return [`[Directory size listing: ${rows.length} entries]`, ...rows.slice(0, 6)].join("\n");
  };

  const summarizeCsvLike = (text: string): string | null => {
    const rows = text.split("\n").map(l => l.trim()).filter(Boolean);
    if (rows.length < 5) return null;
    const header = rows[0];
    const delim = (header.match(/,/g)?.length ?? 0) >= 3 ? ","
      : (header.match(/\|/g)?.length ?? 0) >= 3 ? "|"
      : (header.match(/\t/g)?.length ?? 0) >= 2 ? "\t"
      : null;
    if (!delim) return null;
    const columns = header.split(delim).map(v => v.trim()).filter(Boolean);
    if (columns.length < 4) return null;
    return [
      `[Tabular data: ${Math.max(0, rows.length - 1)} rows × ${columns.length} columns]`,
      `Columns: ${columns.slice(0, 10).join(", ")}`,
      ...rows.slice(1, 4),
      ...(rows.length > 4 ? [`... and ${rows.length - 4} more row(s)`] : []),
    ].join("\n");
  };

  const summarizeDockerBuildLike = (text: string): string | null => {
    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
    const stepLines = lines.filter(l => /^Step\s+\d+\/\d+\s*:/.test(l));
    if (stepLines.length < 3) return null;
    const finalLine = lines.find(l => /compiled successfully|Successfully built|Successfully tagged|build complete/i.test(l));
    return [
      `[Docker build log: ${stepLines.length} step(s)]`,
      ...stepLines.slice(0, 5),
      ...(finalLine ? [`Result: ${finalLine}`] : []),
      ...(stepLines.length > 5 ? [`... and ${stepLines.length - 5} more step(s)`] : []),
    ].join("\n");
  };

  const summarizeTerraformPlanLike = (text: string): string | null => {
    const rows = text.split("\n");
    const planLine = rows.find(l => /^Plan:\s+\d+\s+to add,\s+\d+\s+to change,\s+\d+\s+to destroy\.?$/i.test(l.trim()));
    if (!planLine) return null;
    const resources = rows.map(l => l.trim()).filter(l => /^#\s+.+\s+will be\s+/.test(l));
    return [
      `[Terraform plan summary]`,
      planLine.trim(),
      ...resources.slice(0, 5),
      ...(resources.length > 5 ? [`... and ${resources.length - 5} more resource change(s)`] : []),
    ].join("\n");
  };

  const summarizeGitStatusLike = (text: string): string | null => {
    if (!/On branch\s+/i.test(text) || !/Changes not staged for commit|Untracked files/i.test(text)) return null;
    const rows = text.split("\n").map(l => l.trim()).filter(Boolean);
    const branch = rows.find(l => /^On branch\s+/i.test(l));
    const modified = rows.filter(l => /^modified:\s+/.test(l));
    const untrackedHeaderIdx = rows.findIndex(l => /^Untracked files:/i.test(l));
    const untracked = untrackedHeaderIdx >= 0
      ? rows.slice(untrackedHeaderIdx + 1).filter(l => !/^(use |no changes added|\(|On branch|Your branch)/i.test(l)).slice(0, 6)
      : [];
    return [
      `[git status summary]`,
      ...(branch ? [branch] : []),
      `Modified: ${modified.length}`,
      `Untracked: ${untracked.length}`,
      ...modified.slice(0, 5),
      ...untracked.slice(0, 3),
    ].join("\n");
  };

  const summarizeLsofLike = (text: string): string | null => {
    const rows = text.split("\n").map(l => l.trim()).filter(Boolean);
    if (rows.length < 4 || !/^COMMAND\s+PID\s+USER\s+FD/i.test(rows[0])) return null;
    const entries = rows.slice(1);
    return [
      `[lsof output: ${entries.length} descriptors]`,
      ...entries.slice(0, 5),
      ...(entries.length > 5 ? [`... and ${entries.length - 5} more descriptor(s)`] : []),
    ].join("\n");
  };

  if (!summary) {
    const envSummary = summarizeEnvLike(content);
    if (envSummary) summary = capSummary(envSummary);
  }

  if (!summary) {
    const k8sSummary = summarizeKubectlPodsLike(content);
    if (k8sSummary) summary = capSummary(k8sSummary);
  }

  if (!summary) {
    const dockerImagesSummary = summarizeDockerImagesLike(content);
    if (dockerImagesSummary) summary = capSummary(dockerImagesSummary);
  }

  if (!summary) {
    const duSummary = summarizeDuLike(content);
    if (duSummary) summary = capSummary(duSummary);
  }

  if (!summary) {
    const csvSummary = summarizeCsvLike(content);
    if (csvSummary) summary = capSummary(csvSummary);
  }

  if (!summary) {
    const dockerBuildSummary = summarizeDockerBuildLike(content);
    if (dockerBuildSummary) summary = capSummary(dockerBuildSummary);
  }

  if (!summary) {
    const terraformSummary = summarizeTerraformPlanLike(content);
    if (terraformSummary) summary = capSummary(terraformSummary);
  }

  if (!summary) {
    const gitStatusSummary = summarizeGitStatusLike(content);
    if (gitStatusSummary) summary = capSummary(gitStatusSummary);
  }

  if (!summary) {
    const lsofSummary = summarizeLsofLike(content);
    if (lsofSummary) summary = capSummary(lsofSummary);
  }

  if (!summary) {
    if (analysis.subtype === "search_results" || analysis.subtype === "api_response") {
      summary = capSummary(syncTryJsonSummary(content, summaryBudget));
    }

    if (!summary && analysis.subtype === "error_output") {
      const errorSummary = syncExtractErrors(content, tokens, summaryBudget);
      if (errorSummary) {
        summary = capSummary(errorSummary.content);
      }
    }

    if (!summary && analysis.subtype === "file_listing") {
      summary = capSummary(syncTryFileListingSummary(content));
    }

    if (!summary && analysis.subtype === "data_output") {
      const domainSummary = syncDomainAware(content, tokens, "tool_output", activeConfig);
      if (domainSummary) {
        summary = capSummary(domainSummary.content);
      } else {
        summary = capSummary(syncTryJsonSummary(content, summaryBudget));
      }
    }
  }

  const representativeSamples = !summary
    ? extractRepresentativeSamples(lines, 6)
    : [];

  const targetChars = Math.round(totalChars * 0.20);
  const RATIO_PLACEHOLDER = "__RATIO__";
  const parts: string[] = [];

  parts.push(`\`[LAYERED RECALL] ${role} message: ${totalLines} lines, ${totalChars.toLocaleString()} chars → ~${targetChars.toLocaleString()} chars (${RATIO_PLACEHOLDER}% compression)\``);
  parts.push("");

  if (summary) {
    parts.push("## Keypoint Summary");
    parts.push(summary);
    parts.push("");
  }

  if (representativeSamples.length > 0) {
    parts.push("## Representative Samples");
    for (const sample of representativeSamples) {
      parts.push(`- ${sample}`);
    }
    parts.push("");
  }

  if (sections.length > 0) {
    parts.push("## Section Index");
    for (const section of sections) {
      const marker = section.heading ? `**${section.heading}**` : "";
      const range = `L${section.startLine}-L${section.endLine}`;
      const sizeHint = section.chars > 5000
        ? `(${(section.chars / 1000).toFixed(1)}K chars, large)`
        : section.chars > 1000
          ? `(${(section.chars / 1000).toFixed(1)}K chars)`
          : `(${section.chars} chars)`;
      if (marker) {
        parts.push(`- ${range}: ${marker} — ${section.topic} ${sizeHint}`);
      } else {
        parts.push(`- ${range}: ${section.topic} ${sizeHint}`);
      }
    }
    parts.push("");
  }

  parts.push("## Full-text Access");
  if (sessionId) {
    parts.push(`Session ID: \`${sessionId}\``);
  }
  if (timestamp) {
    parts.push(`Timestamp: ${timestamp}`);
  }
  parts.push(`Original size: ${totalLines} lines, ${totalChars.toLocaleString()} chars`);
  parts.push("To retrieve the full original content, use `read_file` on the session transcript with the line ranges from the Section Index above.");
  parts.push("");

  const rawEnvelope = parts.join("\n");
  const envelopeTokens = estimateTokens(rawEnvelope);
  const actualRatio = tokens > 0
    ? ((1 - envelopeTokens / tokens) * 100).toFixed(1)
    : "0.0";
  const envelope = rawEnvelope.replace("__RATIO__", actualRatio);

  return { envelope, rule: "layered-recall/message" };
}

// ── Plugin definition ───────────────────────────────────────────────────────

const contextDistillerPlugin = {
  id: "context-distiller",
  name: "Context Distiller",
  description: "Intelligent Part distillation — compresses verbose tool outputs, patches, and file content before context ingestion",
  version: "0.1.0",
  kind: "context-engine",

  configSchema: {
    parse(value: unknown) {
      const raw = value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
      return resolveConfig(process.env, raw);
    },
  },

  register(api: OpenClawPluginApi) {
    const pluginConfig = api.pluginConfig && typeof api.pluginConfig === "object" && !Array.isArray(api.pluginConfig)
      ? api.pluginConfig
      : undefined;
    const config = resolveConfig(process.env, pluginConfig as Record<string, unknown> | undefined);

    const log = {
      info: (msg: string) => api.logger.info(msg),
      warn: (msg: string) => api.logger.warn(msg),
      error: (msg: string) => api.logger.error(msg),
      debug: (msg: string) => api.logger.debug?.(msg),
    };

    // Build optional LLM distillation function
    const llmDistill = buildLlmDistillFn(api, config);

    // Create the engine
    const engine = new DistillerEngine(config, log, llmDistill);

    // Initialize persistent stats store
    // Uses plugin directory as base, writes .stats.json alongside plugin files
    const pluginDir = new URL(".", import.meta.url).pathname;
    const statsStore = new StatsStore(pluginDir);

    // Register all built-in rules
    engine.addRule(domainAwareRule);              // Priority 4 — domain-specific (BibTeX/CSV/Markdown)
    engine.addRule(repetitionEliminationRule);   // Priority 5
    engine.addRule(errorExtractionRule);          // Priority 8
    engine.addRule(toolOutputTruncationRule);     // Priority 10
    engine.addRule(patchDistillRule);             // Priority 10
    engine.addRule(fileContentDistillRule);       // Priority 10

    // ── Hook: tool_result_persist ────────────────────────────────────────
    // This is the primary compression point. It fires when a tool result
    // is about to be persisted to the session transcript.
    //
    // CRITICAL: This hook is STRICTLY SYNCHRONOUS in Gateway. If a handler
    // returns a Promise, it is silently ignored. Therefore we use
    // distillSync() which contains NO async/await/Promise.
    //
    // Uses api.on() which maps to registerTypedHook() internally, writing
    // to registry.typedHooks consumed by the Gateway hook runner.
    api.on("tool_result_persist", (event) => {
      if (!config.enabled) return;

      const message = event.message;
      if (!message) return;

      // Extract text content from message
      const content = typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .filter((b: { type?: string; text?: string }) => b.type === "text" && b.text)
              .map((b: { type?: string; text?: string }) => b.text!)
              .join("\n")
          : "";

      if (!content) return;

      const tokens = estimateTokens(content);
      const category = classifyContent({
        toolName: event.toolName,
        isToolResult: true,
        content,
      });

      // Quick check: skip non-distillable categories
      if (category === "passthrough" || category === "structural" || category === "text") return;

      // Fully synchronous distillation — no Promises involved
      try {
        const result = distillSync(content, tokens, category, config);

        if (result && result.distilled) {
          const saved = tokens - result.tokens;

          // Update in-memory stats (session-scoped)
          engine.recordHookDistillation(tokens, saved, result.rule);
          // Update persistent stats (survives Gateway restarts)
          statsStore.recordDistillation(saved, result.rule);

          const ratio = ((1 - result.tokens / tokens) * 100).toFixed(1);
          log.info(
            `[distiller] hook: ${result.rule}: ${tokens} → ${result.tokens} tokens ` +
            `(saved ${saved}, ${ratio}%)` +
            (event.toolName ? ` [tool=${event.toolName}]` : ""),
          );

          // Return modified message to Gateway
          if (typeof message.content === "string") {
            return {
              message: { ...message, content: result.content },
            };
          }
          if (Array.isArray(message.content)) {
            return {
              message: {
                ...message,
                content: [{ type: "text", text: result.content }],
              },
            };
          }
        }
      } catch (err) {
        log.error(`[distiller] tool_result_persist error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, { priority: 50 });

    // ── Hook: before_message_write ──────────────────────────────────────
    // Two paths:
    //   1. role=tool(toolResult)  → head+tail truncation (existing logic)
    //   2. role=user/assistant    → layered recall: summary + section index + full-text pointer
    // Uses api.on() → registerTypedHook() for typed hook registration.
    api.on("before_message_write", (event, ctx) => {
      if (!config.enabled) return;

      const message = event.message;
      if (!message) return;

      const role = message.role as string;

      // ── Path 1: tool messages → head+tail truncation ──
      if (role === "tool" || role === "toolResult") {
        // Extract text content — support both string and array formats
        let content = "";
        if (typeof message.content === "string") {
          content = message.content;
        } else if (Array.isArray(message.content)) {
          content = message.content
            .filter((b: { type?: string; text?: string }) => b.type === "text" && b.text)
            .map((b: { type?: string; text?: string }) => b.text!)
            .join("\n");
        }

        if (!content) return;

        const tokens = estimateTokens(content);
        if (tokens <= config.toolOutputMaxTokens) return;

        // Use syncHeadTailTruncation for consistent token-budget-based truncation
        const truncated = syncHeadTailTruncation(content, config.toolOutputMaxTokens);
        const newTokens = estimateTokens(truncated);

        // Only return if we actually saved something meaningful (>5%)
        if (newTokens >= tokens * 0.95) return;

        if (typeof message.content === "string") {
          return { message: { ...message, content: truncated } };
        }
        if (Array.isArray(message.content)) {
          return {
            message: {
              ...message,
              content: message.content.map((block: { type?: string; text?: string }) =>
                block.type === "text" ? { ...block, text: truncated } : block,
              ),
            },
          };
        }
        return;
      }

      // ── Path 2: user/assistant messages → layered recall ──
      if (role === "user" || role === "assistant") {
        // Extract text content (may be string or content blocks array)
        let textContent = "";
        if (typeof message.content === "string") {
          textContent = message.content;
        } else if (Array.isArray(message.content)) {
          textContent = message.content
            .filter((b: { type?: string; text?: string }) => b.type === "text" && b.text)
            .map((b: { type?: string; text?: string }) => b.text!)
            .join("\n");
        }

        if (!textContent) return;

        const tokens = estimateTokens(textContent);
        if (tokens <= config.messageMaxTokens) return;

        // Apply layered recall
        const result = syncLayeredRecall(
          textContent,
          role,
          ctx?.sessionKey as string | undefined,  // sessionKey from ctx
          (message as any).timestamp as string | undefined,  // timestamp from message
          config,
        );

        if (!result) return;

        const saved = tokens - estimateTokens(result.envelope);
        if (saved <= 0) return; // No point if we didn't save anything

        // Update stats
        engine.recordHookDistillation(tokens, saved, result.rule);
        statsStore.recordDistillation(saved, result.rule);

        const ratio = ((1 - estimateTokens(result.envelope) / tokens) * 100).toFixed(1);
        log.info(
          `[distiller] layered-recall: ${tokens} → ${estimateTokens(result.envelope)} tokens ` +
          `(saved ${saved}, ${ratio}%) [role=${role}]`,
        );

        // Return modified message
        if (typeof message.content === "string") {
          return {
            message: { ...message, content: result.envelope },
          };
        }
        if (Array.isArray(message.content)) {
          // Replace only text blocks, preserve other block types (thinking, etc.)
          const newContent = message.content.map((block: { type?: string; text?: string }) => {
            if (block.type === "text") {
              return { ...block, text: result.envelope };
            }
            return block;
          });
          // If no text block found, prepend one
          const hasTextBlock = newContent.some((b: { type?: string }) => b.type === "text");
          if (!hasTextBlock) {
            newContent.unshift({ type: "text", text: result.envelope });
          }
          return {
            message: {
              ...message,
              content: newContent,
            },
          };
        }
      }
    }, { priority: 50 });

    // ── Register tools ──────────────────────────────────────────────────
    // Use factory pattern to receive tool context (sessionId, agentId, etc.)
    api.registerTool((_ctx) => createDistillStatusTool(engine, statsStore));
    api.registerTool((_ctx) => createDistillConfigureTool(engine));
    api.registerTool((_ctx) => testDistillerTool);

    // ── Log startup ─────────────────────────────────────────────────────
    const persistent = statsStore.getStats();
    api.logger.info(
      `[context-distiller] Plugin loaded #${persistent.loadCount} ` +
      `(enabled=${config.enabled}, ` +
      `aggressiveness=${config.aggressiveness}, ` +
      `toolMax=${config.toolOutputMaxTokens}, ` +
      `patchMax=${config.patchMaxTokens}, ` +
      `fileMax=${config.fileContentMaxTokens}, ` +
      `rules=${engine.getRules().length}, ` +
      `lifetime: ${persistent.totalDistillations} distillations, ` +
      `${persistent.totalTokensSaved.toLocaleString()} tokens saved)`,
    );
  },
};

export default contextDistillerPlugin;

// ── Test-only exports (not part of the public API) ──────────────────────────
// These are used by the test suite to validate distillation behavior.
export {
  distillSync as _testDistillSync,
  analyzeContent as _testAnalyzeContent,
  syncHeadTailTruncation as _testSyncHeadTailTruncation,
  syncLayeredRecall as _testSyncLayeredRecall,
};
