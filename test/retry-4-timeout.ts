/**
 * retry-4-timeout.ts — 重跑 V2 测试中 300s 超时的 4 个案例 (timeout=600s)
 *
 * 超时案例:
 *   Case 4:  AI算力到电力转移的投资主线分析
 *   Case 10: K8s GPU调度在AI推理服务中的技术演进
 *   Case 12: WebAssembly在边缘计算的商业化落地分析
 *   Case 18: 实时数据管道: Kafka→Iceberg Lakehouse
 */

const API_BASE = "http://localhost:18789/v1/responses";
const API_KEY = "3e71ac6673930b831f944d2782e1bd2a8df5a3f64ece0298";
const STATS_PATH = "/Users/gaoyuan/.openclaw/extensions/context-distiller/.stats.json";
const TIMEOUT_MS = 600_000; // 10 minutes

interface TestCase {
  id: number;
  category: string;
  source: string;
  title: string;
  prompt: string;
}

interface ResponseResult {
  ok: boolean;
  output: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  toolCalls: number;
}

const retryCases: TestCase[] = [
  {
    id: 4,
    category: "投资研究",
    source: "Morgan Stanley Research + 第一财经",
    title: "AI算力到电力转移的投资主线分析",
    prompt: `Morgan Stanley 2026年3月的研报说"AI becomes the central force influencing growth, earnings, geopolitics, and investment strategy"。第一财经和证券之星也在讨论"算力尽头是电力：2026年AI能源超级周期下的掘金指南"。

请搜索并分析：
1. 2026年全球AI数据中心的总电力消耗预测（TWh），各大研究机构的预测对比
2. 从GPU到电力的投资链条转移具体路径：哪些上下游公司受益？
3. 液冷散热、核电小堆（SMR）、储能在AI电力链中的角色
4. 搜索台积电CoWoS封装产能扩张对AI算力供给的影响
5. 列出A股+港股+美股中"AI电力"主题的核心标的，附估值

请给出有具体数据支撑的投资研究报告。`,
  },
  {
    id: 10,
    category: "产业研究",
    source: "HackerNews + Kubernetes Blog",
    title: "K8s GPU调度在AI推理服务中的技术演进",
    prompt: `HackerNews和Reddit r/devops上有大量讨论K8s GPU调度的帖子。有人说"48% of organizations now running AI/ML workloads on Kubernetes"。最新的帖子讨论了"如何在Kubernetes上用GPU做机器学习训练的任务调度"。

请研究：
1. 搜索Kubernetes GPU调度的最新方案（NVIDIA device plugin、MIG、time-slicing）
2. vLLM在K8s上部署的最佳实践（GPU资源限制、HPA、readiness probes）
3. KAI Scheduler等新的GPU调度器与默认调度器的对比
4. 搜索企业在生产环境中GPU利用率低的原因和解决方案
5. 2026年GPU-as-a-Service市场规模和主要玩家

请引用具体的K8s文档和社区讨论。`,
  },
  {
    id: 12,
    category: "产业研究",
    source: "Calmops + Cloudflare Blog",
    title: "WebAssembly在边缘计算的商业化落地分析",
    prompt: `Calmops最近发了一篇"WebAssembly Serverless Architecture: The Future of Edge Computing 2026"。Cloudflare Workers已经大规模使用Wasm。Fermyon、Cosmonic等创业公司也在推动Wasm在服务端的应用。

请深入分析：
1. 搜索2025-2026年WebAssembly在服务端/边缘计算的采用数据
2. Cloudflare Workers vs Fastly Compute@Edge vs AWS Lambda@Edge的技术对比
3. WASI (WebAssembly System Interface) 标准化进展
4. Wasm vs Container在冷启动时间、内存占用、安全性方面的基准测试数据
5. 搜索Fermyon、Cosmonic、Wasmer等Wasm创业公司的最新融资和产品进展

请给出产业趋势判断。`,
  },
  {
    id: 18,
    category: "技术方案",
    source: "Confluent Blog + Databricks",
    title: "实时数据管道: Kafka→Iceberg Lakehouse",
    prompt: `我们正在把数据平台从传统的Kafka→Hive升级到Kafka→Iceberg的Lakehouse架构。Confluent和Databricks都推了自己的解决方案。

当前架构：
\`\`\`
数据源 → Kafka (3 brokers) → Flink → Hive on HDFS
                                    → Elasticsearch (实时查询)

日数据量: 50TB (JSON格式, 200+字段)
Kafka topic: 500+
延迟要求: 端到端 < 5分钟
当前问题:
  - Hive小文件问题严重 (日产10万个小文件)
  - Schema evolution困难
  - Time travel/ACID不支持
  - 查询性能差 (30分钟的报表查询)
\`\`\`

请帮我设计新方案：
1. 搜索Apache Iceberg vs Delta Lake vs Apache Hudi的最新对比（2025-2026）
2. Kafka Connect + Iceberg Sink vs Flink + Iceberg Writer的方案对比
3. Iceberg的表格式如何解决小文件问题？compaction策略怎么配？
4. 搜索Iceberg在50TB/天级别的生产案例和性能基准
5. 从Hive迁移到Iceberg的最佳迁移路径（in-place migration vs shadow migration）
6. 给出完整的架构方案和关键配置`,
  },
];

// ── API Client ──────────────────────────────────────────────────────────────

