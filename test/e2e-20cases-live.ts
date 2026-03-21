#!/usr/bin/env npx tsx
/**
 * 20 Real-World Test Cases — Live OpenClaw Gateway Interaction
 *
 * Tests context-distiller with realistic user queries across 5 domains:
 *   1. 投资研究分析 (Investment Research)          — 4 cases
 *   2. 学术课题研究 (Academic Research)             — 4 cases
 *   3. 产业/科技深度研究 (Industry/Tech Research)   — 4 cases
 *   4. 复杂需求分析 (Complex Requirements Analysis) — 4 cases
 *   5. 技术实现方案 (Technical Implementation)      — 4 cases
 *
 * Each case:
 *   1. Creates a fresh session
 *   2. Sends a realistic user prompt
 *   3. Monitors distiller stats before/after
 *   4. Captures the full response and tool call details
 *   5. Records distiller effectiveness metrics
 *
 * Sources: Reddit (r/investing, r/algotrading), HackerNews, GitHub Issues,
 *   V2EX, 知乎, arXiv, ProductHunt, Stack Overflow, DevOps communities
 */

import * as fs from "fs";
import * as path from "path";

const GATEWAY_URL = "http://localhost:18789";
const AUTH_TOKEN = "3e71ac6673930b831f944d2782e1bd2a8df5a3f64ece0298";
const STATS_FILE = "/Users/gaoyuan/.openclaw/extensions/context-distiller/.stats.json";

// ── Test Case Definitions ──────────────────────────────────────────────────

interface TestCase {
  id: number;
  domain: string;
  title: string;
  /** Source community/context for this prompt */
  source: string;
  /** The user prompt to send to Jarvis */
  prompt: string;
  /** Expected behavior: what kind of tools should be called */
  expectedTools: string[];
  /** What content types we expect distiller to process */
  expectedDistillerTargets: string[];
}

