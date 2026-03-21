#!/usr/bin/env tsx
/**
 * E2E Real-World Test Suite for context-distiller
 *
 * Simulates 10 real-world OpenClaw usage scenarios (simple → complex),
 * feeding actual tool outputs through the distillation pipeline.
 *
 * Each test captures a tool result that would normally flow through
 * tool_result_persist hook, runs it through DistillerEngine, and
 * validates the distillation behavior.
 */

import { execSync } from "child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { resolveConfig } from "../src/config.js";
import { DistillerEngine, classifyContent } from "../src/distiller.js";
import { estimateTokens } from "../src/tokens.js";
import {
  toolOutputTruncationRule,
  patchDistillRule,
  fileContentDistillRule,
  repetitionEliminationRule,
} from "../src/rules/index.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

interface TestResult {
  id: number;
  name: string;
  passed: boolean;
  tokensBefore: number;
  tokensAfter: number;
  distilled: boolean;
  ratio: string;
  details: string;
  error?: string;
}

const results: TestResult[] = [];
let engine: DistillerEngine;

function createEngine(configOverrides?: Record<string, unknown>): DistillerEngine {
  const config = resolveConfig(process.env, configOverrides);
  const log = {
    info: (_msg: string) => {},
    warn: (msg: string) => console.log(`  ${YELLOW}WARN: ${msg}${RESET}`),
    error: (msg: string) => console.log(`  ${RED}ERROR: ${msg}${RESET}`),
    debug: (_msg: string) => {},
  };
  const e = new DistillerEngine(config, log);
  e.addRule(repetitionEliminationRule);
  e.addRule(toolOutputTruncationRule);
  e.addRule(patchDistillRule);
  e.addRule(fileContentDistillRule);
  return e;
}

function shell(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });
  } catch (err: any) {
    return err.stdout?.toString() ?? err.message ?? "command failed";
  }
}

async function runDistill(
  content: string,
  toolName: string,
): Promise<{ distilled: boolean; content: string; tokensBefore: number; tokensAfter: number }> {
  const category = classifyContent({ toolName, isToolResult: true, content });
  return engine.distill({ content, category, toolName });
}

function report(r: TestResult) {
  const icon = r.passed ? `${GREEN}✅${RESET}` : `${RED}❌${RESET}`;
  const distLabel = r.distilled
    ? `${CYAN}${r.tokensBefore}→${r.tokensAfter} tokens (${r.ratio})${RESET}`
    : `${DIM}passthrough (${r.tokensBefore} tokens)${RESET}`;
  console.log(`${icon} E2E-${r.id} ${BOLD}${r.name}${RESET}`);
  console.log(`   ${distLabel}`);
  console.log(`   ${DIM}${r.details}${RESET}`);
  if (r.error) console.log(`   ${RED}${r.error}${RESET}`);
  console.log();
}

// ── Tests ────────────────────────────────────────────────────────────────────

async function test1_distillStatus() {
  // Scenario: User asks agent to check distiller status — the distill_status
  // tool returns a formatted markdown report. This is a small structural output
  // that should NOT be distilled.
  const statusOutput = [
    "## Context Distiller Status",
    "",
    "### Statistics",
    "- Messages processed: 0",
    "- Distillations performed: 0",
    "- Tokens saved: 0",
    "- Average compression ratio: 1.00",
    "- Last distillation: never",
    "",
    "### Configuration",
    "- Enabled: true",
    "- Aggressiveness: moderate",
    "- Tool output max tokens: 800",
    "- Patch max tokens: 600",
    "- File content max tokens: 1000",
  ].join("\n");

  const result = await runDistill(statusOutput, "distill_status");
  const passed = !result.distilled; // Small output should pass through
  results.push({
    id: 1,
    name: "distill_status 输出 passthrough",
    passed,
    tokensBefore: result.tokensBefore,
    tokensAfter: result.tokensAfter,
    distilled: result.distilled,
    ratio: result.distilled ? `${((result.tokensAfter / result.tokensBefore) * 100).toFixed(1)}%` : "100%",
    details: "Small tool output should not be distilled",
  });
}

