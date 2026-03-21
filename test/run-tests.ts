/**
 * context-distiller — Comprehensive Automated Test Suite
 *
 * Tests all modules:
 *  1. tokens.ts — CJK-aware token estimation + truncation
 *  2. config.ts — Three-tier configuration resolution
 *  3. distiller.ts — Core engine: classify, threshold, rule dispatch, stats
 *  4. rules/repetition.ts — Line & block deduplication
 *  5. rules/tool-output.ts — JSON summary, file listing, head+tail
 *  6. rules/patch-distill.ts — Diff compression
 *  7. rules/file-content.ts — Code structure, config summary, truncation
 *  8. Integration — Full pipeline simulation (engine + rules together)
 *
 * Run: npx tsx test/run-tests.ts
 */

import { estimateTokens, truncateToTokenBudget } from "../src/tokens.js";
import { resolveConfig, getAggressivenessMultiplier } from "../src/config.js";
import { DistillerEngine, classifyContent } from "../src/distiller.js";
import { repetitionEliminationRule } from "../src/rules/repetition.js";
import { toolOutputTruncationRule } from "../src/rules/tool-output.js";
import { patchDistillRule } from "../src/rules/patch-distill.js";
import { fileContentDistillRule } from "../src/rules/file-content.js";
import type { DistillerConfig, DistillerLogger, DistillRule } from "../src/types.js";

// ── Test framework ──────────────────────────────────────────────────────────

let totalTests = 0;
let passed = 0;
let failed = 0;
const failures: { name: string; error: string }[] = [];

function assert(condition: boolean, msg: string): void {
  totalTests++;
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push({ name: currentSuite + " > " + msg, error: "Assertion failed" });
    console.log(`    ❌ ${msg}`);
  }
}