const TEST_CASES: TestCase[] = [
  // ════════════════════════════════════════════════════════════════════════
  // Domain 1: 投资研究分析 (Investment Research)
  // ════════════════════════════════════════════════════════════════════════
  {
    id: 1,
    domain: "投资研究",
    title: "宁德时代 vs BYD 储能业务对比分析",
    source: "r/investing + 雪球社区",
    prompt: `我正在做一个深度研究，帮我搜索并分析：
1. 宁德时代和比亚迪在储能业务领域的最新发展（2025-2026年）
2. 两家公司储能业务的营收占比、毛利率变化趋势
3. 它们在北美和欧洲市场的竞争格局

请搜索最新的财报数据、行业报告和新闻，然后给我一个结构化的对比分析。`,
    expectedTools: ["web_search", "web_fetch", "exec(tavily)"],
    expectedDistillerTargets: ["search_results", "web_fetch_content"],
  },
  {
    id: 2,
    domain: "投资研究",
    title: "AI 算力 ETF 配置策略",
    source: "r/algotrading + 韭菜修炼手册",
    prompt: `我想了解当前AI算力产业链的投资机会。请搜索以下内容：
1. 英伟达（NVDA）、AMD、博通（AVGO）最近两个季度的数据中心业务增速
2. 国内算力概念股（寒武纪、海光信息、中科曙光）的估值对比
3. 全球AI算力市场2026年预测（IDC/Gartner最新数据）

整理成一份可以指导ETF配置的研究备忘录。`,
    expectedTools: ["web_search", "web_fetch"],
    expectedDistillerTargets: ["search_results", "api_response"],
  },
  {
    id: 3,
    domain: "投资研究",
    title: "新兴市场债券风险评估",
    source: "Bloomberg Terminal user forum + 集思录",
    prompt: `帮我研究一下新兴市场债券的风险状况：
1. 搜索2025-2026年新兴市场主权债违约事件和风险预警
2. 美联储利率路径对新兴市场资本流动的影响分析
3. 重点关注土耳其、阿根廷、埃及的债务可持续性指标

我需要一个风险评估矩阵。`,
    expectedTools: ["web_search", "web_fetch"],
    expectedDistillerTargets: ["search_results", "data_output"],
  },
  {
    id: 4,
    domain: "投资研究",
    title: "量化因子失效分析",
    source: "r/quant + WorldQuant community",
    prompt: `请搜索并分析最近量化投资领域的因子失效现象：
1. 2025年下半年以来，动量因子、价值因子、质量因子的表现（A股和美股）
2. 机器学习因子（特别是NLP情绪因子）在拥挤交易下的衰减
3. 有没有学术论文或研究报告讨论"alpha decay"加速的原因

总结成一份量化策略调整建议。`,
    expectedTools: ["web_search", "web_fetch", "exec(tavily)"],
    expectedDistillerTargets: ["search_results", "api_response"],
  },

  // ════════════════════════════════════════════════════════════════════════
  // Domain 2: 学术课题研究 (Academic Research)
  // ════════════════════════════════════════════════════════════════════════
  {
    id: 5,
    domain: "学术研究",
    title: "LLM 幻觉检测与缓解综述",
    source: "arXiv + Semantic Scholar + r/MachineLearning",
    prompt: `我在写一篇关于大语言模型幻觉问题的综述论文，请帮我：
1. 搜索 2024-2026 年 LLM hallucination detection 和 mitigation 的最新论文
2. 重点关注 retrieval-augmented generation (RAG) 方法、self-consistency checking、factual verification 这三个方向
3. 找出被引用最多的 benchmark datasets（如 TruthfulQA、HaluEval）

请整理成文献综述的框架，包含关键论文的引用信息。`,
    expectedTools: ["web_search", "web_fetch", "exec(tavily)"],
    expectedDistillerTargets: ["search_results", "api_response"],
  },
  {
    id: 6,
    domain: "学术研究",
    title: "蛋白质语言模型与药物设计",
    source: "Nature Machine Intelligence + PubMed + BioRxiv",
    prompt: `请帮我调研 protein language models 在药物发现中的最新进展：
1. 搜索 ESM-3、AlphaFold3、ProteinMPNN 等模型在 drug design 中的应用
2. 对比 structure-based 和 sequence-based 方法在 binding affinity prediction 上的性能
3. 找出 FDA 批准的第一批 AI-designed 药物的临床试验进展

我需要一份适合在实验室组会上展示的技术综述。`,
    expectedTools: ["web_search", "web_fetch"],
    expectedDistillerTargets: ["search_results", "web_fetch_content"],
  },
  {
    id: 7,
    domain: "学术研究",
    title: "联邦学习在医疗数据隐私中的应用",
    source: "ICML/NeurIPS proceedings + 知乎学术圈",
    prompt: `我的博士课题方向是联邦学习在医疗数据隐私保护中的应用。请搜索：
1. 2024-2026 年联邦学习 + 医疗影像/电子病历的顶会论文（ICML, NeurIPS, MICCAI）
2. 差分隐私（DP）与安全聚合在联邦学习中的最新进展，特别是通信效率优化
3. 真实部署案例：哪些医院/机构已经在用联邦学习做多中心研究

整理出 3-5 个可行的研究方向建议。`,
    expectedTools: ["web_search", "web_fetch", "exec(tavily)"],
    expectedDistillerTargets: ["search_results", "api_response"],
  },
  {
    id: 8,
    domain: "学术研究",
    title: "碳捕获技术的经济性分析",
    source: "Science/Nature + IPCC report + 能源经济学期刊",
    prompt: `我在准备一个关于碳捕获与封存(CCS)技术经济性的研究提案：
1. 搜索最新的直接空气捕获(DAC)技术成本数据（$/tCO2），对比2020年和2026年
2. 主要DAC公司（Climeworks, Carbon Engineering/Oxy, Global Thermostat）的技术路线和成本
3. 各国碳价格走势（EU ETS、中国碳市场）对CCS经济性的影响

帮我整理成研究提案的背景文献部分。`,
    expectedTools: ["web_search", "web_fetch"],
    expectedDistillerTargets: ["search_results", "data_output"],
  },

  // ════════════════════════════════════════════════════════════════════════
  // Domain 3: 产业/科技深度研究 (Industry/Tech Deep Research)
  // ════════════════════════════════════════════════════════════════════════
  {
    id: 9,
    domain: "产业研究",
    title: "具身智能机器人产业链全景",
    source: "HackerNews + 36氪 + 机器之心",
    prompt: `请做一份具身智能（Embodied AI）机器人产业链的深度研究：
1. 搜索 2025-2026 年人形机器人领域的最新进展（Figure AI、Tesla Optimus、1X、优必选、宇树科技）
2. 核心零部件供应链：关节电机、减速器、力矩传感器、触觉皮肤的主要供应商
3. 商业化落地场景：哪些公司已经实现商业部署，在什么场景

给出产业链图谱和投资机会分析。`,
    expectedTools: ["web_search", "web_fetch", "exec(tavily)"],
    expectedDistillerTargets: ["search_results", "api_response"],
  },
  {
    id: 10,
    domain: "产业研究",
    title: "全球半导体先进封装竞争格局",
    source: "SemiAnalysis + 芯智讯 + AnandTech",
    prompt: `帮我研究半导体先进封装（Advanced Packaging）的竞争格局：
1. 搜索台积电 CoWoS、Intel Foveros、三星 I-Cube 的产能扩张计划和良率数据
2. Chiplet 互联标准（UCIe）的生态发展和主要参与者
3. 中国大陆封测企业（长电科技、通富微电、华天科技）在先进封装领域的突破

需要一个详细的技术路线对比表。`,
    expectedTools: ["web_search", "web_fetch"],
    expectedDistillerTargets: ["search_results", "web_fetch_content"],
  },
  {
    id: 11,
    domain: "产业研究",
    title: "合成生物学商业化全景",
    source: "SynBioBeta + Nature Biotechnology + 生物探索",
    prompt: `请搜索并整理合成生物学（Synthetic Biology）行业的商业化进展：
1. 2025-2026年融资/IPO事件（Ginkgo Bioworks、Zymergen后续、Twist Bioscience等）
2. AI+合成生物学：蛋白质设计AI公司（Profluent、EvolutionaryScale）的最新成果
3. 商业化成功案例：哪些合成生物产品已经实现大规模生产（生物基材料、食品添加剂、药物中间体）
4. 中国合成生物学公司（华恒生物、凯赛生物、蓝晶微生物）的发展状况

写一份产业白皮书的摘要。`,
    expectedTools: ["web_search", "web_fetch", "exec(tavily)"],
    expectedDistillerTargets: ["search_results", "api_response"],
  },
  {
    id: 12,
    domain: "产业研究",
    title: "边缘AI芯片市场分析",
    source: "EE Times + 半导体行业观察 + The Information",
    prompt: `请深入分析边缘AI推理芯片市场：
1. 搜索高通、联发科、瑞芯微、地平线在端侧AI芯片的最新产品和性能数据（TOPS/W）
2. NPU vs GPU vs 专用加速器在边缘推理场景的TCO对比
3. 主要应用市场（手机、汽车ADAS、IoT、机器人）的芯片需求预测
4. 苹果M系列芯片Neural Engine对市场格局的影响

整理成一份给VC的行业分析备忘录。`,
    expectedTools: ["web_search", "web_fetch"],
    expectedDistillerTargets: ["search_results", "data_output"],
  },

  // ════════════════════════════════════════════════════════════════════════
  // Domain 4: 复杂需求分析 (Complex Requirements Analysis)
  // ════════════════════════════════════════════════════════════════════════
  {
    id: 13,
    domain: "需求分析",
    title: "跨境电商合规架构设计",
    source: "V2EX + 亚马逊卖家论坛 + Shopify community",
    prompt: `我们公司要搭建一个面向欧美市场的跨境电商平台（类似SHEIN模式），请帮我分析：
1. 搜索2025-2026年欧盟数字服务法案(DSA)和美国各州数据隐私法对跨境电商的合规要求
2. GDPR合规的技术架构要求：数据本地化、cookie consent、right to deletion的实现方案
3. 支付合规：PCI-DSS 4.0、SCA（强客户认证）的技术实现要点
4. 税务合规：欧盟VAT IOSS、美国各州sales tax的自动化计算方案

输出一份技术合规检查清单。`,
    expectedTools: ["web_search", "web_fetch", "exec(tavily)"],
    expectedDistillerTargets: ["search_results", "web_fetch_content"],
  },
  {
    id: 14,
    domain: "需求分析",
    title: "百万DAU社交App消息系统架构",
    source: "InfoQ + 高可用架构 + Discord engineering blog",
    prompt: `我们要设计一个支撑百万DAU的即时通讯系统，请搜索并分析：
1. 主流IM系统的技术选型：搜索Discord、Telegram、微信技术架构的公开资料
2. 消息协议选择：MQTT vs WebSocket vs gRPC streaming的性能对比数据
3. 消息存储方案：搜索TiDB、ScyllaDB、FoundationDB在消息场景的基准测试
4. 消息投递保证：exactly-once delivery在分布式系统中的实现方案

输出一份架构决策文档(ADR)。`,
    expectedTools: ["web_search", "web_fetch"],
    expectedDistillerTargets: ["search_results", "api_response"],
  },
  {
    id: 15,
    domain: "需求分析",
    title: "多模态RAG系统选型",
    source: "LlamaIndex community + LangChain Discord + Hugging Face forum",
    prompt: `我们团队要构建一个多模态RAG系统，能处理PDF文档、图表、表格和代码：
1. 搜索LlamaIndex、LangChain、Haystack在多模态RAG方面的最新功能对比
2. 向量数据库选型：Milvus vs Qdrant vs Weaviate vs Chroma的多模态索引支持
3. 文档解析方案：Unstructured.io、DocTR、Marker、MinerU的OCR+表格提取性能对比
4. ColPali/ColQwen等late-interaction模型在文档检索中的实际效果

给出技术选型建议和PoC实现路线图。`,
    expectedTools: ["web_search", "web_fetch", "exec(tavily)"],
    expectedDistillerTargets: ["search_results", "web_fetch_content"],
  },
  {
    id: 16,
    domain: "需求分析",
    title: "金融级分布式事务方案",
    source: "TiDB community + OceanBase forum + 支付宝技术团队blog",
    prompt: `我们正在设计一个金融交易系统的分布式事务方案：
1. 搜索蚂蚁金服DTX、Seata、TCC模式在真实金融场景的实践案例
2. 对比XA、Saga、TCC、AT四种分布式事务模式在不同场景下的适用性
3. 搜索高频交易场景下的事务延迟基准数据（P99 latency）
4. 数据一致性 vs 可用性 tradeoff：搜索CAP定理在实际金融系统中的工程实践

输出一份技术方案评估报告。`,
    expectedTools: ["web_search", "web_fetch"],
    expectedDistillerTargets: ["search_results", "api_response"],
  },

  // ════════════════════════════════════════════════════════════════════════
  // Domain 5: 技术实现方案 (Technical Implementation Plans)
  // ════════════════════════════════════════════════════════════════════════
  {
    id: 17,
    domain: "技术方案",
    title: "K8s GPU调度与推理服务优化",
    source: "CNCF blog + r/kubernetes + AWS re:Invent talks",
    prompt: `我需要在Kubernetes集群上部署LLM推理服务，请搜索：
1. NVIDIA GPU Operator + MIG (Multi-Instance GPU) 在K8s中的配置最佳实践
2. vLLM vs TGI vs TensorRT-LLM 的推理吞吐量对比（Llama 70B, 8*A100）
3. KServe vs Triton Inference Server vs Ray Serve 的自动扩缩容策略对比
4. GPU共享方案：搜索RunAI、Volcano、HAMi在多租户场景下的GPU利用率数据

给出完整的部署方案和性能优化清单。`,
    expectedTools: ["web_search", "web_fetch", "exec(tavily)"],
    expectedDistillerTargets: ["search_results", "web_fetch_content"],
  },
  {
    id: 18,
    domain: "技术方案",
    title: "实时数据管道：Kafka to Lakehouse",
    source: "Confluent blog + Databricks community + dbt Slack",
    prompt: `帮我设计一个从Kafka到Lakehouse的实时数据管道：
1. 搜索Apache Kafka + Flink CDC vs Debezium + Kafka Connect 的实时数据同步方案对比
2. Lakehouse格式选型：Delta Lake vs Apache Iceberg vs Apache Hudi的最新功能对比（2025-2026）
3. Streaming ETL框架：Flink vs Spark Structured Streaming vs Materialize的延迟和吞吐对比
4. Schema evolution和time travel在三种Lakehouse格式中的实现差异

输出一份架构设计文档，包含组件选型理由。`,
    expectedTools: ["web_search", "web_fetch"],
    expectedDistillerTargets: ["search_results", "api_response"],
  },
  {
    id: 19,
    domain: "技术方案",
    title: "零信任安全架构实施方案",
    source: "NIST SP 800-207 + Cloudflare blog + Zscaler community",
    prompt: `我们公司要实施零信任安全架构，请搜索并分析：
1. NIST零信任架构框架的最新实施指南（SP 800-207 2nd edition）
2. BeyondCorp（Google）vs SASE（Zscaler/Cloudflare）vs ZTNA（Palo Alto）的方案对比
3. 微分段(Microsegmentation)的开源方案：Cilium + Network Policy vs Calico vs Istio AuthorizationPolicy
4. 设备信任评估：搜索 device posture check 的实现方案和主流供应商

输出一份分阶段实施路线图。`,
    expectedTools: ["web_search", "web_fetch", "exec(tavily)"],
    expectedDistillerTargets: ["search_results", "web_fetch_content"],
  },
  {
    id: 20,
    domain: "技术方案",
    title: "WebAssembly边缘计算平台",
    source: "Bytecode Alliance + Fermyon blog + Fastly compute blog",
    prompt: `我们想用WebAssembly构建边缘计算平台：
1. 搜索Spin (Fermyon) vs Wasmtime vs WasmEdge vs Wasmer在边缘计算场景的性能对比
2. WASI Preview 2 (Component Model)的最新进展和生态成熟度
3. 搜索Fastly Compute、Cloudflare Workers、Vercel Edge Functions的Wasm运行时实现差异
4. Wasm在AI推理边缘部署中的应用案例（ONNX Runtime + Wasm）

输出一份技术可行性评估报告。`,
    expectedTools: ["web_search", "web_fetch"],
    expectedDistillerTargets: ["search_results", "api_response"],
  },
];