async function test2_shortShellCommand() {
  // Scenario: User asks to run `date && whoami` — tiny output, should passthrough
  const shellOutput = shell("echo 'Hello World' && date && whoami");
  const result = await runDistill(shellOutput, "execute_command");
  const passed = !result.distilled;
  results.push({
    id: 2,
    name: "短 shell 命令输出 passthrough",
    passed,
    tokensBefore: result.tokensBefore,
    tokensAfter: result.tokensAfter,
    distilled: result.distilled,
    ratio: "100%",
    details: `Output: ${shellOutput.trim().substring(0, 80)}...`,
  });
}

async function test3_readLargeFile() {
  // Scenario: User asks agent to read a large TypeScript file (engine.ts, 1851 lines)
  const filePath = "/Users/gaoyuan/.openclaw/extensions/lossless-claw/src/engine.ts";
  if (!existsSync(filePath)) {
    results.push({ id: 3, name: "读取大文件 (engine.ts)", passed: false,
      tokensBefore: 0, tokensAfter: 0, distilled: false, ratio: "N/A",
      details: "File not found", error: `${filePath} does not exist` });
    return;
  }

  const content = readFileSync(filePath, "utf-8");
  const result = await runDistill(content, "read_file");
  const passed = result.distilled && result.tokensAfter < result.tokensBefore;
  results.push({
    id: 3,
    name: "读取大文件 (engine.ts, 1851行)",
    passed,
    tokensBefore: result.tokensBefore,
    tokensAfter: result.tokensAfter,
    distilled: result.distilled,
    ratio: result.distilled ? `${((result.tokensAfter / result.tokensBefore) * 100).toFixed(1)}%` : "100%",
    details: `File: ${filePath} (${content.split("\n").length} lines)`,
  });
}

async function test4_diffPatch() {
  // Scenario: User makes code changes, agent shows diff output
  const diffOutput = `diff --git a/src/engine.ts b/src/engine.ts
index abc1234..def5678 100644
--- a/src/engine.ts
+++ b/src/engine.ts
@@ -42,15 +42,20 @@ export class LcmContextEngine {
   private config: LcmConfig;
   private conversationStore: ConversationStore;
   private summaryStore: SummaryStore;
+  private distillerEngine?: DistillerEngine;
   private assembler: ContextAssembler;
   private compaction: CompactionEngine;
   private retrieval: RetrievalEngine;
 
   constructor(deps: LcmDependencies) {
     this.config = deps.config;
     this.conversationStore = new ConversationStore(deps.db, deps.config);
     this.summaryStore = new SummaryStore(deps.db, deps.config);
+    this.distillerEngine = deps.distillerEngine;
     this.assembler = new ContextAssembler(this.config);
     this.compaction = new CompactionEngine(this.config, this.summaryStore);
     this.retrieval = new RetrievalEngine(deps.db, this.config);
+    if (this.distillerEngine) {
+      this.log.info("[lcm] DistillerEngine integration enabled");
+    }
   }
 
@@ -120,6 +125,15 @@ export class LcmContextEngine {
   async ingest(params: IngestParams): Promise<void> {
     const { sessionId, message } = params;
     await this.ensureMigrated();
+
+    // Apply distillation before ingestion
+    if (this.distillerEngine && message.role === "tool") {
+      const content = extractTextContent(message.content);
+      if (content.length > 500) {
+        const distilled = await this.distillerEngine.distill({ content, category: "tool_output" });
+        if (distilled.distilled) {
+          message.content = distilled.content;
+          this.log.info(\`[lcm] Distilled tool result: \${distilled.tokensBefore} → \${distilled.tokensAfter} tokens\`);
+        }
+      }
+    }
 
     const conversation = await this.getOrCreateConversation(sessionId);
@@ -200,8 +214,10 @@ export class LcmContextEngine {
   async compact(params: CompactParams): Promise<CompactResult> {
     const { sessionId, target } = params;
-    const summarize = await this.resolveSummarize();
+    const summarize = await this.resolveSummarize({
+      distillerEngine: this.distillerEngine,
+    });
     return this.compaction.compact({
       conversationId: await this.getConversationId(sessionId),
       target,
@@ -250,6 +266,12 @@ export class LcmContextEngine {
     return this.retrieval;
   }
 
+  getDistillerStats(): DistillerStats | undefined {
+    return this.distillerEngine?.getStats();
+  }
+
+  updateDistillerConfig(patch: Partial<DistillerConfig>): void {
+    this.distillerEngine?.updateConfig(patch);
+  }
+
   dispose(): void {
     // DB connections are shared; do not close here
   }
`;

  const result = await runDistill(diffOutput, "replace_in_file");
  const passed = result.distilled && result.tokensAfter < result.tokensBefore;
  results.push({
    id: 4,
    name: "Diff/Patch 蒸馏 (代码修改场景)",
    passed,
    tokensBefore: result.tokensBefore,
    tokensAfter: result.tokensAfter,
    distilled: result.distilled,
    ratio: result.distilled ? `${((result.tokensAfter / result.tokensBefore) * 100).toFixed(1)}%` : "100%",
    details: `Diff with 4 hunks, ${diffOutput.split("\n").length} lines`,
  });
}