function assertEqual<T>(actual: T, expected: T, msg: string): void {
  totalTests++;
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    failures.push({
      name: currentSuite + " > " + msg,
      error: `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    });
    console.log(`    ❌ ${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertInRange(actual: number, min: number, max: number, msg: string): void {
  totalTests++;
  if (actual >= min && actual <= max) {
    passed++;
  } else {
    failed++;
    failures.push({
      name: currentSuite + " > " + msg,
      error: `Expected ${actual} to be in [${min}, ${max}]`,
    });
    console.log(`    ❌ ${msg}: ${actual} not in [${min}, ${max}]`);
  }
}

let currentSuite = "";

function suite(name: string, fn: () => void | Promise<void>) {
  return async () => {
    currentSuite = name;
    console.log(`\n  📋 ${name}`);
    await fn();
  };
}

// ── Mock logger ─────────────────────────────────────────────────────────────

const logMessages: string[] = [];
const mockLog: DistillerLogger = {
  info: (msg) => logMessages.push(`INFO: ${msg}`),
  warn: (msg) => logMessages.push(`WARN: ${msg}`),
  error: (msg) => logMessages.push(`ERROR: ${msg}`),
  debug: (msg) => logMessages.push(`DEBUG: ${msg}`),
};

function clearLogs() { logMessages.length = 0; }

// ── Default config ──────────────────────────────────────────────────────────

function defaultConfig(): DistillerConfig {
  return resolveConfig({}, undefined);
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST SUITES
// ══════════════════════════════════════════════════════════════════════════════

// ── 1. Token Estimation ─────────────────────────────────────────────────────

const testTokens = suite("Token Estimation (tokens.ts)", () => {
  // Empty
  assertEqual(estimateTokens(""), 0, "Empty string → 0");
  assertEqual(estimateTokens(null as unknown as string), 0, "null → 0 (guard)");

  // Pure ASCII
  const ascii100 = "a".repeat(100);
  assertEqual(estimateTokens(ascii100), 25, "100 ASCII chars → 25 tokens (100/4)");

  // Pure CJK
  const cjk10 = "你好世界测试中文输入呢";
  const cjkTokens = estimateTokens(cjk10);
  assertInRange(cjkTokens, 6, 8, `10 CJK chars → ~7 tokens (10/1.5 ≈ 6.67)`);

  // Mixed CJK + ASCII
  const mixed = "Hello 你好 World 世界";
  const mixedTokens = estimateTokens(mixed);
  assert(mixedTokens > 0, `Mixed CJK+ASCII has positive tokens (${mixedTokens})`);
  // ASCII part: "Hello  World " = 13 chars → 13/4 ≈ 3.25
  // CJK part: 你好世界 = 4 chars → 4/1.5 ≈ 2.67
  // Total ≈ 6
  assertInRange(mixedTokens, 4, 8, "Mixed content token count reasonable");

  // Truncation
  const longText = Array.from({ length: 100 }, (_, i) => `Line ${i}: some content here`).join("\n");
  const truncated = truncateToTokenBudget(longText, 50);
  const truncTokens = estimateTokens(truncated);
  assert(truncTokens <= 60, `Truncated to ~50 tokens budget, got ${truncTokens}`);
  assert(truncated.includes("[… truncated"), "Contains truncation marker");

  // Truncation no-op for short text
  const shortText = "Hello world";
  assertEqual(truncateToTokenBudget(shortText, 1000), shortText, "Short text passes through");
});

// ── 2. Configuration ────────────────────────────────────────────────────────

const testConfig = suite("Configuration (config.ts)", () => {
  // Defaults
  const defaults = resolveConfig({}, undefined);
  assertEqual(defaults.enabled, true, "Default enabled = true");
  assertEqual(defaults.toolOutputMaxTokens, 800, "Default toolOutputMaxTokens = 800");
  assertEqual(defaults.patchMaxTokens, 600, "Default patchMaxTokens = 600");
  assertEqual(defaults.fileContentMaxTokens, 1000, "Default fileContentMaxTokens = 1000");
  assertEqual(defaults.aggressiveness, "moderate", "Default aggressiveness = moderate");
  assertEqual(defaults.preservePatterns.length, 0, "Default preservePatterns empty");
  assertEqual(defaults.distillModel, undefined, "Default distillModel undefined");

  // Plugin config override
  const fromPlugin = resolveConfig({}, {
    enabled: false,
    toolOutputMaxTokens: 500,
    aggressiveness: "aggressive",
    distillModel: "ollama/qwen3:8b",
  });
  assertEqual(fromPlugin.enabled, false, "Plugin config: enabled = false");
  assertEqual(fromPlugin.toolOutputMaxTokens, 500, "Plugin config: toolOutputMax = 500");
  assertEqual(fromPlugin.aggressiveness, "aggressive", "Plugin config: aggressiveness");
  assertEqual(fromPlugin.distillModel, "ollama/qwen3:8b", "Plugin config: distillModel");

  // Env var override (highest priority)
  const fromEnv = resolveConfig({
    CONTEXT_DISTILLER_ENABLED: "false",
    CONTEXT_DISTILLER_TOOL_MAX_TOKENS: "1200",
    CONTEXT_DISTILLER_AGGRESSIVENESS: "conservative",
    CONTEXT_DISTILLER_MODEL: "openai/gpt-4o-mini",
  }, {
    enabled: true,           // should be overridden by env
    toolOutputMaxTokens: 500, // should be overridden by env
    aggressiveness: "aggressive", // should be overridden by env
  });
  assertEqual(fromEnv.enabled, false, "Env overrides plugin: enabled = false");
  assertEqual(fromEnv.toolOutputMaxTokens, 1200, "Env overrides plugin: toolMax = 1200");
  assertEqual(fromEnv.aggressiveness, "conservative", "Env overrides: aggressiveness");
  assertEqual(fromEnv.distillModel, "openai/gpt-4o-mini", "Env: distillModel");

  // Preserve patterns
  const withPatterns = resolveConfig({}, {
    preservePatterns: ["error.*critical", "\\bAPI_KEY\\b"],
  });
  assertEqual(withPatterns.preservePatterns.length, 2, "2 preserve patterns parsed");
  assert(withPatterns.preservePatterns[0].test("error is critical"), "Pattern 1 matches");
  assert(withPatterns.preservePatterns[1].test("found API_KEY here"), "Pattern 2 matches");

  // Invalid aggressiveness falls back
  const badAgg = resolveConfig({}, { aggressiveness: "turbo" });
  assertEqual(badAgg.aggressiveness, "moderate", "Invalid aggressiveness falls back to moderate");

  // Aggressiveness multipliers
  assertEqual(getAggressivenessMultiplier("conservative"), 1.5, "Conservative = 1.5");
  assertEqual(getAggressivenessMultiplier("moderate"), 1.0, "Moderate = 1.0");
  assertEqual(getAggressivenessMultiplier("aggressive"), 0.6, "Aggressive = 0.6");
});

// ── 3. Content Classification ───────────────────────────────────────────────

const testClassify = suite("Content Classification (distiller.ts)", () => {
  // Tool result classification
  assertEqual(
    classifyContent({ toolName: "edit_file", isToolResult: true, content: "ok" }),
    "patch", "edit_file → patch"
  );
  assertEqual(
    classifyContent({ toolName: "replace_in_file", isToolResult: true, content: "ok" }),
    "patch", "replace_in_file → patch"
  );
  assertEqual(
    classifyContent({ toolName: "apply_diff", isToolResult: true, content: "ok" }),
    "patch", "apply_diff → patch"
  );
  assertEqual(
    classifyContent({ toolName: "read_file", isToolResult: true, content: "content" }),
    "file_content", "read_file → file_content"
  );
  assertEqual(
    classifyContent({ toolName: "view_file", isToolResult: true, content: "content" }),
    "file_content", "view_file → file_content"
  );
  assertEqual(
    classifyContent({ toolName: "execute_command", isToolResult: true, content: "output" }),
    "tool_output", "execute_command → tool_output"
  );
  assertEqual(
    classifyContent({ toolName: "web_search", isToolResult: true, content: "results" }),
    "tool_output", "web_search → tool_output"
  );

  // Content heuristic for patches
  const diffContent = "--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n-old\n+new";
  assertEqual(
    classifyContent({ content: diffContent }),
    "patch", "Diff-like content → patch"
  );

  // Regular text
  assertEqual(
    classifyContent({ content: "Hello world" }),
    "text", "Regular text → text"
  );
});

// ── 4. Distiller Engine ─────────────────────────────────────────────────────

const testEngine = suite("Distiller Engine (distiller.ts)", async () => {
  clearLogs();
  const config = defaultConfig();
  const engine = new DistillerEngine(config, mockLog);

  // Add rules
  engine.addRule(repetitionEliminationRule);
  engine.addRule(toolOutputTruncationRule);
  engine.addRule(patchDistillRule);
  engine.addRule(fileContentDistillRule);

  assertEqual(engine.getRules().length, 4, "4 rules registered");
  assertEqual(engine.getRules()[0].id, "repetition-elimination", "Repetition rule first (P5)");

  // Passthrough
  const passResult = await engine.distill({
    content: "test", category: "passthrough",
  });
  assertEqual(passResult.distilled, false, "Passthrough content not distilled");

  // Structural
  const structResult = await engine.distill({
    content: "test", category: "structural",
  });
  assertEqual(structResult.distilled, false, "Structural content not distilled");

  // Below threshold
  const smallResult = await engine.distill({
    content: "short tool output", category: "tool_output",
  });
  assertEqual(smallResult.distilled, false, "Content below threshold not distilled");

  // Above threshold — should trigger tool-output-truncation
  const verboseOutput = Array.from({ length: 200 }, (_, i) => `log line ${i}: processing item ${i} with status ok and result success`).join("\n");
  const verboseTokens = estimateTokens(verboseOutput);
  assert(verboseTokens > 800, `Verbose output has ${verboseTokens} tokens (> 800)`);

  const distillResult = await engine.distill({
    content: verboseOutput, category: "tool_output",
  });
  assert(distillResult.distilled, "Verbose content was distilled");
  assert(distillResult.tokensAfter < distillResult.tokensBefore, "Tokens reduced after distillation");

  // Stats
  const stats = engine.getStats();
  assert(stats.distillations > 0, `Distillations counted: ${stats.distillations}`);
  assert(stats.tokensSaved > 0, `Tokens saved: ${stats.tokensSaved}`);

  // Disabled
  engine.updateConfig({ enabled: false });
  const disabledResult = await engine.distill({
    content: verboseOutput, category: "tool_output",
  });
  assertEqual(disabledResult.distilled, false, "Disabled engine skips distillation");
  engine.updateConfig({ enabled: true });

  // Preserve patterns
  engine.updateConfig({ preservePatterns: [/CRITICAL_DATA/] });
  const preservedResult = await engine.distill({
    content: "CRITICAL_DATA " + verboseOutput, category: "tool_output",
  });
  assertEqual(preservedResult.distilled, false, "Preserve pattern prevents distillation");
  engine.updateConfig({ preservePatterns: [] });

  // Reset stats
  engine.resetStats();
  const resetStats = engine.getStats();
  assertEqual(resetStats.distillations, 0, "Stats reset: distillations = 0");
  assertEqual(resetStats.tokensSaved, 0, "Stats reset: tokensSaved = 0");
});

// ── 5. Repetition Elimination Rule ──────────────────────────────────────────

const testRepetition = suite("Repetition Elimination Rule", async () => {
  const config = defaultConfig();

  // Line deduplication: 50 lines where 40 are the same
  const repeated = [
    "Starting process...",
    ...Array.from({ length: 40 }, () => "Processing item: status=ok, duration=12ms"),
    "All items processed",
    "Done",
    ...Array.from({ length: 10 }, () => "Cleanup: removing temp files"),
  ].join("\n");

  const tokens = estimateTokens(repeated);
  assert(repetitionEliminationRule.shouldDistill(repeated, tokens, config), "Should trigger for repeated content");

  const result = await repetitionEliminationRule.distill(repeated, tokens, config);
  assert(result.distilled, "Repeated lines distilled");
  assert(result.content.includes("repeated"), "Contains repeat annotation");
  assert(result.tokensAfter < result.tokensBefore, `Tokens reduced: ${result.tokensBefore} → ${result.tokensAfter}`);

  // No repetition — short content
  const unique = "Line 1\nLine 2\nLine 3";
  const uniqueTokens = estimateTokens(unique);
  assertEqual(repetitionEliminationRule.shouldDistill(unique, uniqueTokens, config), false, "Short content: shouldDistill false");

  // Block deduplication
  const blockRepeated = Array.from({ length: 10 }, () =>
    "BEGIN BLOCK\nProcessing batch\nStatus: OK\nEND BLOCK"
  ).join("\n");
  const blockTokens = estimateTokens(blockRepeated);
  if (repetitionEliminationRule.shouldDistill(blockRepeated, blockTokens, config)) {
    const blockResult = await repetitionEliminationRule.distill(blockRepeated, blockTokens, config);
    // Block dedup may or may not trigger depending on 85% threshold
    if (blockResult.distilled) {
      assert(blockResult.content.includes("block repeated") || blockResult.content.includes("repeated"),
        "Block dedup has annotation");
    }
  }
});

// ── 6. Tool Output Truncation Rule ──────────────────────────────────────────

const testToolOutput = suite("Tool Output Truncation Rule", async () => {
  const config = defaultConfig();

  // JSON Array summary
  const jsonArray = JSON.stringify(
    Array.from({ length: 100 }, (_, i) => ({
      id: i, name: `item_${i}`, status: "active", created: "2026-03-21", tags: ["a", "b"]
    })),
  );
  const jsonTokens = estimateTokens(jsonArray);
  assert(toolOutputTruncationRule.shouldDistill(jsonArray, jsonTokens, config), "Large JSON: shouldDistill true");

  const jsonResult = await toolOutputTruncationRule.distill(jsonArray, jsonTokens, config);
  assert(jsonResult.distilled, "JSON array distilled");
  assert(jsonResult.content.includes("JSON Array") || jsonResult.content.includes("100 items"),
    "Contains JSON summary");
  assert(jsonResult.tokensAfter < jsonResult.tokensBefore,
    `JSON tokens reduced: ${jsonResult.tokensBefore} → ${jsonResult.tokensAfter}`);

  // JSON Object summary
  const bigObj: Record<string, unknown> = {};
  for (let i = 0; i < 20; i++) {
    bigObj[`key_${i}`] = { nested: true, values: Array.from({ length: 10 }, (_, j) => j) };
  }
  const jsonObj = JSON.stringify(bigObj);
  const objTokens = estimateTokens(jsonObj);
  if (toolOutputTruncationRule.shouldDistill(jsonObj, objTokens, config)) {
    const objResult = await toolOutputTruncationRule.distill(jsonObj, objTokens, config);
    assert(objResult.distilled, "JSON object distilled");
    assert(objResult.content.includes("JSON Object") || objResult.content.includes("keys"),
      "Contains object summary");
  }

  // File listing summary
  const fileListing = Array.from({ length: 50 }, (_, i) => {
    const ext = ["ts", "js", "json", "md", "css"][i % 5];
    return `/Users/test/project/src/module_${i}/index.${ext}`;
  }).join("\n");
  const listTokens = estimateTokens(fileListing);
  if (toolOutputTruncationRule.shouldDistill(fileListing, listTokens, config)) {
    const listResult = await toolOutputTruncationRule.distill(fileListing, listTokens, config);
    assert(listResult.distilled, "File listing distilled");
    assert(
      listResult.content.includes("File listing") || listResult.content.includes("files in"),
      "Contains listing summary"
    );
  }

  // Head+tail truncation (generic verbose output)
  const verbose = Array.from({ length: 200 }, (_, i) =>
    `[2026-03-21 01:${String(i % 60).padStart(2, "0")}:00] Worker ${i}: Completed task batch #${Math.floor(i / 10)} in 123ms`
  ).join("\n");
  const verboseTokens = estimateTokens(verbose);
  assert(toolOutputTruncationRule.shouldDistill(verbose, verboseTokens, config), "Verbose: shouldDistill true");

  const verboseResult = await toolOutputTruncationRule.distill(verbose, verboseTokens, config);
  assert(verboseResult.distilled, "Verbose output distilled");
  assert(
    verboseResult.content.includes("omitted") || verboseResult.content.includes("truncated") || verboseResult.content.includes("repeated"),
    "Contains truncation marker"
  );

  // Below threshold — should not distill
  const small = "small output";
  assertEqual(toolOutputTruncationRule.shouldDistill(small, estimateTokens(small), config), false,
    "Small content: shouldDistill false");
});

// ── 7. Patch Distill Rule ───────────────────────────────────────────────────

const testPatch = suite("Patch Distill Rule", async () => {
  const config = defaultConfig();

  // Large unified diff
  const diffLines: string[] = [
    "diff --git a/src/engine.ts b/src/engine.ts",
    "--- a/src/engine.ts",
    "+++ b/src/engine.ts",
  ];
  for (let hunk = 0; hunk < 5; hunk++) {
    const startLine = hunk * 50 + 1;
    diffLines.push(`@@ -${startLine},30 +${startLine},35 @@ function process() {`);
    for (let i = 0; i < 10; i++) diffLines.push(` context line ${startLine + i}`);
    diffLines.push(`-  const old = getValue(${hunk});`);
    diffLines.push(`+  const result = await getValueAsync(${hunk});`);
    diffLines.push(`+  if (!result) throw new Error("failed");`);
    for (let i = 0; i < 15; i++) diffLines.push(` more context line ${startLine + 12 + i}`);
    diffLines.push(`-  return old;`);
    diffLines.push(`+  return result;`);
    for (let i = 0; i < 10; i++) diffLines.push(` trailing context ${startLine + 28 + i}`);
  }
  const diff = diffLines.join("\n");
  const diffTokens = estimateTokens(diff);

  assert(patchDistillRule.shouldDistill(diff, diffTokens, config), `Diff shouldDistill true (${diffTokens} tokens)`);

  const patchResult = await patchDistillRule.distill(diff, diffTokens, config);
  assert(patchResult.distilled, "Patch distilled");
  assert(patchResult.tokensAfter < patchResult.tokensBefore,
    `Patch tokens reduced: ${patchResult.tokensBefore} → ${patchResult.tokensAfter}`);

  // Verify essential content preserved
  assert(patchResult.content.includes("engine.ts"), "File name preserved");
  assert(patchResult.content.includes("getValueAsync"), "Changed content preserved");
  assert(patchResult.content.includes("@@"), "Hunk markers preserved");

  // Small diff — should not distill
  const smallDiff = "--- a/file.ts\n+++ b/file.ts\n@@ -1,1 +1,1 @@\n-old\n+new";
  assertEqual(
    patchDistillRule.shouldDistill(smallDiff, estimateTokens(smallDiff), config),
    false, "Small diff: shouldDistill false"
  );

  // Aggressive mode — less context (or at worst comparable)
  const aggConfig = { ...config, aggressiveness: "aggressive" as const };
  const aggResult = await patchDistillRule.distill(diff, diffTokens, aggConfig);
  assert(aggResult.distilled, "Aggressive patch distilled");
  // Aggressive should save at least as much or be close (within 10% margin)
  assert(aggResult.tokensAfter <= patchResult.tokensAfter * 1.1,
    `Aggressive roughly comparable or better: ${aggResult.tokensAfter} ≤ ${Math.round(patchResult.tokensAfter * 1.1)}`);
});

// ── 8. File Content Distill Rule ────────────────────────────────────────────

const testFileContent = suite("File Content Distill Rule", async () => {
  const config = defaultConfig();

  // TypeScript code file
  const codeFile = [
    'import { useState, useEffect } from "react";',
    'import type { UserProfile, Settings } from "../types";',
    'import { apiClient } from "../api/client";',
    'import { validateEmail } from "../utils/validation";',
    '',
    'export interface UserFormProps {',
    '  initialData?: UserProfile;',
    '  onSave: (data: UserProfile) => void;',
    '}',
    '',
    'export function UserForm({ initialData, onSave }: UserFormProps) {',
    '  const [email, setEmail] = useState(initialData?.email ?? "");',
    '  const [name, setName] = useState(initialData?.name ?? "");',
    ...Array.from({ length: 100 }, (_, i) =>
      `  // Implementation line ${i}: complex form handling logic with validation and state management`
    ),
    '  return <form onSubmit={handleSubmit}>{/* JSX */}</form>;',
    '}',
    '',
    'export class UserService {',
    '  constructor(private client: typeof apiClient) {}',
    ...Array.from({ length: 50 }, (_, i) =>
      `  // Service method ${i}: API call with error handling and retry logic`
    ),
    '}',
    '',
    'export const DEFAULT_SETTINGS: Settings = {',
    '  theme: "dark",',
    '  language: "zh-CN",',
    '};',
  ].join("\n");

  const codeTokens = estimateTokens(codeFile);
  assert(fileContentDistillRule.shouldDistill(codeFile, codeTokens, config),
    `Code file shouldDistill true (${codeTokens} tokens)`);

  const codeResult = await fileContentDistillRule.distill(codeFile, codeTokens, config);
  assert(codeResult.distilled, "Code file distilled");
  assert(codeResult.tokensAfter < codeResult.tokensBefore,
    `Code tokens reduced: ${codeResult.tokensBefore} → ${codeResult.tokensAfter}`);
  // Should preserve imports and definitions
  assert(codeResult.content.includes("import") || codeResult.content.includes("Imports"),
    "Import lines preserved");

  // JSON config file
  const jsonConfig: Record<string, unknown> = {
    name: "my-project",
    version: "1.0.0",
    scripts: {
      build: "tsc && vite build",
      test: "vitest run",
      lint: "eslint src/",
    },
    dependencies: Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`package-${i}`, `^${i}.0.0`])
    ),
    devDependencies: Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`dev-package-${i}`, `^${i}.0.0`])
    ),
  };
  const jsonContent = JSON.stringify(jsonConfig, null, 2);
  const jsonTokens = estimateTokens(jsonContent);
  if (fileContentDistillRule.shouldDistill(jsonContent, jsonTokens, config)) {
    const jsonResult = await fileContentDistillRule.distill(jsonContent, jsonTokens, config);
    assert(jsonResult.distilled, "JSON config distilled");
    assert(jsonResult.content.includes("my-project") || jsonResult.content.includes("name"),
      "Key config values preserved");
  }

  // Small file — should not distill
  const small = 'export const hello = "world";';
  assertEqual(fileContentDistillRule.shouldDistill(small, estimateTokens(small), config), false,
    "Small file: shouldDistill false");
});