async function sendToJarvis(prompt: string, timeoutMs: number): Promise<ResponseResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(API_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ model: "main", input: prompt }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return { ok: false, output: `HTTP ${resp.status}: ${errText.slice(0, 200)}`, inputTokens: 0, outputTokens: 0, durationMs: Date.now() - start, toolCalls: 0 };
    }

    const data = await resp.json() as Record<string, unknown>;
    let outputText = "";
    const output = data.output;
    if (Array.isArray(output)) {
      for (const item of output) {
        if (item && typeof item === "object") {
          const msg = item as Record<string, unknown>;
          if (msg.type === "message" && Array.isArray(msg.content)) {
            for (const block of msg.content as Array<Record<string, unknown>>) {
              if (block.type === "output_text" && typeof block.text === "string") {
                outputText += block.text;
              }
            }
          }
        }
      }
    }

    const usage = data.usage as Record<string, number> | undefined;
    const toolCalls = Array.isArray(output)
      ? output.filter((o: Record<string, unknown>) => o.type === "function_call" || o.type === "tool_use").length
      : 0;

    return { ok: true, output: outputText, inputTokens: usage?.input_tokens ?? 0, outputTokens: usage?.output_tokens ?? 0, durationMs: Date.now() - start, toolCalls };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, output: err instanceof Error ? err.message : String(err), inputTokens: 0, outputTokens: 0, durationMs: Date.now() - start, toolCalls: 0 };
  }
}

function readStats() {
  try { return JSON.parse(require("fs").readFileSync(STATS_PATH, "utf8")); }
  catch { return { totalDistillations: 0, totalTokensSaved: 0 }; }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(80));
  console.log("Context Distiller V2 — Retrying 4 Timeout Cases (600s timeout)");
  console.log("=".repeat(80));
  console.log(`Start: ${new Date().toISOString()}\n`);

  const baseline = readStats();
  console.log(`Baseline: ${baseline.totalDistillations} distillations, ${baseline.totalTokensSaved.toLocaleString()} tokens saved\n`);

  const results: any[] = [];

  for (const tc of retryCases) {
    console.log(`${"─".repeat(70)}`);
    console.log(`Case ${tc.id}: [${tc.category}] ${tc.title}`);
    console.log(`Source: ${tc.source}`);
    console.log("Sending to Jarvis...");

    const result = await sendToJarvis(tc.prompt, TIMEOUT_MS);
    results.push({ ...tc, ok: result.ok, durationMs: result.durationMs, inputTokens: result.inputTokens, outputTokens: result.outputTokens, outputLength: result.output.length, toolCalls: result.toolCalls });

    const status = result.ok ? "✅" : "❌";
    console.log(`${status} Done in ${(result.durationMs / 1000).toFixed(0)}s`);
    console.log(`  Input: ${result.inputTokens.toLocaleString()} tokens`);
    console.log(`  Output: ${result.outputTokens.toLocaleString()} tokens (${result.output.length} chars)`);

    // Check distiller delta
    const current = readStats();
    const deltaD = current.totalDistillations - baseline.totalDistillations;
    const deltaT = current.totalTokensSaved - baseline.totalTokensSaved;
    console.log(`  Distiller cumulative: +${deltaD} distillations, +${deltaT.toLocaleString()} tokens saved`);

    await new Promise(r => setTimeout(r, 3000));
  }

  // ── Summary ──
  console.log(`\n${"═".repeat(80)}`);
  console.log("RETRY SUMMARY");
  console.log("═".repeat(80));

  const final = readStats();
  const successCount = results.filter(r => r.ok).length;
  const totalInput = results.reduce((s, r) => s + r.inputTokens, 0);
  const totalDuration = results.reduce((s, r) => s + r.durationMs, 0);
  const deltaD = final.totalDistillations - baseline.totalDistillations;
  const deltaT = final.totalTokensSaved - baseline.totalTokensSaved;

  console.log(`Retried cases: ${results.length}`);
  console.log(`Success: ${successCount}/${results.length}`);
  console.log(`Total duration: ${(totalDuration / 60_000).toFixed(1)} minutes`);
  console.log(`Total input tokens: ${totalInput.toLocaleString()}`);
  console.log(`New distillations: ${deltaD}`);
  console.log(`New tokens saved: ${deltaT.toLocaleString()}`);

  for (const r of results) {
    console.log(`  Case ${r.id}: ${r.ok ? "✅" : "❌"} ${(r.durationMs / 1000).toFixed(0)}s, ${r.inputTokens.toLocaleString()} in, ${r.outputTokens.toLocaleString()} out`);
  }

  // Update the main data file with new results
  const mainDataPath = "/Users/gaoyuan/WorkBuddy/Claw/distiller-v2-20cases-data.json";
  try {
    const fs = require("fs");
    const mainData = JSON.parse(fs.readFileSync(mainDataPath, "utf8"));
    for (const r of results) {
      const idx = mainData.results.findIndex((x: any) => x.id === r.id);
      if (idx >= 0 && !mainData.results[idx].ok) {
        mainData.results[idx] = {
          ...mainData.results[idx],
          ok: r.ok,
          durationMs: r.durationMs,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          outputLength: r.outputLength,
          toolCalls: r.toolCalls,
        };
        console.log(`\n  Updated Case ${r.id} in main data file`);
      }
    }
    // Update final stats
    mainData.final = { distillations: final.totalDistillations, tokensSaved: final.totalTokensSaved };
    mainData.delta = { distillations: final.totalDistillations - (mainData.baseline?.distillations ?? 0), tokensSaved: final.totalTokensSaved - (mainData.baseline?.tokensSaved ?? 0) };
    mainData.retryResults = results.map(r => ({ id: r.id, ok: r.ok, durationMs: r.durationMs, inputTokens: r.inputTokens, outputTokens: r.outputTokens }));
    mainData.timestamp = new Date().toISOString();
    fs.writeFileSync(mainDataPath, JSON.stringify(mainData, null, 2));
    console.log(`\nData updated in: ${mainDataPath}`);
  } catch (e) {
    console.error(`Failed to update main data: ${e}`);
  }

  console.log(`\nEnd: ${new Date().toISOString()}`);
}

main().catch(console.error);