// ── Gateway API Helpers ────────────────────────────────────────────────────

interface StatsSnapshot {
  totalDistillations: number;
  totalTokensSaved: number;
  totalMessagesProcessed: number;
  ruleHits: Record<string, number>;
  loadCount: number;
}

function readStats(): StatsSnapshot {
  try {
    const raw = fs.readFileSync(STATS_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { totalDistillations: 0, totalTokensSaved: 0, totalMessagesProcessed: 0, ruleHits: {}, loadCount: 0 };
  }
}

async function createSession(): Promise<string> {
  const sessionId = `test-case-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  return sessionId;
}

interface ResponseResult {
  response: string;
  toolCalls: Array<{ tool: string; resultLength: number }>;
  totalInputTokens: number;
  totalOutputTokens: number;
  duration: number;
}

async function sendToJarvis(sessionId: string, prompt: string, timeoutMs: number = 300_000): Promise<ResponseResult> {
  const start = Date.now();

  const body = {
    model: "main",
    input: prompt,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${GATEWAY_URL}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${AUTH_TOKEN}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json() as {
      output?: Array<{
        type: string;
        content?: Array<{ type: string; text?: string }>;
        name?: string;
        arguments?: string;
        output?: string;
      }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    // Extract response text and tool calls
    let responseText = "";
    const toolCalls: ResponseResult["toolCalls"] = [];

    if (data.output) {
      for (const item of data.output) {
        if (item.type === "message" && item.content) {
          for (const block of item.content) {
            if (block.type === "output_text" && block.text) {
              responseText += block.text;
            }
          }
        }
        if (item.type === "function_call") {
          toolCalls.push({
            tool: item.name ?? "unknown",
            resultLength: item.output?.length ?? 0,
          });
        }
      }
    }

    return {
      response: responseText,
      toolCalls,
      totalInputTokens: data.usage?.input_tokens ?? 0,
      totalOutputTokens: data.usage?.output_tokens ?? 0,
      duration: Date.now() - start,
    };
  } catch (err) {
    clearTimeout(timeout);
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      response: `[ERROR] ${errMsg}`,
      toolCalls: [],
      totalInputTokens: 0,
      totalOutputTokens: 0,
      duration: Date.now() - start,
    };
  }
}

// ── Main Test Runner ───────────────────────────────────────────────────────

interface CaseResult {
  caseId: number;
  domain: string;
  title: string;
  source: string;
  sessionId: string;
  // Distiller metrics
  distillationsBefore: number;
  distillationsAfter: number;
  distillationsTriggered: number;
  tokensSavedBefore: number;
  tokensSavedAfter: number;
  tokensSavedThisCase: number;
  ruleHitsDelta: Record<string, number>;
  // Response metrics
  responseLength: number;
  toolCallCount: number;
  toolCalls: Array<{ tool: string; resultLength: number }>;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  // Quality
  hasError: boolean;
  responsePreview: string;
}

async function runCase(tc: TestCase): Promise<CaseResult> {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`[Case ${tc.id}/${TEST_CASES.length}] ${tc.domain}: ${tc.title}`);
  console.log(`Source: ${tc.source}`);
  console.log(`${"─".repeat(70)}`);

  // Snapshot stats BEFORE
  const statsBefore = readStats();

  // Create session and send prompt
  const sessionId = await createSession();
  console.log(`Session: ${sessionId}`);
  console.log(`Sending prompt (${tc.prompt.length} chars)...`);

  const result = await sendToJarvis(sessionId, tc.prompt);

  // Wait a moment for stats to flush (5s throttle in stats-store.ts)
  await new Promise(r => setTimeout(r, 2000));

  // Snapshot stats AFTER
  const statsAfter = readStats();

  // Calculate deltas
  const distillationsTriggered = statsAfter.totalDistillations - statsBefore.totalDistillations;
  const tokensSavedThisCase = statsAfter.totalTokensSaved - statsBefore.totalTokensSaved;

  const ruleHitsDelta: Record<string, number> = {};
  for (const [rule, count] of Object.entries(statsAfter.ruleHits)) {
    const before = statsBefore.ruleHits[rule] ?? 0;
    if (count > before) {
      ruleHitsDelta[rule] = count - before;
    }
  }

  const hasError = result.response.startsWith("[ERROR]");
  const responsePreview = result.response.slice(0, 300).replace(/\n/g, " ").trim();

  // Print summary
  console.log(`\n📊 Results:`);
  console.log(`  Duration: ${(result.duration / 1000).toFixed(1)}s`);
  console.log(`  Tool calls: ${result.toolCalls.length}`);
  for (const tc2 of result.toolCalls) {
    console.log(`    - ${tc2.tool} (result: ${tc2.resultLength} chars)`);
  }
  console.log(`  Response length: ${result.response.length} chars`);
  console.log(`  Tokens: input=${result.totalInputTokens}, output=${result.totalOutputTokens}`);
  console.log(`\n🔧 Distiller:`);
  console.log(`  Distillations triggered: ${distillationsTriggered}`);
  console.log(`  Tokens saved: ${tokensSavedThisCase.toLocaleString()}`);
  if (Object.keys(ruleHitsDelta).length > 0) {
    console.log(`  Rules hit:`);
    for (const [rule, count] of Object.entries(ruleHitsDelta)) {
      console.log(`    - ${rule}: ${count}x`);
    }
  } else {
    console.log(`  Rules hit: (none)`);
  }
  if (hasError) {
    console.log(`  ⚠️ ERROR: ${responsePreview}`);
  }

  return {
    caseId: tc.id,
    domain: tc.domain,
    title: tc.title,
    source: tc.source,
    sessionId,
    distillationsBefore: statsBefore.totalDistillations,
    distillationsAfter: statsAfter.totalDistillations,
    distillationsTriggered,
    tokensSavedBefore: statsBefore.totalTokensSaved,
    tokensSavedAfter: statsAfter.totalTokensSaved,
    tokensSavedThisCase,
    ruleHitsDelta,
    responseLength: result.response.length,
    toolCallCount: result.toolCalls.length,
    toolCalls: result.toolCalls,
    inputTokens: result.totalInputTokens,
    outputTokens: result.totalOutputTokens,
    durationMs: result.duration,
    hasError,
    responsePreview,
  };
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  Context Distiller — 20 Real-World Cases Live Test             ║");
  console.log("║  Testing across 5 domains with realistic user behavior          ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝\n");

  // Check gateway health
  try {
    const healthRes = await fetch(`${GATEWAY_URL}/health`);
    const health = await healthRes.json() as { ok: boolean };
    if (!health.ok) throw new Error("Gateway not healthy");
    console.log("✅ Gateway is healthy\n");
  } catch (err) {
    console.error("❌ Gateway not reachable:", err);
    process.exit(1);
  }

  // Record baseline stats
  const baselineStats = readStats();
  console.log(`📈 Baseline stats:`);
  console.log(`  Total distillations: ${baselineStats.totalDistillations}`);
  console.log(`  Total tokens saved: ${baselineStats.totalTokensSaved.toLocaleString()}`);
  console.log(`  Load count: ${baselineStats.loadCount}\n`);

  const results: CaseResult[] = [];
  const startTime = Date.now();

  // Run all cases sequentially
  for (const tc of TEST_CASES) {
    try {
      const result = await runCase(tc);
      results.push(result);
    } catch (err) {
      console.error(`\n❌ Case ${tc.id} failed:`, err);
      results.push({
        caseId: tc.id,
        domain: tc.domain,
        title: tc.title,
        source: tc.source,
        sessionId: "N/A",
        distillationsBefore: 0,
        distillationsAfter: 0,
        distillationsTriggered: 0,
        tokensSavedBefore: 0,
        tokensSavedAfter: 0,
        tokensSavedThisCase: 0,
        ruleHitsDelta: {},
        responseLength: 0,
        toolCallCount: 0,
        toolCalls: [],
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
        hasError: true,
        responsePreview: `[CRASH] ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Brief pause between cases to avoid rate limiting
    await new Promise(r => setTimeout(r, 3000));
  }

  const totalDuration = Date.now() - startTime;
  const finalStats = readStats();

  // ── Generate Report ──────────────────────────────────────────────────────

  console.log("\n\n" + "═".repeat(70));
  console.log("                    FINAL REPORT");
  console.log("═".repeat(70));

  // Summary table
  const domains = ["投资研究", "学术研究", "产业研究", "需求分析", "技术方案"];
  for (const domain of domains) {
    const domainResults = results.filter(r => r.domain === domain);
    console.log(`\n─── ${domain} ───`);
    for (const r of domainResults) {
      const status = r.hasError ? "❌" : "✅";
      console.log(
        `  ${status} Case ${r.caseId}: ${r.title}` +
        ` | ${r.distillationsTriggered} distill, ${r.tokensSavedThisCase} saved` +
        ` | ${r.toolCallCount} tools, ${(r.durationMs / 1000).toFixed(0)}s`,
      );
    }
  }

  // Overall statistics
  const totalDistillations = results.reduce((s, r) => s + r.distillationsTriggered, 0);
  const totalTokensSaved = results.reduce((s, r) => s + r.tokensSavedThisCase, 0);
  const totalToolCalls = results.reduce((s, r) => s + r.toolCallCount, 0);
  const totalErrors = results.filter(r => r.hasError).length;

  const allRuleHits: Record<string, number> = {};
  for (const r of results) {
    for (const [rule, count] of Object.entries(r.ruleHitsDelta)) {
      allRuleHits[rule] = (allRuleHits[rule] ?? 0) + count;
    }
  }

  console.log(`\n${"═".repeat(70)}`);
  console.log(`OVERALL METRICS:`);
  console.log(`  Cases: ${results.length} (${results.length - totalErrors} success, ${totalErrors} errors)`);
  console.log(`  Total duration: ${(totalDuration / 1000 / 60).toFixed(1)} minutes`);
  console.log(`  Total tool calls: ${totalToolCalls}`);
  console.log(`  Total distillations: ${totalDistillations}`);
  console.log(`  Total tokens saved: ${totalTokensSaved.toLocaleString()}`);
  console.log(`  Avg tokens saved per case: ${totalDistillations > 0 ? Math.round(totalTokensSaved / results.length).toLocaleString() : "N/A"}`);
  console.log(`\nDistiller lifetime (from start of all testing):`);
  console.log(`  Total distillations: ${finalStats.totalDistillations}`);
  console.log(`  Total tokens saved: ${finalStats.totalTokensSaved.toLocaleString()}`);
  console.log(`  Total loads: ${finalStats.loadCount}`);
  console.log(`\nRule distribution:`);
  for (const [rule, count] of Object.entries(allRuleHits).sort((a, b) => b[1] - a[1])) {
    const pct = ((count / totalDistillations) * 100).toFixed(1);
    console.log(`  ${rule}: ${count} (${pct}%)`);
  }

  // ── Write detailed report to file ──────────────────────────────────────

  const reportPath = "/Users/gaoyuan/WorkBuddy/Claw/distiller-20cases-report.md";
  const report = generateMarkdownReport(results, baselineStats, finalStats, totalDuration, allRuleHits);
  fs.writeFileSync(reportPath, report, "utf-8");
  console.log(`\n📝 Detailed report saved to: ${reportPath}`);

  // Write raw JSON data
  const jsonPath = "/Users/gaoyuan/WorkBuddy/Claw/distiller-20cases-data.json";
  fs.writeFileSync(jsonPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    baselineStats,
    finalStats,
    totalDuration,
    results,
    allRuleHits,
  }, null, 2), "utf-8");
  console.log(`📊 Raw data saved to: ${jsonPath}`);
}