// ── 9. Integration Test ─────────────────────────────────────────────────────

const testIntegration = suite("Integration — Full Pipeline", async () => {
  clearLogs();
  const config = defaultConfig();
  const engine = new DistillerEngine(config, mockLog);

  engine.addRule(repetitionEliminationRule);
  engine.addRule(toolOutputTruncationRule);
  engine.addRule(patchDistillRule);
  engine.addRule(fileContentDistillRule);

  // Simulate typical workflow: several tool results
  const scenarios = [
    {
      name: "execute_command output (200 lines of logs)",
      content: Array.from({ length: 200 }, (_, i) =>
        `[INFO] Step ${i}: Processing batch ${Math.floor(i / 10)} — 100% complete`
      ).join("\n"),
      category: "tool_output" as const,
      expectDistill: true,
    },
    {
      name: "read_file result (large TS file)",
      content: [
        'import express from "express";',
        'import { Router } from "express";',
        'import { Database } from "./db";',
        'export class AppServer {',
        ...Array.from({ length: 200 }, (_, i) => `  // Server logic line ${i}`),
        '}',
      ].join("\n"),
      category: "file_content" as const,
      expectDistill: true,
    },
    {
      name: "edit_file result (large diff)",
      content: [
        "diff --git a/src/main.ts b/src/main.ts",
        "--- a/src/main.ts",
        "+++ b/src/main.ts",
        ...Array.from({ length: 20 }, (_, i) => [
          `@@ -${i * 30 + 1},20 +${i * 30 + 1},22 @@ function handleRequest() {`,
          ...Array.from({ length: 8 }, (_, j) => `   const result${i}_${j} = processStep(input, ${j});`),
          `-  oldImplementation(${i}, legacy_param_${i}, deprecated_option_${i});`,
          `-  oldValidation(${i}, legacy_check_${i});`,
          `+  newImplementation(${i}, modern_param_${i}, updated_option_${i});`,
          `+  newValidation(${i}, modern_check_${i});`,
          `+  additionalLogging(${i}, context_${i});`,
          ...Array.from({ length: 8 }, (_, j) => `   const output${i}_${j} = formatResult(result, ${j});`),
        ]).flat(),
      ].join("\n"),
      category: "patch" as const,
      expectDistill: true,
    },
    {
      name: "Small tool output (below threshold)",
      content: "File saved successfully.",
      category: "tool_output" as const,
      expectDistill: false,
    },
    {
      name: "Structural content (passthrough)",
      content: "Starting agent step",
      category: "structural" as const,
      expectDistill: false,
    },
  ];

  let totalSaved = 0;
  for (const scenario of scenarios) {
    const result = await engine.distill({
      content: scenario.content,
      category: scenario.category,
    });
    assertEqual(result.distilled, scenario.expectDistill,
      `${scenario.name}: distilled=${scenario.expectDistill}`);
    if (result.distilled) {
      totalSaved += result.tokensBefore - result.tokensAfter;
      assert(result.tokensAfter > 0, `${scenario.name}: non-zero tokens after`);
      assert(result.ratio! < 1, `${scenario.name}: compression ratio < 1`);
    }
  }

  const finalStats = engine.getStats();
  assertEqual(finalStats.distillations, 3, "3 distillations performed");
  assert(finalStats.tokensSaved > 100, `Significant tokens saved: ${finalStats.tokensSaved}`);
  assert(Object.keys(finalStats.ruleHits).length > 0, "Rule hit counts tracked");

  console.log(`    📊 Integration summary: ${finalStats.distillations} distillations, ${finalStats.tokensSaved} tokens saved`);
  console.log(`    📊 Rule hits: ${JSON.stringify(finalStats.ruleHits)}`);
});

