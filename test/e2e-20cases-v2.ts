/**
 * e2e-20cases-v2.ts — 基于真实社区案例的 20 个 Live 测试
 * 
 * 改进点（vs v1）：
 * 1. 所有案例从真实社区帖子提取/改写（雪球/知乎/Reddit/HN/V2EX/SegmentFault）
 * 2. 需求分析/技术方案类用例模拟用户粘贴代码/配置/日志的行为
 * 3. 投资/学术/产业类用例引用具体数据源和时间点
 * 4. 测试 distiller v2 改进：api_response budgetMultiplier 4.0 + 段落保留
 */

const API_BASE = "http://localhost:18789/v1/responses";
const API_KEY = "3e71ac6673930b831f944d2782e1bd2a8df5a3f64ece0298";

interface ResponseResult {
  ok: boolean;
  output: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  toolCalls: number;
}

interface TestCase {
  id: number;
  category: string;
  source: string;  // 来源社区
  title: string;
  prompt: string;
}

// ── 20 Real-World Test Cases ──────────────────────────────────────────────

const testCases: TestCase[] = [
  // ━━━ 投资研究分析 (4) — 来源: 雪球/Seeking Alpha/Reddit r/investing ━━━
  {
    id: 1,
    category: "投资研究",
    source: "雪球 @储能研究员",
    title: "储能行业2026年核心增长逻辑分析",
    prompt: `我看到雪球上有篇帖子说"AI电力瓶颈+欧洲能源缺口+电网改造需求"是储能行业的三大不可逆驱动力。

请帮我深入研究：
1. 2025-2026年全球储能装机量数据（GWh），分区域（中国/美国/欧洲）对比
2. 宁德时代、比亚迪、阳光电源在储能业务的最新营收和市占率
3. AI数据中心对储能的需求具体有多大？有没有具体的电力消耗预测数据？
4. 储能行业的估值水平（PE/PS）和投资风险点

请搜索最新数据，给出有数据支撑的分析报告。`,
  },
  {
    id: 2,
    category: "投资研究",
    source: "Seeking Alpha + Reddit r/investing",
    title: "新兴市场债券ETF配置评估",
    prompt: `Seeking Alpha 最近一篇文章说 "Why Investors Should Consider An Emerging Markets Bonds Allocation In 2026"，认为新兴市场债券在2025年跑赢了美国和全球债券。

帮我做个完整的新兴市场债券配置分析：
1. 搜索主要新兴市场债券ETF的2025年表现数据（EMB、VWOB、EBND、PCY）
2. 目前新兴市场vs发达市场的利差是多少？历史分位在什么水平？
3. 哪些新兴市场国家的主权评级在改善？哪些在恶化？
4. 地缘政治风险（特别是关税政策）对新兴市场债的影响
5. 给一个资产配置建议：一个100万美元的组合中应该配多少比例的新兴市场债？

需要引用具体数据源。`,
  },
  {
    id: 3,
    category: "投资研究",
    source: "雪球量化社区 + 知乎",
    title: "A股动量因子失效原因与改进策略",
    prompt: `知乎和雪球上很多量化交易者讨论动量因子在A股长期失效的问题。有人说"2019年美股也出现了动量崩盘，多家量化基金因集体平仓遭受重大亏损"。

帮我做一个系统性研究：
1. 搜索动量因子在A股的历史回测数据，真的是长期负收益吗？
2. 动量失效的4个主要原因是什么？（因子拥挤、市场微观结构、散户比例等）
3. 搜索2025年学术界或业界对"因子漂移"的最新研究
4. 有哪些改进的动量策略（如行业动量vs个股动量、动量+反转组合）？
5. 给一个可以在A股回测的因子改进方案

请务必搜索真实的学术论文和量化社区讨论。`,
  },
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

  // ━━━ 学术课题研究 (4) — 来源: 知乎/arXiv/Nature/PubMed ━━━
  {
    id: 5,
    category: "学术研究",
    source: "知乎蛋白质深度学习专栏 + Nature MI",
    title: "蛋白质语言模型与药物设计综述",
    prompt: `知乎上有篇专栏文章说"深度学习领域的快速发展对蛋白质设计产生了重大影响，形成了可用于数百万种蛋白质的高质量模型"。Nature Machine Intelligence 也发了蛋白质功能特性学习方法的综合调查。

请帮我做一个学术文献综述：
1. 搜索2024-2026年蛋白质语言模型的代表性工作（ESM-2、ProtTrans、AlphaFold3等）
2. 这些模型在药物设计中的具体应用案例
3. 搜索 arXiv 上最新的蛋白质-配体对接预测方法
4. 当前的主要技术挑战是什么？（数据不足、泛化性、计算成本）
5. 列出该领域的top研究团队和实验室

需要引用具体论文标题和作者。`,
  },
  {
    id: 6,
    category: "学术研究",
    source: "arXiv + ICLR 2026",
    title: "多模态RAG系统最新研究进展",
    prompt: `arXiv 2025年初出现了大量多模态RAG的论文，包括MA-RAG、VisRAG、M3-RAG等。REAL-MM-RAG提出了一个新的benchmark。

帮我梳理最新的多模态RAG研究：
1. 搜索2025-2026年多模态RAG的代表性论文，按方法分类
2. 与纯文本RAG相比，多模态RAG的核心技术难点在哪？
3. 搜索目前开源的多模态RAG框架和实现（GitHub上的项目）
4. 向量检索 vs 重排序 vs 生成融合这三个环节的最新技术方案
5. 从工程角度，构建一个生产级多模态RAG系统需要什么技术栈？

请给出一份可以直接用于研究提案背景部分的综述。`,
  },
  {
    id: 7,
    category: "学术研究",
    source: "ResearchGate + IEEE",
    title: "WebAssembly在零信任边缘计算中的安全机制",
    prompt: `IEEE最近发表了一篇"Lightweight WebAssembly-Based Intrusion Detection for Zero Trust Edge"论文，NIST也在2025年6月发布了SP 1800-35零信任架构实施指南。

请帮我做一个交叉领域的文献研究：
1. 搜索WebAssembly (Wasm) 在边缘计算部署中的最新研究（2024-2026）
2. NIST SP 800-207 和 SP 1800-35 零信任架构的核心要求是什么？
3. Wasm的安全沙箱机制如何与零信任原则结合？
4. 搜索已有的Wasm + 零信任边缘安全方案（学术和工业界）
5. 与传统容器化方案（Docker/K8s）相比，Wasm的安全优势和局限

需要具体论文引用和标准文档编号。`,
  },
  {
    id: 8,
    category: "学术研究",
    source: "CCAI 2026 + 物理学报",
    title: "碳捕获技术的经济可行性与技术路线对比",
    prompt: `物理学报和Nature Energy 最近都有关于碳捕获（CCUS）的综述文章。有数据称2025年全球碳捕获能力已超过50MtCO2/年。

帮我系统研究碳捕获技术：
1. 搜索2025-2026年全球CCUS项目的最新装机数据和分布
2. DAC（直接空气捕获）vs 点源捕获的成本对比（$/吨CO2）
3. Climeworks、Carbon Engineering、Global Thermostat等头部公司的最新进展
4. 中国的CCUS项目进展（特别是大庆、胜利油田的项目）
5. 碳捕获的经济性拐点在哪里？碳价格需要到多少才能盈亏平衡？

请搜索真实数据并给出量化分析。`,
  },

  // ━━━ 产业/科技深度研究 (4) — 来源: 36氪/SemiAnalysis/HackerNews ━━━
  {
    id: 9,
    category: "产业研究",
    source: "知乎 CoWoS专栏 + SemiAnalysis",
    title: "台积电CoWoS先进封装产业链深度分析",
    prompt: `知乎上有篇非常详细的文章"ECTC半导体封装顶会系列：台积电CoWoS近十年发展路径"。东方证券也出了CoWoS五问五答的研报。台积电2024年底月产能才1.2万片，只能生产30多万颗AI芯片。

请深入分析CoWoS产业链：
1. 搜索台积电CoWoS 2025-2026年的产能扩张计划和实际进度
2. CoWoS vs CoPoS vs 3D IC vs Chiplet 不同封装路线的技术对比
3. CoWoS产业链上的关键设备和材料供应商（特别是国产替代情况）
4. 搜索长电科技、通富微电等国内封装厂在先进封装的布局
5. AI芯片封装需求增长预测 vs 实际产能gap

请给出产业投资角度的深度研究报告。`,
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
    id: 11,
    category: "产业研究",
    source: "36氪 + 合成生物学社区",
    title: "合成生物学商业化进展与投资机会",
    prompt: `合成生物学被认为是继AI之后的下一个超级赛道。有报告称2025年全球合成生物学市场规模超过200亿美元。

请做一个产业深度研究：
1. 搜索2025-2026年合成生物学领域的融资事件和IPO
2. 全球top合成生物学公司的营收和管线进展（Ginkgo Bioworks、Amyris、Zymergen的后续发展）
3. 中国合成生物学企业的进展（恩和生物、弈柯莱、蓝晶微生物等）
4. AI+合成生物（如蛋白质设计、代谢通路优化）的交叉应用
5. 哪些下游应用最有可能率先实现大规模商业化？（食品、材料、医药）

请搜索最新数据。`,
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

  // ━━━ 复杂需求分析 (4) — 来源: V2EX/SegmentFault/InfoQ (模拟粘贴代码/配置) ━━━
  {
    id: 13,
    category: "需求分析",
    source: "V2EX技术求助 + CSDN",
    title: "高并发电商秒杀系统的架构设计",
    prompt: `我在V2EX上看到很多关于秒杀系统设计的讨论。我们现在有一个电商项目，预期双11峰值QPS 50万，当前架构扛不住。

现有架构信息：
\`\`\`yaml
services:
  api-gateway: nginx (单实例)
  application: Spring Boot 2.7 (3个实例, 8核16G)
  cache: Redis 6.0 (主从, 16G)
  database: MySQL 8.0 (单主, 64G)
  message-queue: RabbitMQ (3节点镜像集群)

current_metrics:
  avg_qps: 2000
  peak_qps: 8000
  p99_latency: 450ms
  error_rate: 0.3%
  
bottlenecks:
  - MySQL主库CPU 95%在峰值
  - Redis单实例内存不足
  - RabbitMQ消息堆积严重
\`\`\`

我的具体问题：
1. 从2000 QPS到50万QPS，架构需要怎样的演进路径？
2. 搜索业界主流的秒杀架构方案（如预扣库存、令牌桶限流、异步下单）
3. Redis Cluster vs Codis vs Twemproxy 在这个场景下如何选？
4. 数据库层面需要分库分表吗？用ShardingSphere还是Vitess？
5. 给一个完整的架构升级方案，包括预估成本

请搜索真实的高并发架构最佳实践。`,
  },
  {
    id: 14,
    category: "需求分析",
    source: "SegmentFault + TiDB社区",
    title: "从MySQL迁移到分布式数据库的方案评估",
    prompt: `我们公司有一个核心业务系统，数据量已经超过10亿行，MySQL单表性能严重下降。DBA团队提议迁移到TiDB，但也有人建议用CockroachDB或者继续用MySQL分库分表。

当前数据库状况：
\`\`\`sql
-- 主要大表
orders: 12亿行, 单表420GB, 日增300万
order_items: 35亿行, 单表890GB
user_events: 80亿行, 1.2TB, 查询以范围查询为主

-- 当前问题
-- 1. 慢查询: SELECT COUNT(*) FROM orders WHERE created_at > '2025-01-01' 
--    耗时 > 30s
-- 2. DDL锁表: ALTER TABLE orders ADD INDEX idx_status (status)
--    预计锁表 > 4小时
-- 3. 备份: mysqldump全量备份需要12小时

-- 业务要求
-- 读写比: 7:3
-- 事务要求: 订单相关需要强一致性
-- 查询模式: 70% OLTP + 30% OLAP (报表)
\`\`\`

请帮我做技术选型分析：
1. 搜索TiDB vs CockroachDB vs MySQL + ShardingSphere的最新对比
2. 10亿行级别的迁移方案和预估时间
3. HTAP场景下各方案的性能基准测试数据
4. 迁移过程中的数据一致性保障方案
5. 给出推荐方案和完整的迁移路线图`,
  },
  {
    id: 15,
    category: "需求分析",
    source: "InfoQ + LlamaIndex社区",
    title: "企业级知识库RAG系统的完整技术方案",
    prompt: `我们需要为一个有20万份文档（PDF/Word/PPT，总共约50GB）的企业建一个知识库问答系统。看了InfoQ和LlamaIndex社区的很多讨论，方案太多不知道怎么选。

需求细节：
\`\`\`json
{
  "documents": {
    "count": 200000,
    "formats": ["pdf", "docx", "pptx", "xlsx", "txt", "html"],
    "total_size_gb": 50,
    "languages": ["zh-CN", "en-US"],
    "update_frequency": "每天新增约500份"
  },
  "query_requirements": {
    "expected_qps": 100,
    "max_latency_ms": 3000,
    "accuracy_target": "top-5命中率>85%",
    "multi_modal": true,
    "citation_required": true
  },
  "constraints": {
    "deployment": "私有化部署（数据不出网）",
    "gpu": "4x A100 80GB",
    "budget": "首年100万RMB以内",
    "team": "3个后端+1个算法"
  }
}
\`\`\`

请帮我设计完整方案：
1. 搜索2025-2026年企业级RAG系统的最佳实践和架构模式
2. 向量数据库选型：Milvus vs Qdrant vs Weaviate vs pgvector
3. Embedding模型选型：BGE-M3 vs text-embedding-3 vs Cohere的对比
4. 文档解析管道：如何处理复杂PDF表格和PPT中的图表？
5. 重排序（Reranking）策略和Chunking策略的最新研究
6. 给出完整的技术架构图和部署方案`,
  },
  {
    id: 16,
    category: "需求分析",
    source: "跨境电商合规论坛 + 知乎",
    title: "跨境电商数据合规架构设计",
    prompt: `我们是一家做跨境电商的公司，业务覆盖欧洲（GDPR）、美国（CCPA）、东南亚。最近看到知乎和一些合规论坛的讨论，说2025年各国数据合规要求越来越严。

当前架构问题：
\`\`\`
现状：
- 全部数据存在阿里云杭州region
- 欧洲用户数据和中国数据混在一起
- 没有数据分类分级
- 用户删除请求处理需要7天（GDPR要求72小时响应）
- 日志中包含明文PII数据

业务规模：
- 日活用户：150万（欧洲40万、美国60万、东南亚50万）
- 日订单：30万
- 数据量：MySQL 2TB + MongoDB 5TB + S3 20TB
\`\`\`

请帮我设计合规架构：
1. 搜索GDPR、CCPA、东南亚各国数据保护法的核心要求对比
2. 数据分类分级方案（PII识别与标记）
3. 跨境数据传输的合法路径（SCCs、BCRs、数据本地化）
4. 搜索业界跨境电商的数据合规架构最佳实践
5. "被遗忘权"的技术实现方案（如何在分布式系统中彻底删除用户数据）
6. 给出完整的合规改造方案和时间表`,
  },

  // ━━━ 技术实现方案 (4) — 来源: CNCF/Reddit r/kubernetes/Confluent ━━━
  {
    id: 17,
    category: "技术方案",
    source: "Reddit r/devops + K8s官方文档",
    title: "K8s上的vLLM推理服务部署与自动扩缩容",
    prompt: `Reddit r/devops上有人问"Has anyone used Kubernetes with GPU training before?"。markaicode.com最近发了一篇"Deploying a vLLM Inference Server on Kubernetes with GPU Scheduling"的生产指南。

我们需要在K8s集群上部署vLLM推理服务，要求：
\`\`\`yaml
cluster:
  nodes: 8 (4x GPU nodes with 4x A100 each)
  k8s_version: 1.30
  gpu_operator: NVIDIA GPU Operator 24.6

requirements:
  model: Qwen-72B-Chat (AWQ 4bit quantized)
  target_throughput: 1000 tokens/s per replica
  max_latency_p99: 2s for first token
  availability: 99.95%
  auto_scaling: based on GPU utilization + queue depth

current_issues:
  - GPU利用率只有30-40%
  - 冷启动时间太长（模型加载3-5分钟）
  - HPA只能用CPU/Memory指标，不够精确
  - readiness probe误判导致流量打到未就绪的pod
\`\`\`

请搜索并给出方案：
1. vLLM在K8s上的最佳部署配置（resource limits、GPU分配策略）
2. 基于自定义metrics的HPA配置（KEDA + Prometheus custom metrics）
3. 搜索解决GPU利用率低的方案（MIG分割 vs time-slicing vs KAI Scheduler）
4. 模型预加载和快速冷启动的方案
5. 给出完整的K8s manifest和HPA配置`,
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
  {
    id: 19,
    category: "技术方案",
    source: "NIST SP 1800-35 + CISA",
    title: "零信任架构实施方案（基于NIST标准）",
    prompt: `NIST在2025年6月发布了SP 1800-35 "Implementing a Zero Trust Architecture"，和24家供应商合作做了端到端的零信任实施演示。CISA也发布了联邦政府的零信任实施指南。

我们公司（1000人规模，混合办公）需要实施零信任：
\`\`\`
当前安全架构:
- 网络: 传统边界防护 (防火墙+VPN)
- 身份: AD + LDAP, 无MFA
- 终端: 混合 (Windows 70%, macOS 25%, Linux 5%)
- 应用: 60%在本地，40%在公有云 (AWS)
- 数据: 无分类分级，明文传输占30%

安全事件 (过去12个月):
- 钓鱼攻击成功 3次
- VPN凭证泄露 1次
- 内部数据外泄 1次 (离职员工)
- 供应链攻击尝试 2次

合规要求:
- 等保三级
- SOC 2 Type II (海外客户要求)
\`\`\`

请设计实施方案：
1. 搜索NIST SP 800-207和SP 1800-35的核心架构组件和要求
2. 零信任的5个支柱（身份、设备、网络、应用、数据）各需要什么技术方案？
3. 搜索国内外零信任产品（Zscaler、Palo Alto、奇安信、深信服）的对比
4. 从传统VPN迁移到零信任的分阶段实施路径
5. 给出12个月的实施路线图和预算估算`,
  },
  {
    id: 20,
    category: "技术方案",
    source: "Seata社区 + 阿里技术",
    title: "金融级分布式事务方案选型与实施",
    prompt: `我们的支付系统需要处理分布式事务。看了Seata社区和阿里技术博客的很多讨论，目前在几个方案间纠结。

系统现状：
\`\`\`java
// 当前代码示例 - 转账服务
@Service
public class TransferService {
    @Autowired
    private AccountMapper accountMapper;
    @Autowired
    private TransactionLogMapper logMapper;
    @Autowired
    private RestTemplate restTemplate;
    
    @Transactional
    public void transfer(String fromAccount, String toAccount, BigDecimal amount) {
        // 1. 扣减源账户 (本地MySQL)
        accountMapper.deduct(fromAccount, amount);
        
        // 2. 调用风控服务 (远程HTTP)
        RiskResult risk = restTemplate.postForObject(
            "http://risk-service/check", 
            new RiskRequest(fromAccount, toAccount, amount),
            RiskResult.class
        );
        if (!risk.isAllowed()) throw new BizException("风控拒绝");
        
        // 3. 增加目标账户 (另一个MySQL实例)
        restTemplate.postForObject(
            "http://account-service/credit",
            new CreditRequest(toAccount, amount),
            Void.class
        );
        
        // 4. 记录流水 (MongoDB)
        logMapper.insert(new TransactionLog(...));
        
        // 问题: 步骤3成功但步骤4失败怎么办？
        // 问题: 步骤2超时但实际上风控通过了怎么办？
    }
}
\`\`\`

请帮我分析并设计方案：
1. 搜索Seata AT/TCC/Saga/XA四种模式在金融场景的适用性对比
2. 搜索2025年分布式事务领域的最新方案（如DTM、ServiceComb）
3. 基于当前代码，给出具体的TCC改造方案（包含try/confirm/cancel的代码）
4. 消息事务（本地消息表+MQ）方案在这个场景是否更合适？
5. 性能影响评估：引入分布式事务后TPS下降多少？有没有基准数据？
6. 给出推荐方案和完整的改造计划`,
  },
];

// ── API Client ──────────────────────────────────────────────────────────────

async function sendToJarvis(prompt: string, timeoutMs: number = 300_000): Promise<ResponseResult> {
  const start = Date.now();

  const body = {
    model: "main",
    input: prompt,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(API_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return {
        ok: false,
        output: `HTTP ${resp.status}: ${errText.slice(0, 200)}`,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: Date.now() - start,
        toolCalls: 0,
      };
    }

    const data = await resp.json() as Record<string, unknown>;

    // Extract output text
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

    // Extract usage
    const usage = data.usage as Record<string, number> | undefined;
    const toolCalls = Array.isArray(output)
      ? output.filter((o: Record<string, unknown>) => 
          o.type === "function_call" || o.type === "tool_use"
        ).length
      : 0;

    return {
      ok: true,
      output: outputText,
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      durationMs: Date.now() - start,
      toolCalls,
    };
  } catch (err) {
    clearTimeout(timer);
    return {
      ok: false,
      output: err instanceof Error ? err.message : String(err),
      inputTokens: 0,
      outputTokens: 0,
      durationMs: Date.now() - start,
      toolCalls: 0,
    };
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=" .repeat(80));
  console.log("Context Distiller V2 — 20 Real-World Cases Test (Community-Sourced)");
  console.log("=".repeat(80));
  console.log(`Start: ${new Date().toISOString()}`);
  console.log(`Plugin improvement: api_response budgetMultiplier 2.5 → 4.0 + paragraph preservation\n`);

  // Get baseline stats
  const statsPath = new URL("../.stats.json", import.meta.url).pathname;
  let baselineDistillations = 0;
  let baselineTokensSaved = 0;
  try {
    const stats = JSON.parse(await Bun?.file?.(statsPath)?.text?.() ?? 
      (await import("fs")).readFileSync(statsPath, "utf8"));
    baselineDistillations = stats.totalDistillations ?? 0;
    baselineTokensSaved = stats.totalTokensSaved ?? 0;
    console.log(`Baseline: ${baselineDistillations} distillations, ${baselineTokensSaved.toLocaleString()} tokens saved\n`);
  } catch { console.log("Could not read baseline stats\n"); }

  const results: Array<{
    id: number;
    category: string;
    source: string;
    title: string;
    ok: boolean;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    outputLength: number;
    toolCalls: number;
  }> = [];

  for (const tc of testCases) {
    console.log(`\n${"─".repeat(70)}`);
    console.log(`Case ${tc.id}/${testCases.length}: [${tc.category}] ${tc.title}`);
    console.log(`Source: ${tc.source}`);
    console.log(`Prompt length: ${tc.prompt.length} chars`);
    console.log("Sending to Jarvis...");

    const result = await sendToJarvis(tc.prompt);

    results.push({
      id: tc.id,
      category: tc.category,
      source: tc.source,
      title: tc.title,
      ok: result.ok,
      durationMs: result.durationMs,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      outputLength: result.output.length,
      toolCalls: result.toolCalls,
    });

    const status = result.ok ? "✅" : "❌";
    console.log(`${status} Done in ${(result.durationMs / 1000).toFixed(0)}s`);
    console.log(`  Input: ${result.inputTokens.toLocaleString()} tokens`);
    console.log(`  Output: ${result.outputTokens.toLocaleString()} tokens (${result.output.length} chars)`);
    console.log(`  Tool calls: ${result.toolCalls}`);

    // Check distiller stats after each case
    try {
      const stats = JSON.parse((await import("fs")).readFileSync(statsPath, "utf8"));
      const deltaD = stats.totalDistillations - baselineDistillations;
      const deltaT = stats.totalTokensSaved - baselineTokensSaved;
      console.log(`  Distiller: +${deltaD} distillations, +${deltaT.toLocaleString()} tokens saved so far`);
    } catch { /* ignore */ }

    // Small delay between cases
    if (tc.id < testCases.length) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // ── Summary ──
  console.log(`\n${"═".repeat(80)}`);
  console.log("SUMMARY");
  console.log("═".repeat(80));

  let finalDistillations = 0;
  let finalTokensSaved = 0;
  try {
    const stats = JSON.parse((await import("fs")).readFileSync(statsPath, "utf8"));
    finalDistillations = stats.totalDistillations - baselineDistillations;
    finalTokensSaved = stats.totalTokensSaved - baselineTokensSaved;
  } catch { /* ignore */ }

  const totalDuration = results.reduce((s, r) => s + r.durationMs, 0);
  const totalInput = results.reduce((s, r) => s + r.inputTokens, 0);
  const successCount = results.filter(r => r.ok).length;

  console.log(`Total cases: ${results.length}`);
  console.log(`Success: ${successCount}/${results.length}`);
  console.log(`Total duration: ${(totalDuration / 60_000).toFixed(1)} minutes`);
  console.log(`Total input tokens: ${totalInput.toLocaleString()}`);
  console.log(`\nDistiller V2 results:`);
  console.log(`  New distillations: ${finalDistillations}`);
  console.log(`  New tokens saved: ${finalTokensSaved.toLocaleString()}`);
  console.log(`  Avg tokens saved per case: ${Math.round(finalTokensSaved / results.length).toLocaleString()}`);

  // Per-category summary
  const categories = [...new Set(results.map(r => r.category))];
  console.log("\nPer-category breakdown:");
  for (const cat of categories) {
    const catResults = results.filter(r => r.category === cat);
    const catInput = catResults.reduce((s, r) => s + r.inputTokens, 0);
    const catDuration = catResults.reduce((s, r) => s + r.durationMs, 0);
    console.log(`  ${cat}: ${catResults.length} cases, ${catInput.toLocaleString()} tokens, ${(catDuration / 60_000).toFixed(1)}min`);
  }

  // Save results
  const outputPath = "/Users/gaoyuan/WorkBuddy/Claw/distiller-v2-20cases-data.json";
  (await import("fs")).writeFileSync(outputPath, JSON.stringify({
    version: "v2",
    timestamp: new Date().toISOString(),
    baseline: { distillations: baselineDistillations, tokensSaved: baselineTokensSaved },
    final: { distillations: baselineDistillations + finalDistillations, tokensSaved: baselineTokensSaved + finalTokensSaved },
    delta: { distillations: finalDistillations, tokensSaved: finalTokensSaved },
    results,
  }, null, 2));
  console.log(`\nData saved to: ${outputPath}`);
  console.log(`End: ${new Date().toISOString()}`);
}

main().catch(console.error);
