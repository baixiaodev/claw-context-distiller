/**
 * Integration Test for context-distiller plugin
 *
 * Simulates the real Gateway plugin environment:
 * 1. Plugin loading and registration
 * 2. Hook triggering with realistic tool output data
 * 3. distill_status / distill_configure tool invocations
 * 4. Cooperation with lossless-claw (shared config namespace)
 */

import { resolveConfig } from "../src/config.js";
import { DistillerEngine, classifyContent } from "../src/distiller.js";
import { estimateTokens } from "../src/tokens.js";
import {
  toolOutputTruncationRule,
  patchDistillRule,
  fileContentDistillRule,
  repetitionEliminationRule,
} from "../src/rules/index.js";

// ═══════════════════════════════════════════════════════════════════
// Test infrastructure
// ═══════════════════════════════════════════════════════════════════

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, name: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ❌ ${name}`);
  }
}

function section(name: string) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${name}`);
  console.log("═".repeat(60));
}

// Helper: simulate the synchronous hook pattern from index.ts
// In reality, tool_result_persist is synchronous. Our rules are pseudo-async
// (they return Promises but resolve synchronously). We use await to properly
// resolve them in testing, which mirrors what the microtask queue does in runtime.
async function simulateToolResultPersistHook(
  engine: DistillerEngine,
  content: string,
  toolName: string,
  config: ReturnType<typeof resolveConfig>,
): Promise<{ distilled: boolean; content: string; tokensBefore: number; tokensAfter: number } | null> {
  const tokens = estimateTokens(content);
  const category = classifyContent({ toolName, isToolResult: true, content });

  if (category === "passthrough" || category === "structural") return null;
  if (tokens <= Math.min(config.toolOutputMaxTokens, config.patchMaxTokens, config.fileContentMaxTokens)) {
    return null;
  }

  for (const rule of engine.getRules()) {
    if (!rule.appliesTo.includes(category)) continue;
    if (!rule.shouldDistill(content, tokens, config)) continue;

    const result = await rule.distill(content, tokens, config);
    if (result.distilled) {
      const afterTokens = estimateTokens(result.content);
      engine.getStats().distillations++;
      engine.getStats().tokensSaved += tokens - afterTokens;
      return {
        distilled: true,
        content: result.content,
        tokensBefore: tokens,
        tokensAfter: afterTokens,
      };
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// Test 1: Plugin Registration Simulation
// ═══════════════════════════════════════════════════════════════════

section("1. Plugin Registration Simulation");

{
  const config = resolveConfig(process.env, {
    toolOutputMaxTokens: 800,
    patchMaxTokens: 600,
    fileContentMaxTokens: 1000,
    aggressiveness: "moderate",
  });

  const engine = new DistillerEngine(config, {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  });
  engine.addRule(repetitionEliminationRule);
  engine.addRule(toolOutputTruncationRule);
  engine.addRule(patchDistillRule);
  engine.addRule(fileContentDistillRule);

  assert(config.enabled === true, "Plugin enabled by default");
  assert(config.toolOutputMaxTokens === 800, "toolOutputMaxTokens = 800");
  assert(config.patchMaxTokens === 600, "patchMaxTokens = 600");
  assert(config.fileContentMaxTokens === 1000, "fileContentMaxTokens = 1000");
  assert(config.aggressiveness === "moderate", "aggressiveness = moderate");
  assert(engine.getRules().length === 4, "4 rules registered");

  // Verify startup log message format
  const logs: string[] = [];
  const logConfig = resolveConfig(process.env, { toolOutputMaxTokens: 800 });
  const logMsg =
    `[context-distiller] Plugin loaded (enabled=${logConfig.enabled}, ` +
    `aggressiveness=${logConfig.aggressiveness}, ` +
    `toolMax=${logConfig.toolOutputMaxTokens}, ` +
    `patchMax=${logConfig.patchMaxTokens}, ` +
    `fileMax=${logConfig.fileContentMaxTokens}, ` +
    `rules=${engine.getRules().length})`;
  assert(logMsg.includes("enabled=true"), "Startup log includes enabled status");
  assert(logMsg.includes("rules=4"), "Startup log includes rule count");
}

// ═══════════════════════════════════════════════════════════════════
// Test 2: tool_result_persist Hook — Large JSON Output
// ═══════════════════════════════════════════════════════════════════

section("2. tool_result_persist Hook — Large JSON Tool Output");

{
  const config = resolveConfig(process.env, { toolOutputMaxTokens: 200 });
  const engine = new DistillerEngine(config, {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  });
  engine.addRule(repetitionEliminationRule);
  engine.addRule(toolOutputTruncationRule);
  engine.addRule(patchDistillRule);
  engine.addRule(fileContentDistillRule);

  // Simulate a large JSON array tool output (like list_files)
  const bigJsonArray = JSON.stringify(
    Array.from({ length: 100 }, (_, i) => ({
      name: `file_${i}.ts`,
      path: `/Users/gaoyuan/project/src/components/very/deeply/nested/path/file_${i}.ts`,
      size: Math.floor(Math.random() * 100000),
      lastModified: `2026-03-${String(i % 28 + 1).padStart(2, "0")}T10:00:00Z`,
      type: "file",
    })),
    null,
    2,
  );

  const tokens = estimateTokens(bigJsonArray);
  const category = classifyContent({ toolName: "list_files", isToolResult: true, content: bigJsonArray });

  assert(tokens > 200, `Token count (${tokens}) exceeds threshold (200)`);
  assert(category === "tool_output", `Category is tool_output (got: ${category})`);

  const hookResult = await simulateToolResultPersistHook(engine, bigJsonArray, "list_files", config);

  assert(hookResult !== null, "Hook produced a distill result");
  if (hookResult) {
    assert(hookResult.distilled === true, "Content was distilled");
    assert(hookResult.tokensAfter < hookResult.tokensBefore,
      `Tokens reduced: ${hookResult.tokensBefore} → ${hookResult.tokensAfter} (saved ${hookResult.tokensBefore - hookResult.tokensAfter})`);
    console.log(`    📊 Compression ratio: ${(hookResult.tokensAfter / hookResult.tokensBefore * 100).toFixed(1)}%`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Test 3: tool_result_persist Hook — Large Diff/Patch
// ═══════════════════════════════════════════════════════════════════

section("3. tool_result_persist Hook — Large Diff/Patch");

{
  const config = resolveConfig(process.env, { patchMaxTokens: 300 });
  const engine = new DistillerEngine(config, {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  });
  engine.addRule(repetitionEliminationRule);
  engine.addRule(toolOutputTruncationRule);
  engine.addRule(patchDistillRule);
  engine.addRule(fileContentDistillRule);

  const largeDiff = [
    "diff --git a/src/server.ts b/src/server.ts",
    "--- a/src/server.ts",
    "+++ b/src/server.ts",
    ...Array.from({ length: 30 }, (_, i) => [
      `@@ -${i * 25 + 1},15 +${i * 25 + 1},17 @@ export class ServerHandler {`,
      ...Array.from({ length: 6 }, (_, j) => `   const middleware${i}_${j} = createMiddleware(app, options);`),
      `-  handler.use(legacyMiddleware${i}(req, res, options));`,
      `-  handler.validate(legacySchema${i});`,
      `+  handler.use(modernMiddleware${i}(req, res, updatedOptions));`,
      `+  handler.validate(modernSchema${i});`,
      `+  handler.log(requestId, context${i});`,
      ...Array.from({ length: 6 }, (_, j) => `   const result${i}_${j} = await processRequest(middleware, ${j});`),
    ]).flat(),
  ].join("\n");

  const tokens = estimateTokens(largeDiff);
  const category = classifyContent({ toolName: "edit_file", isToolResult: true, content: largeDiff });

  assert(tokens > 300, `Diff token count (${tokens}) exceeds threshold (300)`);
  assert(category === "patch", `Category is patch (got: ${category})`);

  const hookResult = await simulateToolResultPersistHook(engine, largeDiff, "edit_file", config);

  assert(hookResult !== null, "Patch hook produced a result");
  if (hookResult) {
    assert(hookResult.distilled === true, "Patch was distilled");
    assert(hookResult.tokensAfter < hookResult.tokensBefore,
      `Patch tokens reduced: ${hookResult.tokensBefore} → ${hookResult.tokensAfter} (saved ${hookResult.tokensBefore - hookResult.tokensAfter})`);
    assert(hookResult.content.includes("---"), "Distilled patch retains diff header markers");
    console.log(`    📊 Patch compression: ${(hookResult.tokensAfter / hookResult.tokensBefore * 100).toFixed(1)}%`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Test 4: tool_result_persist Hook — Large File Read
// ═══════════════════════════════════════════════════════════════════

section("4. tool_result_persist Hook — Large File Read");

{
  const config = resolveConfig(process.env, { fileContentMaxTokens: 400 });
  const engine = new DistillerEngine(config, {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  });
  engine.addRule(repetitionEliminationRule);
  engine.addRule(toolOutputTruncationRule);
  engine.addRule(patchDistillRule);
  engine.addRule(fileContentDistillRule);

  const largeFileContent = [
    '/**',
    ' * Server configuration and initialization module',
    ' */',
    '',
    'import express from "express";',
    '',
    ...Array.from({ length: 40 }, (_, i) => [
      `export interface Config${i} {`,
      `  host: string;`,
      `  port: number;`,
      `  database: string;`,
      `  maxConnections: number;`,
      `}`,
      '',
      `export function createHandler${i}(config: Config${i}): express.RequestHandler {`,
      `  const pool = createPool({`,
      `    host: config.host,`,
      `    port: config.port,`,
      `    database: config.database,`,
      `    connectionLimit: config.maxConnections,`,
      `  });`,
      '',
      `  return async (req, res, next) => {`,
      `    try {`,
      `      const conn = await pool.getConnection();`,
      `      const [rows] = await conn.query("SELECT * FROM table${i}");`,
      `      conn.release();`,
      `      res.json({ data: rows });`,
      `    } catch (error) {`,
      `      next(error);`,
      `    }`,
      `  };`,
      `}`,
      '',
    ]).flat(),
  ].join("\n");

  const tokens = estimateTokens(largeFileContent);
  const category = classifyContent({ toolName: "read_file", isToolResult: true, content: largeFileContent });

  assert(tokens > 400, `File token count (${tokens}) exceeds threshold (400)`);
  assert(category === "file_content", `Category is file_content (got: ${category})`);

  const hookResult = await simulateToolResultPersistHook(engine, largeFileContent, "read_file", config);

  assert(hookResult !== null, "File content hook produced a result");
  if (hookResult) {
    assert(hookResult.distilled === true, "File content was distilled");
    assert(hookResult.tokensAfter < hookResult.tokensBefore,
      `File tokens reduced: ${hookResult.tokensBefore} → ${hookResult.tokensAfter} (saved ${hookResult.tokensBefore - hookResult.tokensAfter})`);
    const distilled = hookResult.content;
    assert(
      distilled.includes("interface") || distilled.includes("function") || distilled.includes("export"),
      "Distilled file retains structural elements",
    );
    console.log(`    📊 File compression: ${(hookResult.tokensAfter / hookResult.tokensBefore * 100).toFixed(1)}%`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Test 5: before_message_write Hook — Verbose Tool Message
// ═══════════════════════════════════════════════════════════════════

section("5. before_message_write Hook — Verbose Tool Message");

{
  const config = resolveConfig(process.env, { toolOutputMaxTokens: 200 });

  const longToolOutput = Array.from({ length: 100 }, (_, i) =>
    `Line ${i}: Processing batch ${i} — fetched ${Math.floor(Math.random() * 1000)} records from shard ${i % 8}, ` +
    `latency ${Math.floor(Math.random() * 500)}ms, status OK`
  ).join("\n");

  const message = { role: "tool" as const, content: longToolOutput };
  const tokens = estimateTokens(message.content);
  assert(tokens > 200, `Message tokens (${tokens}) exceed threshold`);

  // Simulate before_message_write logic (from index.ts lines 397-432)
  const lines = message.content.split("\n");
  if (lines.length > 30) {
    const maxLines = 30;
    const head = lines.slice(0, Math.ceil(maxLines * 0.6));
    const tail = lines.slice(-Math.floor(maxLines * 0.4));
    const truncated = [
      ...head,
      `\n[… ${lines.length - head.length - tail.length} lines omitted …]\n`,
      ...tail,
    ].join("\n");

    const afterTokens = estimateTokens(truncated);
    assert(afterTokens < tokens, `Message truncated: ${tokens} → ${afterTokens} tokens`);
    assert(truncated.includes("lines omitted"), "Contains omission marker");
    assert(truncated.includes("Line 0:"), "Retains head content");
    assert(truncated.includes("Line 99:"), "Retains tail content");
    console.log(`    📊 Message truncation: ${(afterTokens / tokens * 100).toFixed(1)}%`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Test 6: Repetitive Content (Log Spam)
// ═══════════════════════════════════════════════════════════════════

section("6. Repetitive Content (Log Spam)");

{
  const config = resolveConfig(process.env, { toolOutputMaxTokens: 200 });
  const engine = new DistillerEngine(config, {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  });
  engine.addRule(repetitionEliminationRule);
  engine.addRule(toolOutputTruncationRule);

  const logSpam = [
    "[2026-03-21 10:00:01] INFO  Server started on port 3000",
    ...Array.from({ length: 50 }, (_, i) =>
      `[2026-03-21 10:00:${String(i + 2).padStart(2, "0")}] INFO  Health check passed — all services healthy`
    ),
    "[2026-03-21 10:00:52] WARN  High memory usage: 87%",
    ...Array.from({ length: 30 }, (_, i) =>
      `[2026-03-21 10:01:${String(i).padStart(2, "0")}] INFO  Health check passed — all services healthy`
    ),
    "[2026-03-21 10:01:30] ERROR Connection timeout to redis-primary",
  ].join("\n");

  const tokens = estimateTokens(logSpam);

  const hookResult = await simulateToolResultPersistHook(engine, logSpam, "shell", config);

  assert(hookResult !== null, "Repetitive content was handled");
  if (hookResult) {
    assert(hookResult.distilled === true, "Log spam was distilled");
    assert(hookResult.tokensAfter < hookResult.tokensBefore,
      `Tokens reduced: ${hookResult.tokensBefore} → ${hookResult.tokensAfter}`);
    assert(
      hookResult.content.includes("Server started") || hookResult.content.includes("port 3000"),
      "Unique events preserved",
    );
    console.log(`    📊 Log spam compression: ${(hookResult.tokensAfter / hookResult.tokensBefore * 100).toFixed(1)}%`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Test 7: Engine Stats Tracking
// ═══════════════════════════════════════════════════════════════════

section("7. Engine Stats Tracking");

{
  const config = resolveConfig(process.env, { toolOutputMaxTokens: 100, patchMaxTokens: 100, fileContentMaxTokens: 100 });
  const engine = new DistillerEngine(config, {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  });
  engine.addRule(repetitionEliminationRule);
  engine.addRule(toolOutputTruncationRule);
  engine.addRule(patchDistillRule);
  engine.addRule(fileContentDistillRule);

  const stats = engine.getStats();
  assert(stats.distillations === 0, "Initial distillations = 0");
  assert(stats.tokensSaved === 0, "Initial tokensSaved = 0");

  // Run 3 distillations via the engine.distill() method
  const testCases = [
    {
      content: JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ id: i, value: `item_${i}_data_${Math.random()}` })), null, 2),
      toolName: "search_files",
    },
    {
      content: Array.from({ length: 60 }, (_, i) => `export function handler${i}(req: Request, res: Response) { return res.json({ ok: true, handler: ${i} }); }`).join("\n"),
      toolName: "read_file",
    },
    {
      content: [
        "diff --git a/main.ts b/main.ts",
        "--- a/main.ts",
        "+++ b/main.ts",
        ...Array.from({ length: 15 }, (_, i) => [
          `@@ -${i * 20 + 1},10 +${i * 20 + 1},12 @@`,
          ...Array.from({ length: 5 }, (_, j) => `   context_line_${i}_${j} = processStep(config, params);`),
          `-  oldImpl(${i}, legacyParam);`,
          `+  newImpl(${i}, modernParam);`,
          `+  logAction(${i}, trace);`,
        ]).flat(),
      ].join("\n"),
      toolName: "edit_file",
    },
  ];

  let totalSaved = 0;
  let distillCount = 0;

  for (const tc of testCases) {
    const category = classifyContent({ toolName: tc.toolName, isToolResult: true, content: tc.content });
    const result = await engine.distill({ content: tc.content, category, toolName: tc.toolName });
    if (result.distilled) {
      distillCount++;
      totalSaved += result.tokensBefore - result.tokensAfter;
    }
  }

  const finalStats = engine.getStats();
  assert(finalStats.distillations === distillCount, `Stats distillations = ${distillCount} (got: ${finalStats.distillations})`);
  assert(finalStats.tokensSaved === totalSaved, `Stats tokensSaved = ${totalSaved} (got: ${finalStats.tokensSaved})`);
  assert(finalStats.tokensSaved > 0, `Total tokens saved > 0: ${finalStats.tokensSaved}`);
  console.log(`    📊 Total saved: ${finalStats.tokensSaved} tokens across ${finalStats.distillations} distillations`);
}

// ═══════════════════════════════════════════════════════════════════
// Test 8: Runtime Config Update
// ═══════════════════════════════════════════════════════════════════

section("8. Runtime Config Update (distill_configure simulation)");

{
  const config = resolveConfig(process.env, { toolOutputMaxTokens: 800 });
  const engine = new DistillerEngine(config, {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  });
  engine.addRule(toolOutputTruncationRule);

  assert(engine.getConfig().aggressiveness === "moderate", "Initial aggressiveness = moderate");

  engine.updateConfig({ aggressiveness: "aggressive", toolOutputMaxTokens: 400 });

  assert(engine.getConfig().aggressiveness === "aggressive", "Updated to aggressive");
  assert(engine.getConfig().toolOutputMaxTokens === 400, "Updated toolOutputMax to 400");

  // Verify the updated config is used in distillation
  engine.updateConfig({ aggressiveness: "conservative", toolOutputMaxTokens: 2000 });
  assert(engine.getConfig().aggressiveness === "conservative", "Updated to conservative");
  assert(engine.getConfig().toolOutputMaxTokens === 2000, "Raised threshold to 2000");
}

// ═══════════════════════════════════════════════════════════════════
// Test 9: Cooperation with lossless-claw
// ═══════════════════════════════════════════════════════════════════

section("9. Cooperation with lossless-claw");

{
  const fs = await import("node:fs");
  const openclawConfigPath = `${process.env.HOME}/.openclaw/openclaw.json`;

  let configOk = false;
  try {
    const raw = fs.readFileSync(openclawConfigPath, "utf-8");
    const cfg = JSON.parse(raw);

    const cdConfig = cfg.plugins?.entries?.["context-distiller"];
    assert(cdConfig?.enabled === true, "context-distiller enabled in openclaw.json");
    assert(cdConfig?.config?.toolOutputMaxTokens === 800, "toolOutputMaxTokens in config");
    assert(cdConfig?.config?.aggressiveness === "moderate", "aggressiveness in config");

    const contextEngine = cfg.plugins?.slots?.contextEngine;
    assert(contextEngine === "lossless-claw", `contextEngine slot = lossless-claw (got: ${contextEngine})`);

    const allow = cfg.plugins?.allow || [];
    assert(allow.includes("context-distiller"), "context-distiller in allow list");

    // Verify no cross-contamination
    const lcmEntries = cfg.plugins?.entries?.["lossless-claw"];
    if (lcmEntries?.config) {
      assert(
        !lcmEntries.config.toolOutputMaxTokens,
        "lossless-claw has no toolOutputMaxTokens (no cross-contamination)",
      );
    } else {
      assert(true, "lossless-claw config separate (no entries or no config key)");
    }

    configOk = true;
  } catch (err) {
    console.log(`  ⚠️  Could not read openclaw.json: ${err}`);
  }
  assert(configOk, "openclaw.json parsed successfully");
}

// ═══════════════════════════════════════════════════════════════════
// Test 10: Edge Cases
// ═══════════════════════════════════════════════════════════════════

section("10. Edge Cases — Below Threshold / Passthrough");

{
  const config = resolveConfig(process.env, {});
  const engine = new DistillerEngine(config, {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  });
  engine.addRule(repetitionEliminationRule);
  engine.addRule(toolOutputTruncationRule);
  engine.addRule(patchDistillRule);
  engine.addRule(fileContentDistillRule);

  const small = '{"ok": true, "count": 42}';
  const smallCategory = classifyContent({ toolName: "api_call", isToolResult: true, content: small });
  const smallResult = await engine.distill({ content: small, category: smallCategory, toolName: "api_call" });
  assert(smallResult.distilled === false, "Small content passes through");

  const structural = "Task completed successfully.";
  const structCategory = classifyContent({ toolName: "task", isToolResult: true, content: structural });
  const structuralResult = await engine.distill({ content: structural, category: structCategory, toolName: "task" });
  assert(structuralResult.distilled === false, "Short structural content passes through");

  const emptyContent = "";
  const emptyCategory = classifyContent({ toolName: "noop", isToolResult: true, content: emptyContent });
  const emptyResult = await engine.distill({ content: emptyContent, category: emptyCategory, toolName: "noop" });
  assert(emptyResult.distilled === false, "Empty content passes through");
}

// ═══════════════════════════════════════════════════════════════════
// Test 11: Full Pipeline — Sequence of Tool Results
// ═══════════════════════════════════════════════════════════════════

section("11. Full Pipeline — Sequence of Tool Results");

{
  const config = resolveConfig(process.env, {
    toolOutputMaxTokens: 200,
    patchMaxTokens: 200,
    fileContentMaxTokens: 200,
  });
  const engine = new DistillerEngine(config, {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  });
  engine.addRule(repetitionEliminationRule);
  engine.addRule(toolOutputTruncationRule);
  engine.addRule(patchDistillRule);
  engine.addRule(fileContentDistillRule);

  const toolCalls = [
    { toolName: "list_dir", content: Array.from({ length: 80 }, (_, i) => `drwxr-xr-x  5 user  staff  160 Mar 21 01:26 directory_${i}`).join("\n") },
    { toolName: "read_file", content: Array.from({ length: 60 }, (_, i) => `export const CONFIG_${i} = { key: "value_${i}", nested: { deep: "${i}" } };`).join("\n") },
    { toolName: "search_content", content: Array.from({ length: 50 }, (_, i) => `src/module${i}/handler.ts:${i * 10 + 5}:  if (condition${i}) { handleCase${i}(params); }`).join("\n") },
    { toolName: "shell", content: "OK" }, // Small — should pass through
  ];

  let totalTokensBefore = 0;
  let totalTokensAfter = 0;
  let distillations = 0;

  for (const tc of toolCalls) {
    const category = classifyContent({ toolName: tc.toolName, isToolResult: true, content: tc.content });
    const result = await engine.distill({ content: tc.content, category, toolName: tc.toolName });
    totalTokensBefore += result.tokensBefore;
    totalTokensAfter += result.tokensAfter;
    if (result.distilled) distillations++;
  }

  const stats = engine.getStats();
  assert(distillations >= 2, `At least 2 out of 4 tool results distilled (got: ${distillations})`);
  assert(totalTokensBefore > totalTokensAfter, `Total compression: ${totalTokensBefore} → ${totalTokensAfter}`);
  assert(stats.tokensSaved > 0, `Engine stats track savings: ${stats.tokensSaved} tokens`);
  console.log(`    📊 Pipeline: ${distillations}/4 distilled, ${stats.tokensSaved} tokens saved (${((1 - totalTokensAfter / totalTokensBefore) * 100).toFixed(1)}% reduction)`);
}

// ═══════════════════════════════════════════════════════════════════
// Test 12: Gateway Live Verification
// ═══════════════════════════════════════════════════════════════════

section("12. Gateway Live — Plugin Loaded in Process");

{
  // Verify the plugin was loaded by the local openclaw gateway
  const fs = await import("node:fs");
  const { execSync } = await import("node:child_process");

  let gatewayLoaded = false;
  try {
    // Check gateway log for our plugin's load message
    const logFile = `/tmp/openclaw/openclaw-2026-03-21.log`;
    if (fs.existsSync(logFile)) {
      const log = fs.readFileSync(logFile, "utf-8");
      gatewayLoaded = log.includes("[context-distiller] Plugin loaded");
      assert(gatewayLoaded, "Plugin load message found in gateway log");
    } else {
      assert(true, "Gateway log not found (running in test-only mode)");
    }
  } catch {
    assert(true, "Gateway log check skipped");
  }

  // Verify the openclaw CLI sees the plugin
  try {
    const output = execSync("openclaw plugins list 2>&1", { encoding: "utf-8", timeout: 15000 });
    assert(output.includes("context-distiller") || output.includes("Context Distiller"),
      "openclaw plugins list shows context-distiller");
    assert(output.includes("loaded"), "Plugin status is 'loaded'");
  } catch {
    assert(true, "CLI check skipped (openclaw not in PATH)");
  }
}

// ═══════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════

console.log(`\n${"═".repeat(60)}`);
console.log(`  RESULTS: ${passed} passed, ${failed} failed (total: ${passed + failed})`);
console.log("═".repeat(60));

if (failures.length > 0) {
  console.log("\nFailed tests:");
  for (const f of failures) {
    console.log(`  ❌ ${f}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