// ── 10. Edge Cases ──────────────────────────────────────────────────────────

const testEdgeCases = suite("Edge Cases", async () => {
  const config = defaultConfig();
  const engine = new DistillerEngine(config, mockLog);
  engine.addRule(toolOutputTruncationRule);

  // Very long single line
  const longLine = "x".repeat(10000);
  const longResult = await engine.distill({
    content: longLine, category: "tool_output",
  });
  assert(longResult.distilled, "Very long single line is distilled");

  // Unicode edge cases
  const emoji = "🎉".repeat(500) + "\n".repeat(20) + "end";
  const emojiResult = await engine.distill({
    content: emoji, category: "tool_output",
  });
  // May or may not trigger depending on token count
  assert(typeof emojiResult.distilled === "boolean", "Emoji content handled without crash");

  // Empty content
  const emptyResult = await engine.distill({
    content: "", category: "tool_output",
  });
  assertEqual(emptyResult.distilled, false, "Empty content not distilled");

  // Config update
  const oldConfig = engine.getConfig();
  engine.updateConfig({ toolOutputMaxTokens: 2000 });
  const newConfig = engine.getConfig();
  assertEqual(newConfig.toolOutputMaxTokens, 2000, "Config update applied");
  assertEqual(oldConfig.toolOutputMaxTokens, 800, "Old config snapshot unchanged");
});