async function test5_largeJsonApi() {
  // Scenario: Agent calls an API that returns a large JSON array (e.g., npm search, package list)
  const jsonOutput = shell("cat /Users/gaoyuan/.npm-global/lib/node_modules/openclaw/package.json");
  if (jsonOutput.length < 500) {
    // Generate a synthetic large JSON array as fallback
    const items = Array.from({ length: 200 }, (_, i) => ({
      id: i + 1,
      name: `package-${i + 1}`,
      version: `${Math.floor(Math.random() * 10)}.${Math.floor(Math.random() * 20)}.${Math.floor(Math.random() * 50)}`,
      description: `A comprehensive Node.js package for ${["web development", "data processing", "API integration", "testing", "deployment"][i % 5]} with advanced ${["caching", "logging", "monitoring", "profiling", "debugging"][i % 5]} capabilities`,
      author: `dev-${i % 20}@example.com`,
      license: ["MIT", "Apache-2.0", "ISC", "BSD-3-Clause"][i % 4],
      dependencies: Object.fromEntries(
        Array.from({ length: 5 + (i % 10) }, (_, j) => [`dep-${j}`, `^${j + 1}.0.0`])
      ),
      devDependencies: Object.fromEntries(
        Array.from({ length: 3 + (i % 5) }, (_, j) => [`dev-dep-${j}`, `^${j + 1}.0.0`])
      ),
      keywords: Array.from({ length: 3 + (i % 4) }, (_, j) => `keyword-${j}`),
      repository: { type: "git", url: `https://github.com/example/package-${i + 1}.git` },
      createdAt: new Date(2024, i % 12, (i % 28) + 1).toISOString(),
      updatedAt: new Date(2026, 2, 21).toISOString(),
    }));
    const content = JSON.stringify(items, null, 2);
    const result = await runDistill(content, "api_call");
    const passed = result.distilled && result.tokensAfter < result.tokensBefore;
    results.push({
      id: 5,
      name: "大型 JSON API 响应蒸馏",
      passed,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      distilled: result.distilled,
      ratio: result.distilled ? `${((result.tokensAfter / result.tokensBefore) * 100).toFixed(1)}%` : "100%",
      details: `Synthetic JSON array, 200 items, ${content.length} chars`,
    });
  } else {
    const result = await runDistill(jsonOutput, "api_call");
    const passed = result.distilled && result.tokensAfter < result.tokensBefore;
    results.push({
      id: 5,
      name: "大型 JSON API 响应蒸馏 (package.json)",
      passed,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      distilled: result.distilled,
      ratio: result.distilled ? `${((result.tokensAfter / result.tokensBefore) * 100).toFixed(1)}%` : "100%",
      details: `Real package.json, ${jsonOutput.split("\n").length} lines, ${jsonOutput.length} chars`,
    });
  }
}