function generateMarkdownReport(
  results: CaseResult[],
  baselineStats: StatsSnapshot,
  finalStats: StatsSnapshot,
  totalDuration: number,
  allRuleHits: Record<string, number>,
): string {
  const totalDistillations = results.reduce((s, r) => s + r.distillationsTriggered, 0);
  const totalTokensSaved = results.reduce((s, r) => s + r.tokensSavedThisCase, 0);
  const totalToolCalls = results.reduce((s, r) => s + r.toolCallCount, 0);
  const totalErrors = results.filter(r => r.hasError).length;

  let md = `# Context Distiller — 20 真实案例测试报告

> 测试时间: ${new Date().toISOString()}
> 总耗时: ${(totalDuration / 1000 / 60).toFixed(1)} 分钟

## 测试概述

通过 OpenClaw Responses API 向 Jarvis agent 发送 20 个来自真实用户社区的研究类提问，
模拟投资分析师、研究员、架构师、产品经理的真实工作流。每个案例触发搜索、网页抓取等
工具调用，观测 context-distiller 插件对工具输出的蒸馏效果。

### 案例来源
- **投资研究**: Reddit r/investing, r/algotrading, 雪球, Bloomberg forum
- **学术研究**: arXiv, Semantic Scholar, r/MachineLearning, 知乎学术圈
- **产业研究**: HackerNews, 36氪, SemiAnalysis, Nature Biotechnology
- **需求分析**: V2EX, InfoQ, LlamaIndex/LangChain community, TiDB community
- **技术方案**: CNCF blog, r/kubernetes, Confluent, Cloudflare, Bytecode Alliance

## 总体结果

| 指标 | 数值 |
|------|------|
| 总案例数 | ${results.length} |
| 成功 / 失败 | ${results.length - totalErrors} / ${totalErrors} |
| 总耗时 | ${(totalDuration / 1000 / 60).toFixed(1)} 分钟 |
| 总工具调用 | ${totalToolCalls} |
| **蒸馏触发次数** | **${totalDistillations}** |
| **节省 token 总数** | **${totalTokensSaved.toLocaleString()}** |
| 平均每案例节省 | ${results.length > 0 ? Math.round(totalTokensSaved / results.length).toLocaleString() : "N/A"} |

### 基线 vs 最终统计
| | 测试前 | 测试后 | 增量 |
|--|--------|--------|------|
| 累计蒸馏 | ${baselineStats.totalDistillations} | ${finalStats.totalDistillations} | +${finalStats.totalDistillations - baselineStats.totalDistillations} |
| 累计节省 tokens | ${baselineStats.totalTokensSaved.toLocaleString()} | ${finalStats.totalTokensSaved.toLocaleString()} | +${(finalStats.totalTokensSaved - baselineStats.totalTokensSaved).toLocaleString()} |
| 插件加载次数 | ${baselineStats.loadCount} | ${finalStats.loadCount} | +${finalStats.loadCount - baselineStats.loadCount} |

## 规则命中分布

| 规则 | 命中次数 | 占比 |
|------|----------|------|
${Object.entries(allRuleHits)
  .sort((a, b) => b[1] - a[1])
  .map(([rule, count]) => `| ${rule} | ${count} | ${totalDistillations > 0 ? ((count / totalDistillations) * 100).toFixed(1) : 0}% |`)
  .join("\n")}

## 分域详细结果

`;

  const domains = [
    { name: "投资研究分析", emoji: "💰" },
    { name: "学术课题研究", emoji: "📚" },
    { name: "产业/科技深度研究", emoji: "🏭" },
    { name: "复杂需求分析", emoji: "📋" },
    { name: "技术实现方案", emoji: "⚙️" },
  ];
  const domainMap: Record<string, string> = {
    "投资研究": "投资研究分析",
    "学术研究": "学术课题研究",
    "产业研究": "产业/科技深度研究",
    "需求分析": "复杂需求分析",
    "技术方案": "技术实现方案",
  };

  for (const domain of domains) {
    const domainResults = results.filter(r => domainMap[r.domain] === domain.name);
    if (domainResults.length === 0) continue;

    md += `### ${domain.emoji} ${domain.name}\n\n`;
    md += `| # | 标题 | 蒸馏次数 | 节省 tokens | 工具调用 | 耗时 | 状态 |\n`;
    md += `|---|------|----------|-------------|----------|------|------|\n`;

    for (const r of domainResults) {
      const status = r.hasError ? "❌" : "✅";
      md += `| ${r.caseId} | ${r.title} | ${r.distillationsTriggered} | ${r.tokensSavedThisCase.toLocaleString()} | ${r.toolCallCount} | ${(r.durationMs / 1000).toFixed(0)}s | ${status} |\n`;
    }

    md += `\n`;

    for (const r of domainResults) {
      md += `#### Case ${r.caseId}: ${r.title}\n\n`;
      md += `- **来源**: ${r.source}\n`;
      md += `- **Session**: \`${r.sessionId}\`\n`;
      md += `- **工具调用**: ${r.toolCallCount} 次\n`;
      if (r.toolCalls.length > 0) {
        for (const tc of r.toolCalls) {
          md += `  - \`${tc.tool}\` → ${tc.resultLength} chars\n`;
        }
      }
      md += `- **蒸馏**: ${r.distillationsTriggered} 次，节省 ${r.tokensSavedThisCase.toLocaleString()} tokens\n`;
      if (Object.keys(r.ruleHitsDelta).length > 0) {
        md += `- **规则命中**:\n`;
        for (const [rule, count] of Object.entries(r.ruleHitsDelta)) {
          md += `  - ${rule}: ${count}x\n`;
        }
      }
      md += `- **响应长度**: ${r.responseLength} chars\n`;
      md += `- **Token 使用**: input=${r.inputTokens}, output=${r.outputTokens}\n`;
      md += `- **耗时**: ${(r.durationMs / 1000).toFixed(1)}s\n`;
      if (r.hasError) {
        md += `- **⚠️ 错误**: ${r.responsePreview}\n`;
      } else {
        md += `- **响应预览**: ${r.responsePreview.slice(0, 200)}…\n`;
      }
      md += `\n`;
    }
  }

  md += `## 观测分析

### 插件效果评估

#### 1. 搜索结果蒸馏
- smart/search-results 规则在搜索结果中的表现
- 搜索结果 URL/标题/摘要是否被正确保留
- 与之前 P0 修复前（6 tokens 灾难）的对比

#### 2. 大文件蒸馏
- file-content-distill 在代码/配置文件上的压缩效率
- code-structure 规则是否保留了关键的 import/定义

#### 3. 重复内容消除
- repetition-elimination 在 API 多次调用中的效果
- 日志/安装输出的去重表现

#### 4. 错误提取
- error-extraction 是否正确保留了关键错误信息
- 构建日志中间错误行是否被丢失

### 已知限制
- head+tail 截断仍会丢失中间内容（非搜索类工具输出）
- Gateway 每次请求重新加载 plugin，session 统计为 0
- stats 写入有 5 秒节流，快速连续蒸馏可能漏记

---

*报告由 context-distiller test suite 自动生成*
`;

  return md;
}

main().catch(console.error);
