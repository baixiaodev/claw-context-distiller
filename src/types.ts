/**
 * context-distiller — Type definitions
 *
 * Core types for the Part distillation system.
 */

// ── Distillation aggressiveness levels ──────────────────────────────────────

export type AggressivenessLevel = "conservative" | "moderate" | "aggressive";

// ── Plugin configuration ────────────────────────────────────────────────────

export interface DistillerConfig {
  /** Master switch */
  enabled: boolean;

  /** Token thresholds per Part type — content exceeding these gets distilled */
  toolOutputMaxTokens: number;
  patchMaxTokens: number;
  fileContentMaxTokens: number;

  /** How aggressively to compress */
  aggressiveness: AggressivenessLevel;

  /** Regex patterns for content that should never be distilled */
  preservePatterns: RegExp[];

  /** Optional LLM model/provider overrides for summarization */
  distillModel?: string;
  distillProvider?: string;
}

// ── Distillation result ─────────────────────────────────────────────────────

export interface DistillResult {
  /** Whether the content was actually modified */
  distilled: boolean;

  /** The (possibly compressed) content */
  content: string;

  /** Token count before distillation */
  tokensBefore: number;

  /** Token count after distillation */
  tokensAfter: number;

  /** Which rule triggered the distillation */
  rule?: string;

  /** Compression ratio (0-1, lower = more compression) */
  ratio?: number;
}

// ── Part classification for distillation ────────────────────────────────────

export type PartCategory =
  | "tool_output"     // Tool call results (often very verbose)
  | "patch"           // Code diffs / patches
  | "file_content"    // Inline file reads
  | "reasoning"       // Thinking/reasoning blocks
  | "text"            // Regular text content
  | "structural"      // step_start, step_finish, snapshot, etc.
  | "passthrough";    // Content that should never be distilled

// ── Distillation rule interface ─────────────────────────────────────────────

export interface DistillRule {
  /** Unique rule identifier */
  id: string;

  /** Human-readable description */
  description: string;

  /** Which Part categories this rule applies to */
  appliesTo: PartCategory[];

  /** Priority (lower = runs first) */
  priority: number;

  /**
   * Check if this rule should fire for the given content.
   * @returns true if distillation should proceed
   */
  shouldDistill(content: string, tokens: number, config: DistillerConfig): boolean;

  /**
   * Perform the distillation.
   * For rules that need LLM calls, the distiller engine provides the complete fn.
   */
  distill(
    content: string,
    tokens: number,
    config: DistillerConfig,
    llmDistill?: LlmDistillFn,
  ): Promise<DistillResult>;
}

// ── LLM distillation function ───────────────────────────────────────────────

/**
 * Passed to rules that need LLM-powered summarization.
 * The distiller engine handles model resolution, API key, etc.
 */
export type LlmDistillFn = (params: {
  content: string;
  instruction: string;
  maxOutputTokens?: number;
}) => Promise<string>;

// ── Stats tracking ──────────────────────────────────────────────────────────

export interface DistillStats {
  /** Total messages processed */
  messagesProcessed: number;

  /** Total distillations performed */
  distillations: number;

  /** Total tokens saved */
  tokensSaved: number;

  /** Per-rule hit counts */
  ruleHits: Record<string, number>;

  /** Timestamp of last distillation */
  lastDistilledAt?: number;

  /** Running compression ratio average */
  avgCompressionRatio: number;
}

// ── Logger interface ────────────────────────────────────────────────────────

export interface DistillerLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug: (msg: string) => void;
}