async function test6_repetitiveLogs() {
  // Scenario: Agent tails a log file with many repetitive entries
  const logEntries: string[] = [];
  const timestamps = Array.from({ length: 200 }, (_, i) =>
    `2026-03-21T11:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.${String(Math.floor(Math.random() * 999)).padStart(3, "0")}+08:00`
  );

  for (let i = 0; i < 200; i++) {
    const level = i % 20 === 0 ? "ERROR" : i % 5 === 0 ? "WARN" : "INFO";
    const messages = [
      `[gateway] Health check passed, uptime=34521s, memory=128MB, connections=42`,
      `[gateway] Health check passed, uptime=34522s, memory=128MB, connections=42`,
      `[gateway] Health check passed, uptime=34523s, memory=129MB, connections=43`,
      `[gateway] Health check passed, uptime=34524s, memory=128MB, connections=41`,
      `[gateway] Health check passed, uptime=34525s, memory=130MB, connections=42`,
      `[plugins] [lcm] Compaction check: below threshold (fresh=12, limit=50)`,
      `[plugins] [lcm] Compaction check: below threshold (fresh=13, limit=50)`,
      `[plugins] [lcm] Compaction check: below threshold (fresh=14, limit=50)`,
      `[plugins] hybrid-memory: collected 3 hybrid-search results`,
      `[plugins] hybrid-memory: collected 4 hybrid-search results`,
      `[session] Message persisted (session=main, role=user, tokens=42)`,
      `[session] Message persisted (session=main, role=assistant, tokens=350)`,
      `[session] Message persisted (session=main, role=tool, tokens=1200)`,
      `[ws] Ping received from client 127.0.0.1:52431`,
      `[ws] Pong sent to client 127.0.0.1:52431`,
    ];
    logEntries.push(`${timestamps[i]} ${level} ${messages[i % messages.length]}`);
  }

  // Add some unique error entries
  logEntries.splice(50, 0, `${timestamps[50]} ERROR [telegram] Connection failed: ETIMEDOUT 149.154.167.220:443`);
  logEntries.splice(100, 0, `${timestamps[100]} ERROR [model] API rate limit exceeded, retrying in 30s`);
  logEntries.splice(150, 0, `${timestamps[150]} WARN [lcm] Database WAL size exceeds 10MB, checkpointing`);

  const content = logEntries.join("\n");
  const result = await runDistill(content, "execute_command");
  const passed = result.distilled && result.tokensAfter < result.tokensBefore * 0.5; // Expect > 50% reduction
  results.push({
    id: 6,
    name: "重复日志分析 — repetition 消除",
    passed,
    tokensBefore: result.tokensBefore,
    tokensAfter: result.tokensAfter,
    distilled: result.distilled,
    ratio: result.distilled ? `${((result.tokensAfter / result.tokensBefore) * 100).toFixed(1)}%` : "100%",
    details: `${logEntries.length} log lines, ${content.length} chars`,
  });
}

async function test7_runtimeConfigChange() {
  // Scenario: User asks to switch to aggressive mode and lower thresholds
  // Create content that is BELOW moderate threshold (800) but ABOVE aggressive threshold (200)
  const mediumContent = Array.from({ length: 15 }, (_, i) =>
    `Line ${i + 1}: Config entry key_${i}="${"val_".repeat(3)}${i}"`
  ).join("\n");

  const tokens = estimateTokens(mediumContent);
  // Ensure content is within the right range: < 800 tokens for moderate passthrough
  // but would be > 200 * 0.6 = 120 for aggressive mode

  // First: conservative mode with high threshold — should NOT distill
  engine.updateConfig({
    aggressiveness: "conservative" as any,
    toolOutputMaxTokens: 2000,
  });

  const beforeResult = await engine.distill({
    content: mediumContent,
    category: "tool_output",
    toolName: "execute_command",
  });

  // Switch to aggressive mode with very low thresholds
  engine.updateConfig({
    aggressiveness: "aggressive" as any,
    toolOutputMaxTokens: 100,
  });

  const afterResult = await engine.distill({
    content: mediumContent,
    category: "tool_output",
    toolName: "execute_command",
  });

  // Reset config
  engine.updateConfig({
    aggressiveness: "moderate" as any,
    toolOutputMaxTokens: 800,
  });

  const passed = !beforeResult.distilled && afterResult.distilled;
  results.push({
    id: 7,
    name: "运行时配置调整 (conservative→aggressive)",
    passed,
    tokensBefore: afterResult.tokensBefore,
    tokensAfter: afterResult.tokensAfter,
    distilled: afterResult.distilled,
    ratio: afterResult.distilled ? `${((afterResult.tokensAfter / afterResult.tokensBefore) * 100).toFixed(1)}%` : "100%",
    details: `Content: ${tokens} tokens. Conservative(2000): pass=${!beforeResult.distilled}, Aggressive(100): distill=${afterResult.distilled}`,
  });
}

