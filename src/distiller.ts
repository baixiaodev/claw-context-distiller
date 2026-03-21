/**
 * context-distiller — Core distillation engine
 *
 * The DistillerEngine coordinates distillation rules, applies them to message
 * content, and tracks statistics. It sits between the OpenClaw message pipeline
 * and LCM ingestion via the `tool_result_persist` and `before_message_write` hooks.
 */

import { getAggressivenessMultiplier } from "./config.js";
import { estimateTokens } from "./tokens.js";
import type {
  DistillerConfig,
  DistillerLogger,
  DistillResult,
  DistillRule,
  DistillStats,
  LlmDistillFn,
  PartCategory,
} from "./types.js";

/**
 * Classify a tool result or message content into a PartCategory.
 */
export function classifyContent(params: {
  toolName?: string;
  isToolResult?: boolean;
  content: string;
}): PartCategory {
  if (params.isToolResult) {
    const tn = (params.toolName ?? "").toLowerCase();

    // Patch-producing tools
    if (tn.includes("edit") || tn.includes("patch") || tn.includes("replace") ||
        tn.includes("diff") || tn.includes("apply")) {
      return "patch";
    }

    // File-reading tools
    if (tn.includes("read_file") || tn.includes("cat") || tn.includes("view_file") ||
        tn === "read" || tn.includes("file_content")) {
      return "file_content";
    }

    return "tool_output";
  }

  // Detect patches by content heuristic
  if (params.content.includes("@@") && params.content.includes("---") &&
      params.content.includes("+++")) {
    return "patch";
  }

  return "text";
}

/**
 * Check if content matches any preserve pattern (should not be distilled).
 */
function matchesPreservePattern(content: string, patterns: RegExp[]): boolean {
  for (const pattern of patterns) {
    if (pattern.test(content)) return true;
  }
  return false;
}

/**
 * Get the effective token threshold for a category, adjusted by aggressiveness.
 */
function getEffectiveThreshold(category: PartCategory, config: DistillerConfig): number {
  const multiplier = getAggressivenessMultiplier(config.aggressiveness);

  switch (category) {
    case "tool_output":
      return Math.round(config.toolOutputMaxTokens * multiplier);
    case "patch":
      return Math.round(config.patchMaxTokens * multiplier);
    case "file_content":
      return Math.round(config.fileContentMaxTokens * multiplier);
    case "reasoning":
      // Reasoning is treated more conservatively
      return Math.round(config.toolOutputMaxTokens * multiplier * 1.5);
    default:
      return Infinity; // text/structural/passthrough — no threshold
  }
}

export class DistillerEngine {
  private rules: DistillRule[] = [];
  private stats: DistillStats = {
    messagesProcessed: 0,
    distillations: 0,
    tokensSaved: 0,
    ruleHits: {},
    avgCompressionRatio: 1.0,
  };

  constructor(
    private config: DistillerConfig,
    private log: DistillerLogger,
    private llmDistill?: LlmDistillFn,
  ) {}

  /**
   * Register a distillation rule.
   */
  addRule(rule: DistillRule): void {
    this.rules.push(rule);
    // Keep sorted by priority (lower first)
    this.rules.sort((a, b) => a.priority - b.priority);
    this.log.debug(`[distiller] Registered rule: ${rule.id} (priority=${rule.priority})`);
  }

  /**
   * Get all registered rules.
   */
  getRules(): readonly DistillRule[] {
    return this.rules;
  }

  /**
   * Attempt to distill a piece of content.
   *
   * Returns the original content unchanged if:
   * - The plugin is disabled
   * - Content matches a preserve pattern
   * - No rule fires for the content
   * - Content is below the threshold for its category
   */
  async distill(params: {
    content: string;
    category: PartCategory;
    toolName?: string;
  }): Promise<DistillResult> {
    const { content, category } = params;
    this.stats.messagesProcessed++;

    // Passthrough — never distill
    if (category === "passthrough" || category === "structural") {
      return { distilled: false, content, tokensBefore: 0, tokensAfter: 0 };
    }

    // Disabled
    if (!this.config.enabled) {
      return { distilled: false, content, tokensBefore: 0, tokensAfter: 0 };
    }

    // Preserve patterns
    if (matchesPreservePattern(content, this.config.preservePatterns)) {
      return { distilled: false, content, tokensBefore: 0, tokensAfter: 0 };
    }

    const tokensBefore = estimateTokens(content);
    const threshold = getEffectiveThreshold(category, this.config);

    // Below threshold — skip
    if (tokensBefore <= threshold) {
      return { distilled: false, content, tokensBefore, tokensAfter: tokensBefore };
    }

    // Find and apply the first matching rule
    const applicableRules = this.rules.filter(r => r.appliesTo.includes(category));

    for (const rule of applicableRules) {
      if (!rule.shouldDistill(content, tokensBefore, this.config)) {
        continue;
      }

      try {
        const result = await rule.distill(content, tokensBefore, this.config, this.llmDistill);

        if (result.distilled) {
          const saved = result.tokensBefore - result.tokensAfter;
          this.stats.distillations++;
          this.stats.tokensSaved += saved;
          this.stats.ruleHits[rule.id] = (this.stats.ruleHits[rule.id] ?? 0) + 1;
          this.stats.lastDistilledAt = Date.now();

          // Update running average compression ratio
          const ratio = result.tokensAfter / result.tokensBefore;
          this.stats.avgCompressionRatio =
            this.stats.avgCompressionRatio * 0.9 + ratio * 0.1;

          this.log.info(
            `[distiller] ${rule.id}: ${tokensBefore} → ${result.tokensAfter} tokens ` +
            `(saved ${saved}, ratio=${ratio.toFixed(2)})` +
            (params.toolName ? ` [tool=${params.toolName}]` : ""),
          );

          return result;
        }
      } catch (err) {
        this.log.error(
          `[distiller] Rule ${rule.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Continue to next rule on failure
      }
    }

    // No rule fired
    return { distilled: false, content, tokensBefore, tokensAfter: tokensBefore };
  }

  /**
   * Get current distillation statistics.
   */
  getStats(): DistillStats {
    return { ...this.stats };
  }

  /**
   * Record a distillation performed by the sync hook (outside the async engine).
   * This updates the shared stats so distill_status shows accurate numbers.
   */
  recordHookDistillation(tokensSaved: number, rule: string): void {
    this.stats.messagesProcessed++;
    this.stats.distillations++;
    this.stats.tokensSaved += tokensSaved;
    this.stats.ruleHits[rule] = (this.stats.ruleHits[rule] ?? 0) + 1;
    this.stats.lastDistilledAt = Date.now();
    const ratio = 1 - (tokensSaved / Math.max(1, tokensSaved + 100));
    this.stats.avgCompressionRatio =
      this.stats.avgCompressionRatio * 0.9 + ratio * 0.1;
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.stats = {
      messagesProcessed: 0,
      distillations: 0,
      tokensSaved: 0,
      ruleHits: {},
      avgCompressionRatio: 1.0,
    };
  }

  /**
   * Update config at runtime (e.g., via tool).
   */
  updateConfig(patch: Partial<DistillerConfig>): void {
    Object.assign(this.config, patch);
    this.log.info(`[distiller] Config updated: ${JSON.stringify(patch)}`);
  }

  /**
   * Get current config.
   */
  getConfig(): DistillerConfig {
    return { ...this.config };
  }
}
