/**
 * context-distiller — Configuration resolution
 *
 * Three-tier precedence: env vars > plugin config > defaults
 */

import type { AggressivenessLevel, DistillerConfig } from "./types.js";

const DEFAULTS: DistillerConfig = {
  enabled: true,
  toolOutputMaxTokens: 1200,
  patchMaxTokens: 600,
  fileContentMaxTokens: 1000,
  messageMaxTokens: 3000,
  messageSummaryMaxLines: 40,
  aggressiveness: "moderate",
  preservePatterns: [],
  distillModel: undefined,
  distillProvider: undefined,
};

const AGGRESSIVENESS_LEVELS: AggressivenessLevel[] = ["conservative", "moderate", "aggressive"];

function toInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.round(n);
  }
  return fallback;
}

function parsePatterns(value: unknown): RegExp[] {
  if (!value) return [];
  const arr = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return arr
    .map((p: unknown) => {
      if (typeof p !== "string") return null;
      const trimmed = p.trim();
      if (!trimmed) return null;
      try {
        return new RegExp(trimmed);
      } catch {
        return null;
      }
    })
    .filter((r): r is RegExp => r !== null);
}

/**
 * Resolve distiller configuration from env + plugin config.
 */
export function resolveConfig(
  env: NodeJS.ProcessEnv = process.env,
  pluginConfig?: Record<string, unknown>,
): DistillerConfig {
  const cfg = pluginConfig ?? {};

  const enabled = (() => {
    const envVal = env.CONTEXT_DISTILLER_ENABLED?.trim().toLowerCase();
    if (envVal === "false" || envVal === "0") return false;
    if (envVal === "true" || envVal === "1") return true;
    if (typeof cfg.enabled === "boolean") return cfg.enabled;
    return DEFAULTS.enabled;
  })();

  const aggressiveness = (() => {
    const envVal = env.CONTEXT_DISTILLER_AGGRESSIVENESS?.trim().toLowerCase();
    if (envVal && AGGRESSIVENESS_LEVELS.includes(envVal as AggressivenessLevel)) {
      return envVal as AggressivenessLevel;
    }
    if (typeof cfg.aggressiveness === "string" &&
        AGGRESSIVENESS_LEVELS.includes(cfg.aggressiveness as AggressivenessLevel)) {
      return cfg.aggressiveness as AggressivenessLevel;
    }
    return DEFAULTS.aggressiveness;
  })();

  return {
    enabled,
    toolOutputMaxTokens: toInt(
      env.CONTEXT_DISTILLER_TOOL_MAX_TOKENS ?? cfg.toolOutputMaxTokens,
      DEFAULTS.toolOutputMaxTokens,
    ),
    patchMaxTokens: toInt(
      env.CONTEXT_DISTILLER_PATCH_MAX_TOKENS ?? cfg.patchMaxTokens,
      DEFAULTS.patchMaxTokens,
    ),
    fileContentMaxTokens: toInt(
      env.CONTEXT_DISTILLER_FILE_MAX_TOKENS ?? cfg.fileContentMaxTokens,
      DEFAULTS.fileContentMaxTokens,
    ),
    messageMaxTokens: toInt(
      env.CONTEXT_DISTILLER_MESSAGE_MAX_TOKENS ?? cfg.messageMaxTokens,
      DEFAULTS.messageMaxTokens,
    ),
    messageSummaryMaxLines: toInt(
      env.CONTEXT_DISTILLER_MESSAGE_SUMMARY_MAX_LINES ?? cfg.messageSummaryMaxLines,
      DEFAULTS.messageSummaryMaxLines,
    ),
    aggressiveness,
    preservePatterns: parsePatterns(cfg.preservePatterns),
    distillModel: (env.CONTEXT_DISTILLER_MODEL?.trim() ||
      (typeof cfg.distillModel === "string" ? cfg.distillModel.trim() : "")) || undefined,
    distillProvider: (env.CONTEXT_DISTILLER_PROVIDER?.trim() ||
      (typeof cfg.distillProvider === "string" ? cfg.distillProvider.trim() : "")) || undefined,
  };
}

/**
 * Token multipliers per aggressiveness level.
 * Applied to threshold values — lower multiplier = more aggressive distillation.
 */
export function getAggressivenessMultiplier(level: AggressivenessLevel): number {
  switch (level) {
    case "conservative": return 1.5;    // Thresholds effectively 50% higher
    case "moderate":     return 1.0;    // Use thresholds as-is
    case "aggressive":   return 0.6;    // Thresholds effectively 40% lower
  }
}