async function test8_multiToolPipeline() {
  // Scenario: Complex multi-tool task — user asks agent to:
  // 1. List a directory (produces file listing)
  // 2. Read a config file (produces file content)
  // 3. Make edits (produces diff)
  // 4. Check results (produces command output)
  // Simulate all 4 tool results flowing through the distiller

  const tools: Array<{ name: string; content: string; label: string }> = [];

  // Tool 1: Directory listing
  const dirListing = shell("find /Users/gaoyuan/.openclaw/extensions -maxdepth 3 -type f 2>/dev/null | head -100");
  tools.push({ name: "execute_command", content: dirListing, label: "Directory listing" });

  // Tool 2: Large config file read
  const configContent = readFileSync("/Users/gaoyuan/.openclaw/openclaw.json", "utf-8");
  tools.push({ name: "read_file", content: configContent, label: "Config file read" });

  // Tool 3: Simulated multi-file edit diff
  const editDiff = `diff --git a/config.ts b/config.ts
--- a/config.ts
+++ b/config.ts
@@ -1,5 +1,8 @@
 import { DistillerConfig } from "./types.js";
 
+// Added: support for custom rule registration
+import { DistillRule } from "./types.js";
+
 const AGGRESSIVENESS_MULTIPLIERS = {
   conservative: 1.5,
   moderate: 1.0,
@@ -15,6 +18,12 @@ export function resolveConfig(
   env: NodeJS.ProcessEnv,
   pluginConfig?: Record<string, unknown>,
 ): DistillerConfig {
+  // Parse custom rules from environment
+  const customRulesStr = env.CONTEXT_DISTILLER_CUSTOM_RULES;
+  const customRules: DistillRule[] = customRulesStr
+    ? JSON.parse(customRulesStr)
+    : [];
+
   return {
     enabled: env.CONTEXT_DISTILLER_ENABLED !== "false" &&
       (pluginConfig?.enabled ?? true) !== false,
diff --git a/distiller.ts b/distiller.ts
--- a/distiller.ts
+++ b/distiller.ts
@@ -87,6 +87,15 @@ export class DistillerEngine {
     this.rules.sort((a, b) => a.priority - b.priority);
     this.log.debug(\`[distiller] Registered rule: \${rule.id} (priority=\${rule.priority})\`);
   }
+
+  /**
+   * Remove a rule by ID.
+   */
+  removeRule(ruleId: string): boolean {
+    const idx = this.rules.findIndex(r => r.id === ruleId);
+    if (idx === -1) return false;
+    this.rules.splice(idx, 1);
+    return true;
+  }
 
   /**
    * Get all registered rules.`;
  tools.push({ name: "edit_file", content: editDiff, label: "Multi-file edit diff" });

  // Tool 4: Test output
  const testOutput = shell("cd /Users/gaoyuan/.openclaw/extensions/context-distiller && cat package.json");
  tools.push({ name: "execute_command", content: testOutput, label: "Test results" });

  let totalBefore = 0;
  let totalAfter = 0;
  let distillCount = 0;
  const toolDetails: string[] = [];

  for (const tool of tools) {
    const category = classifyContent({ toolName: tool.name, isToolResult: true, content: tool.content });
    const r = await engine.distill({ content: tool.content, category, toolName: tool.name });
    totalBefore += r.tokensBefore;
    totalAfter += r.tokensAfter;
    if (r.distilled) distillCount++;
    toolDetails.push(`${tool.label}: ${r.tokensBefore}→${r.tokensAfter} (${r.distilled ? "distilled" : "passthrough"})`);
  }

  const passed = distillCount >= 2; // At least 2 of 4 tools should trigger distillation
  results.push({
    id: 8,
    name: "连续多工具调用 — 复合任务全管道",
    passed,
    tokensBefore: totalBefore,
    tokensAfter: totalAfter,
    distilled: distillCount > 0,
    ratio: `${((totalAfter / totalBefore) * 100).toFixed(1)}%`,
    details: `${distillCount}/${tools.length} tools distilled. ${toolDetails.join("; ")}`,
  });
}