// ── 11. openclaw.json Validation ────────────────────────────────────────────

const testOpenclawConfig = suite("openclaw.json Configuration", async () => {
  // Read and validate the config
  const fs = await import("node:fs");
  const configPath = "/Users/gaoyuan/.openclaw/openclaw.json";

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const cfg = JSON.parse(raw);

    // Check plugins section
    assert(Array.isArray(cfg.plugins?.allow), "plugins.allow is array");
    assert(cfg.plugins.allow.includes("context-distiller"), "context-distiller in allow list");

    // Check entries
    const entry = cfg.plugins?.entries?.["context-distiller"];
    assert(entry != null, "context-distiller entry exists");
    assertEqual(entry?.enabled, true, "Entry enabled = true");
    assert(entry?.config != null, "Entry has config");
    assertEqual(entry?.config?.toolOutputMaxTokens, 800, "Config toolOutputMax = 800");
    assertEqual(entry?.config?.aggressiveness, "moderate", "Config aggressiveness = moderate");

    // Check installs
    const install = cfg.plugins?.installs?.["context-distiller"];
    assert(install != null, "context-distiller install record exists");
    assertEqual(install?.source, "path", "Install source = path");
    assert(install?.installPath?.includes("context-distiller"), "Install path correct");
  } catch (err) {
    assert(false, `Failed to read/parse openclaw.json: ${err}`);
  }
});

