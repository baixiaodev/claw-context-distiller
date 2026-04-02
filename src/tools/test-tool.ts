/**
 * test-distiller tool for OpenClaw
 * 
 * Runs the 30 test cases against the context-distiller plugin and sends
 * results via Telegram DM (avoiding Discord channel clutter).
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import https from "https";
import http from "http";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Telegram config (loaded from environment)
const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8767774274:AAEBcRGaHIG2UrLb5jMz-noWPbRUd0d-aLI";
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "8527800561";
const PROXY_HOST = process.env.HTTPS_PROXY?.replace("http://", "")?.split(":")[0] || "127.0.0.1";
const PROXY_PORT = parseInt(process.env.HTTPS_PROXY?.split(":")[1] || "7897");

interface TestCase {
  id: number;
  name: string;
  category: "tool_output" | "patch" | "file_content" | "text";
  description: string;
  originalTokensEstimate: number;
  expectedRule: string;
  originalContent: string;
  expectedDistilledPattern: string;
}

interface TestResult {
  id: number;
  name: string;
  category: string;
  pass: boolean;
  originalTokens: number;
  resultTokens: number;
  savedTokens: number;
  compressionPct: number;
  expectedRule: string;
  actualRule: string;
  ruleMatch: boolean;
  patternFound: boolean;
  error?: string;
  preview: string;
}

// Import plugin internals (requires the test exports from index.ts)
async function loadPlugin() {
  const pluginPath = join(homedir(), ".openclaw/extensions/context-distiller");
  const mod = await import(join(pluginPath, "index.ts"));
  const configMod = await import(join(pluginPath, "src/config.ts"));
  const tokensMod = await import(join(pluginPath, "src/tokens.ts"));
  
  return {
    distillSync: mod._testDistillSync as Function,
    resolveConfig: configMod.resolveConfig as Function,
    estimateTokens: tokensMod.estimateTokens as Function,
  };
}

// Send message via Telegram (DM)
async function sendTelegramDM(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      chat_id: TG_CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });

    const proxyReq = http.request({
      host: PROXY_HOST,
      port: PROXY_PORT,
      method: "CONNECT",
      path: "api.telegram.org:443",
    });

    proxyReq.on("connect", (_res, socket) => {
      const req = https.request({
        host: "api.telegram.org",
        path: `/bot${TG_BOT_TOKEN}/sendMessage`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        socket,
        agent: false,
      } as any, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          const parsed = JSON.parse(data);
          if (!parsed.ok) {
            console.error("[test-distiller] Telegram error:", parsed);
          }
          resolve();
        });
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });

    proxyReq.on("error", reject);
    proxyReq.end();
  });
}

// Load test cases from workspace
function loadTestCases(): TestCase[] {
  const workspaceDir = join(homedir(), "WorkBuddy/Claw");
  const file1 = JSON.parse(readFileSync(join(workspaceDir, "distiller-test-cases-15.json"), "utf8"));
  const file2 = JSON.parse(readFileSync(join(workspaceDir, "distiller-test-cases-16-30.json"), "utf8"));
  return [...file1.testCases, ...file2.testCases];
}

// Run a single test case
function runTestCase(
  tc: TestCase,
  distillSync: Function,
  estimateTokens: Function,
): TestResult {
  try {
    // Use low thresholds to trigger compression even with small test content
    const testConfig = {
      toolOutputMaxTokens: 100,
      patchMaxTokens: 80,
      fileContentMaxTokens: 120,
      messageMaxTokens: 150,
      aggressiveness: "normal" as const,
      enabled: true,
    };

    const originalTokens = estimateTokens(tc.originalContent);
    const result = distillSync(tc.originalContent, originalTokens, tc.category, testConfig) as {
      distilled: boolean; content: string; tokens: number; rule: string;
    } | null;

    if (!result || !result.distilled) {
      const pass = originalTokens < 150;
      return {
        id: tc.id,
        name: tc.name,
        category: tc.category,
        pass,
        originalTokens,
        resultTokens: originalTokens,
        savedTokens: 0,
        compressionPct: 0,
        expectedRule: tc.expectedRule,
        actualRule: "none",
        ruleMatch: false,
        patternFound: false,
        error: pass ? undefined : "No distillation applied",
        preview: tc.originalContent.slice(0, 120),
      };
    }

    const resultTokens = result.tokens ?? estimateTokens(result.content);
    const savedTokens = originalTokens - resultTokens;
    const compressionPct = Math.round((savedTokens / Math.max(1, originalTokens)) * 100);
    const ruleMatch = result.rule === tc.expectedRule ||
      result.rule.startsWith(tc.expectedRule.split("/")[0]);
    const patternFound = tc.expectedDistilledPattern
      ? result.content.includes(tc.expectedDistilledPattern.split("\\n")[0].slice(0, 30))
      : true;
    const pass = savedTokens > 0 && compressionPct >= 10;

    return {
      id: tc.id,
      name: tc.name,
      category: tc.category,
      pass,
      originalTokens,
      resultTokens,
      savedTokens,
      compressionPct,
      expectedRule: tc.expectedRule,
      actualRule: result.rule,
      ruleMatch,
      patternFound,
      preview: result.content.slice(0, 120).replace(/\n/g, " "),
    };
  } catch (err) {
    return {
      id: tc.id,
      name: tc.name,
      category: tc.category,
      pass: false,
      originalTokens: 0,
      resultTokens: 0,
      savedTokens: 0,
      compressionPct: 0,
      expectedRule: tc.expectedRule,
      actualRule: "error",
      ruleMatch: false,
      patternFound: false,
      error: err instanceof Error ? err.message : String(err),
      preview: "",
    };
  }
}

// Escape HTML for Telegram
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Format summary
function formatSummary(results: TestResult[]): string {
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  const totalOriginal = results.reduce((s, r) => s + r.originalTokens, 0);
  const totalSaved = results.reduce((s, r) => s + r.savedTokens, 0);
  const avgCompression = results.length > 0
    ? Math.round(results.reduce((s, r) => s + r.compressionPct, 0) / results.length)
    : 0;

  return `<b>🧪 context-distiller OpenClaw 测试</b>
版本: v0.1.0 | Agent: Jarvis

<b>总体结果</b>
✅ 通过: ${passed}/30  ❌ 失败: ${failed}/30
📊 原始 Tokens: ${totalOriginal.toLocaleString()}
💾 节省 Tokens: ${totalSaved.toLocaleString()} (${Math.round(totalSaved/Math.max(1,totalOriginal)*100)}%)
📉 平均压缩率: ${avgCompression}%`;
}

// Format batch
function formatBatch(results: TestResult[], batchNum: number): string {
  const lines = [`<b>📋 测试详情 (${batchNum === 1 ? "1-10" : batchNum === 2 ? "11-20" : "21-30"})</b>\n`];
  for (const r of results) {
    const icon = r.pass ? "✅" : "❌";
    const compression = r.compressionPct > 0 ? ` -${r.compressionPct}%` : " (未压缩)";
    const ruleIcon = r.ruleMatch ? "🎯" : "⚠️";
    lines.push(
      `${icon} <b>#${r.id}</b> ${escapeHtml(r.name)}` +
      `\n   ${r.originalTokens}→${r.resultTokens} tok${compression}` +
      `\n   ${ruleIcon} 规则: <code>${escapeHtml(r.actualRule)}</code>`
    );
  }
  return lines.join("\n");
}

// Main test runner
export async function runDistillerTests(options?: { sendToTelegram?: boolean; saveToFile?: boolean }): Promise<string> {
  const opts = { sendToTelegram: true, saveToFile: true, ...options };
  console.log("[test-distiller] Starting 30 test cases...");
  
  // Load plugin
  const plugin = await loadPlugin();
  const testCases = loadTestCases();
  
  console.log(`[test-distiller] Loaded ${testCases.length} test cases`);
  
  // Run tests
  const results: TestResult[] = [];
  for (const tc of testCases) {
    console.log(`[test-distiller] Running #${tc.id}: ${tc.name}`);
    const result = runTestCase(tc, plugin.distillSync, plugin.estimateTokens);
    results.push(result);
  }
  
  // Generate report
  const summary = formatSummary(results);
  const batch1 = formatBatch(results.slice(0, 10), 1);
  const batch2 = formatBatch(results.slice(10, 20), 2);
  const batch3 = formatBatch(results.slice(20, 30), 3);
  
  // Send via Telegram DM if requested (not Discord channel)
  if (opts.sendToTelegram) {
    console.log("[test-distiller] Sending results to Telegram DM...");
    await sendTelegramDM(summary);
    await new Promise(r => setTimeout(r, 500));
    await sendTelegramDM(batch1);
    await new Promise(r => setTimeout(r, 500));
    await sendTelegramDM(batch2);
    await new Promise(r => setTimeout(r, 500));
    await sendTelegramDM(batch3);
  }
  
  // Save to file if requested
  if (opts.saveToFile) {
    const reportPath = join(homedir(), "WorkBuddy/Claw/distiller-test-report.txt");
    const detailedReport = results.map(r => 
      `#${r.id} ${r.name}\n` +
      `Pass: ${r.pass} | ${r.originalTokens}→${r.resultTokens} tokens (${r.compressionPct}% saved)\n` +
      `Expected: ${r.expectedRule} | Actual: ${r.actualRule}\n` +
      (r.error ? `Error: ${r.error}\n` : "") +
      `Preview: ${r.preview.slice(0, 80)}...\n`
    ).join("\n");
    
    writeFileSync(reportPath, `context-distiller test report\nGenerated: ${new Date().toISOString()}\n\n${summary.replace(/<[^>]+>/g, "")}\n\n${detailedReport}`);
    
    const finalMsg = `✅ Test complete! ${results.filter(r => r.pass).length}/30 passed. Report saved to: ${reportPath}`;
    if (opts.sendToTelegram) {
      await sendTelegramDM(finalMsg);
    }
    return finalMsg;
  }
  
  return `✅ Test complete! ${results.filter(r => r.pass).length}/30 passed.`;
}

// OpenClaw tool definition
export const testDistillerTool = {
  id: "test_distiller",
  name: "Test Context Distiller",
  description: "Run 30 test cases against the context-distiller plugin and send results via Telegram DM (avoids Discord channel clutter).",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      result: { type: "string" },
    },
  },
  execute: async (_input: Record<string, unknown>) => {
    const result = await runDistillerTests();
    return { result };
  },
};