async function test9_massiveDirectoryTraversal() {
  // Scenario: User asks agent to find all TypeScript files in the entire openclaw installation
  const content = shell(
    "find /Users/gaoyuan/.npm-global/lib/node_modules/openclaw -name '*.ts' -o -name '*.js' -o -name '*.d.ts' 2>/dev/null | head -500"
  );

  const result = await runDistill(content, "execute_command");
  const passed = result.distilled && result.tokensAfter < result.tokensBefore;
  results.push({
    id: 9,
    name: "大规模目录遍历 — 极端数据量",
    passed,
    tokensBefore: result.tokensBefore,
    tokensAfter: result.tokensAfter,
    distilled: result.distilled,
    ratio: result.distilled ? `${((result.tokensAfter / result.tokensBefore) * 100).toFixed(1)}%` : "100%",
    details: `find output: ${content.split("\n").length} lines, ${content.length} chars`,
  });
}

async function test10_cjkContent() {
  // Scenario: Agent reads a Chinese documentation file or processes Chinese log output
  const cjkContent = [
    "# OpenClaw 上下文蒸馏器 — 技术设计文档",
    "",
    "## 一、项目背景",
    "随着大语言模型（LLM）在企业级应用中的广泛采用，上下文窗口管理成为核心挑战。",
    "OpenClaw 作为开源的 AI Agent 框架，其核心组件 Lossless Context Management (LCM) 引擎",
    "通过 DAG 结构化的摘要系统实现了上下文的无损管理。然而，在实际使用中，工具调用",
    "（如文件读取、API 响应、命令输出）产生的大量原始数据在进入 LCM 之前并未经过优化，",
    "导致上下文窗口被低信息密度的内容占据。",
    "",
    "## 二、核心架构",
    "",
    "### 2.1 蒸馏引擎 (DistillerEngine)",
    "蒸馏引擎是插件的核心组件，负责协调各蒸馏规则的执行。它采用优先级排序的规则链设计：",
    "",
    "```typescript",
    "export class DistillerEngine {",
    "  private rules: DistillRule[] = [];",
    "  private stats: DistillStats;",
    "  ",
    "  async distill(params: { content: string; category: PartCategory }): Promise<DistillResult> {",
    "    // 按优先级遍历规则，第一个匹配的规则执行蒸馏",
    "    for (const rule of this.rules) {",
    "      if (rule.appliesTo.includes(category) && rule.shouldDistill(content, tokens, config)) {",
    "        return await rule.distill(content, tokens, config);",
    "      }",
    "    }",
    "  }",
    "}",
    "```",
    "",
    "### 2.2 蒸馏规则体系",
    "",
    "| 规则 ID | 优先级 | 适用类别 | 功能描述 |",
    "|---------|--------|----------|----------|",
    "| repetition-elimination | P5 | 全部 | 检测重复行、块模式，消除冗余 |",
    "| tool-output-truncation | P10 | tool_output | JSON 摘要/文件列表检测/头尾截断 |",
    "| patch-distill | P10 | patch | 保留变更行 + 最少上下文行 |",
    "| file-content-distill | P10 | file_content | 代码结构提取/配置压缩 |",
    "",
    "### 2.3 三档压缩策略",
    "- **保守 (conservative)**: 乘数 1.5，仅对超大内容蒸馏",
    "- **适中 (moderate)**: 乘数 1.0，平衡信息保留与压缩",
    "- **激进 (aggressive)**: 乘数 0.6，最大化压缩，适合长对话",
    "",
    "### 2.4 CJK Token 估算",
    "针对中日韩文本的 token 估算采用与 lossless-claw 一致的算法：",
    "- CJK 字符：每字符约 1.5 tokens",
    "- ASCII 字符：每字符约 0.25 tokens（即 4 字符/token）",
    "- 混合文本：按字符类别加权计算",
    "",
    "## 三、Hook 集成机制",
    "",
    "### 3.1 tool_result_persist Hook",
    "这是主要的压缩点。当工具执行结果即将被持久化到会话记录时触发：",
    "- 拦截 tool result 消息",
    "- 分析内容类别（JSON/Patch/File/Text）",
    "- 检查是否超过阈值",
    "- 应用匹配的蒸馏规则",
    "- 返回压缩后的消息（或原始消息如不需要蒸馏）",
    "",
    "### 3.2 before_message_write Hook",
    "作为补充机制，捕获未被 tool_result_persist 覆盖的冗长内容：",
    "- 仅处理 role=tool 的消息",
    "- 使用简单的头+尾截断策略",
    "- 适用于大型结构化输出",
    "",
    "## 四、与 LCM 的协同",
    "context-distiller 不替代 LCM，而是在数据进入 LCM 之前进行预压缩：",
    "1. 工具输出 → context-distiller 蒸馏 → LCM 摄入 → DAG 摘要",
    "2. 两个系统配置完全隔离，互不影响",
    "3. 蒸馏后的内容保留了足够的信息供 LCM 的摘要系统使用",
    "",
    "## 五、性能基准",
    "",
    "### 5.1 压缩效果测试",
    "| 场景 | 压缩前 (tokens) | 压缩后 (tokens) | 节省率 |",
    "|------|-----------------|-----------------|--------|",
    "| Diff/Patch | 7,341 | 1,226 | 83.3% |",
    "| 重复日志 | 1,463 | 182 | 87.6% |",
    "| 全管道 (4工具) | 3,084 | 380 | 87.7% |",
    "| 文件内容 | 6,093 | 2,016 | 66.9% |",
    "| JSON API 输出 | 5,117 | 4,079 | 20.3% |",
    "",
    "### 5.2 延迟影响",
    "蒸馏操作在同步 hook 中执行，不使用 LLM（LLM 摘要仅在异步路径可用）。",
    "典型延迟：<5ms 每次蒸馏操作。",
    "",
    "## 六、安装与配置",
    "```bash",
    "# 安装",
    "git clone https://github.com/example/context-distiller.git ~/.openclaw/extensions/context-distiller",
    "cd ~/.openclaw/extensions/context-distiller && npm install",
    "",
    "# 在 openclaw.json 中注册",
    '# plugins.allow 添加 "context-distiller"',
    "# plugins.entries.context-distiller 添加配置",
    "```",
    "",
    "## 七、测试覆盖",
    "- 单元测试：144 assertions ✅",
    "- 集成测试：60 assertions ✅",
    "- E2E 端到端测试：10 个真实场景 ✅",
    "",
    "## 八、已知限制",
    "1. tool_result_persist hook 是同步的，无法在其中调用 LLM 摘要",
    "2. 每次 --local 调用启动独立进程，蒸馏统计不跨进程保留",
    "3. preservePatterns 配置目前只支持正则表达式字面量",
    "",
    "## 九、未来规划",
    "- [ ] 支持自定义蒸馏规则注册（通过配置文件）",
    "- [ ] 蒸馏统计持久化（写入 SQLite）",
    "- [ ] 与 LCM 的 large_files 拦截器集成",
    "- [ ] 支持图片/多模态内容的蒸馏",
    "- [ ] 蒸馏效果的 A/B 测试框架",
  ].join("\n");

  const result = await runDistill(cjkContent, "read_file");
  const tokensBefore = estimateTokens(cjkContent);
  const passed = result.distilled && result.tokensAfter < result.tokensBefore;

  // Also verify CJK token estimation is reasonable
  const pureAscii = "a".repeat(100);
  const pureCjk = "你".repeat(100);
  const asciiTokens = estimateTokens(pureAscii);
  const cjkTokens = estimateTokens(pureCjk);
  const cjkEstimateCorrect = cjkTokens > asciiTokens * 2; // CJK should estimate to more tokens

  results.push({
    id: 10,
    name: "中文/CJK 内容蒸馏 — 多语言验证",
    passed: passed && cjkEstimateCorrect,
    tokensBefore: result.tokensBefore,
    tokensAfter: result.tokensAfter,
    distilled: result.distilled,
    ratio: result.distilled ? `${((result.tokensAfter / result.tokensBefore) * 100).toFixed(1)}%` : "100%",
    details: `CJK doc: ${cjkContent.split("\n").length} lines, CJK token ratio correct: ${cjkEstimateCorrect} (100 ASCII→${asciiTokens}t, 100 CJK→${cjkTokens}t)`,
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${BOLD}═══════════════════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  context-distiller E2E Real-World Test Suite${RESET}`);
  console.log(`${BOLD}  10 scenarios: simple → complex${RESET}`);
  console.log(`${BOLD}═══════════════════════════════════════════════════════════════${RESET}\n`);

  // Create engine with default moderate config
  engine = createEngine();

  await test1_distillStatus();
  report(results[results.length - 1]);

  await test2_shortShellCommand();
  report(results[results.length - 1]);

  await test3_readLargeFile();
  report(results[results.length - 1]);

  await test4_diffPatch();
  report(results[results.length - 1]);

  await test5_largeJsonApi();
  report(results[results.length - 1]);

  await test6_repetitiveLogs();
  report(results[results.length - 1]);

  await test7_runtimeConfigChange();
  report(results[results.length - 1]);

  await test8_multiToolPipeline();
  report(results[results.length - 1]);

  await test9_massiveDirectoryTraversal();
  report(results[results.length - 1]);

  await test10_cjkContent();
  report(results[results.length - 1]);

  // ── Summary ──────────────────────────────────────────────────────────────

  console.log(`${BOLD}═══════════════════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  SUMMARY${RESET}`);
  console.log(`${BOLD}═══════════════════════════════════════════════════════════════${RESET}\n`);

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const totalTokensBefore = results.reduce((s, r) => s + r.tokensBefore, 0);
  const totalTokensAfter = results.reduce((s, r) => s + r.tokensAfter, 0);
  const distilledCount = results.filter(r => r.distilled).length;

  console.log(`  Results: ${GREEN}${passed} passed${RESET}, ${failed > 0 ? RED : DIM}${failed} failed${RESET} / ${results.length} total`);
  console.log(`  Distilled: ${distilledCount}/${results.length} scenarios triggered distillation`);
  console.log(`  Total tokens: ${totalTokensBefore.toLocaleString()} → ${totalTokensAfter.toLocaleString()} (${((totalTokensAfter / totalTokensBefore) * 100).toFixed(1)}%)`);
  console.log(`  Total saved: ${(totalTokensBefore - totalTokensAfter).toLocaleString()} tokens`);
  console.log();

  // Engine stats
  const stats = engine.getStats();
  console.log(`  Engine stats:`);
  console.log(`    Messages processed: ${stats.messagesProcessed}`);
  console.log(`    Distillations: ${stats.distillations}`);
  console.log(`    Tokens saved (engine): ${stats.tokensSaved.toLocaleString()}`);
  console.log(`    Avg compression ratio: ${stats.avgCompressionRatio.toFixed(3)}`);
  console.log(`    Rule hits: ${JSON.stringify(stats.ruleHits)}`);
  console.log();

  // Results table
  console.log(`  ${BOLD}┌─────┬────────────────────────────────────────┬──────────┬──────────┬────────┐${RESET}`);
  console.log(`  ${BOLD}│ #   │ Scenario                               │ Before   │ After    │ Ratio  │${RESET}`);
  console.log(`  ${BOLD}├─────┼────────────────────────────────────────┼──────────┼──────────┼────────┤${RESET}`);
  for (const r of results) {
    const icon = r.passed ? "✅" : "❌";
    const name = r.name.padEnd(38).substring(0, 38);
    const before = String(r.tokensBefore).padStart(6);
    const after = String(r.tokensAfter).padStart(6);
    const ratio = r.ratio.padStart(6);
    console.log(`  │ ${icon}${String(r.id).padStart(2)} │ ${name} │ ${before} │ ${after} │ ${ratio} │`);
  }
  console.log(`  ${BOLD}└─────┴────────────────────────────────────────┴──────────┴──────────┴────────┘${RESET}`);
  console.log();

  if (failed > 0) {
    console.log(`${RED}${BOLD}  FAILED TESTS:${RESET}`);
    for (const r of results.filter(r => !r.passed)) {
      console.log(`  ${RED}E2E-${r.id}: ${r.name}${RESET}`);
      if (r.error) console.log(`    ${r.error}`);
    }
    process.exit(1);
  } else {
    console.log(`${GREEN}${BOLD}  ALL 10 E2E TESTS PASSED ✅${RESET}\n`);
    process.exit(0);
  }
}

main().catch(err => {
  console.error(`${RED}Fatal error: ${err.message}${RESET}`);
  console.error(err.stack);
  process.exit(1);
});