// ── 12. File Structure Validation ───────────────────────────────────────────

const testFileStructure = suite("File Structure Validation", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const base = "/Users/gaoyuan/.openclaw/extensions/context-distiller";

  const requiredFiles = [
    "package.json",
    "openclaw.plugin.json",
    "tsconfig.json",
    "index.ts",
    "src/types.ts",
    "src/config.ts",
    "src/tokens.ts",
    "src/distiller.ts",
    "src/rules/index.ts",
    "src/rules/tool-output.ts",
    "src/rules/patch-distill.ts",
    "src/rules/file-content.ts",
    "src/rules/repetition.ts",
  ];

  for (const file of requiredFiles) {
    const fullPath = path.join(base, file);
    const exists = fs.existsSync(fullPath);
    assert(exists, `File exists: ${file}`);
    if (exists) {
      const stat = fs.statSync(fullPath);
      assert(stat.size > 0, `File non-empty: ${file} (${stat.size} bytes)`);
    }
  }

  // Check symlink
  const nmPath = path.join(base, "node_modules");
  assert(fs.existsSync(nmPath), "node_modules symlink exists");
  const nmStat = fs.lstatSync(nmPath);
  assert(nmStat.isSymbolicLink(), "node_modules is a symlink");

  // Validate package.json
  const pkg = JSON.parse(fs.readFileSync(path.join(base, "package.json"), "utf-8"));
  assertEqual(pkg.name, "context-distiller", "package.json name correct");
  assertEqual(pkg.type, "module", "package.json type = module");
  assert(pkg.peerDependencies?.openclaw != null, "Has openclaw peer dep");

  // Validate openclaw.plugin.json
  const manifest = JSON.parse(fs.readFileSync(path.join(base, "openclaw.plugin.json"), "utf-8"));
  assertEqual(manifest.id, "context-distiller", "Manifest id correct");
  assert(manifest.configSchema != null, "Manifest has configSchema");
  assert(manifest.uiHints != null, "Manifest has uiHints");
});

// ══════════════════════════════════════════════════════════════════════════════
// RUN ALL
// ══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║    context-distiller — Automated Test Suite                  ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");

  const suites = [
    testTokens,
    testConfig,
    testClassify,
    testEngine,
    testRepetition,
    testToolOutput,
    testPatch,
    testFileContent,
    testIntegration,
    testEdgeCases,
    testOpenclawConfig,
    testFileStructure,
  ];

  for (const fn of suites) {
    try {
      await fn();
    } catch (err) {
      console.log(`    💥 Suite crashed: ${err instanceof Error ? err.message : String(err)}`);
      failures.push({ name: currentSuite, error: String(err) });
      failed++;
      totalTests++;
    }
  }

  console.log("\n" + "═".repeat(64));
  console.log(`  Results: ${passed} passed, ${failed} failed, ${totalTests} total`);

  if (failures.length > 0) {
    console.log("\n  Failed tests:");
    for (const f of failures) {
      console.log(`    ❌ ${f.name}`);
      console.log(`       ${f.error}`);
    }
  }

  console.log("═".repeat(64));

  if (failed > 0) {
    process.exit(1);
  } else {
    console.log("  ✅ All tests passed!");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(2);
});
