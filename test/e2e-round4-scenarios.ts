#!/usr/bin/env tsx
/**
 * E2E Round 4 Test Suite — 20 New Real-World Scenarios
 *
 * Based on Round 2 research + expanded domains:
 *
 * Sources:
 * - Redis Blog (2026): Context window overflow in production — tool output accumulation,
 *   RAG retrieval bloat, agent workflow cascading context loss
 * - SkrewAI (2025): AI coding agents production barriers — multi-file refactoring,
 *   architecture amnesia, operational blindness
 * - Claude Code Security Review: SAST/DAST vulnerability scan reports
 * - dbt/Databricks: ETL pipeline metadata, SQL lineage, data catalog
 * - Unity/Unreal: shader code, scene graph hierarchy, entity-component dumps
 * - LegalAgentBench (ACL 2025): legal document review context overflow
 * - XBRL Agent: financial report analysis with structured data
 * - Mobile dev: Xcode/Gradle build logs, crash logs with symbolicated stacks
 *
 * These 20 cases complement the previous 20 by covering:
 * - Security/vulnerability scanning
 * - Financial/legal document processing
 * - Mobile development (iOS/Android)
 * - Game development (shaders, scene graphs)
 * - Data engineering (ETL, lineage)
 * - Infrastructure (Ansible, Helm, Nix)
 * - Multi-agent workflows
 * - Edge cases from Redis/SkrewAI production reports
 */

import { resolveConfig } from "../src/config.js";
import { DistillerEngine, classifyContent } from "../src/distiller.js";
import { estimateTokens } from "../src/tokens.js";
import {
  toolOutputTruncationRule,
  patchDistillRule,
  fileContentDistillRule,
  repetitionEliminationRule,
  errorExtractionRule,
  domainAwareRule,
} from "../src/rules/index.js";

const GREEN = "\x1b[32m", RED = "\x1b[31m", YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m", DIM = "\x1b[2m", RESET = "\x1b[0m", BOLD = "\x1b[1m";

interface TestResult {
  id: number; name: string; passed: boolean;
  tokensBefore: number; tokensAfter: number;
  distilled: boolean; ratio: string; details: string; error?: string;
}

const results: TestResult[] = [];
let engine: DistillerEngine;

function createEngine(ov?: Record<string, unknown>): DistillerEngine {
  const config = resolveConfig(process.env, ov);
  const log = {
    info: (_m: string) => {}, warn: (m: string) => console.log(`  ${YELLOW}WARN: ${m}${RESET}`),
    error: (m: string) => console.log(`  ${RED}ERROR: ${m}${RESET}`), debug: (_m: string) => {},
  };
  const e = new DistillerEngine(config, log);
  e.addRule(domainAwareRule);                  // P4
  e.addRule(repetitionEliminationRule);         // P5
  e.addRule(errorExtractionRule);               // P8
  e.addRule(toolOutputTruncationRule);          // P10
  e.addRule(patchDistillRule);                  // P10
  e.addRule(fileContentDistillRule);            // P10
  return e;
}

async function runDistill(content: string, toolName: string) {
  const category = classifyContent({ toolName, isToolResult: true, content });
  return engine.distill({ content, category, toolName });
}

function pushResult(id: number, name: string, r: { distilled: boolean; content: string; tokensBefore: number; tokensAfter: number; rule?: string },
  pass: boolean, details: string) {
  const ratio = r.distilled ? (r.tokensAfter / r.tokensBefore * 100).toFixed(1) + "%" : "100%";
  results.push({ id, name, passed: pass, tokensBefore: r.tokensBefore, tokensAfter: r.tokensAfter,
    distilled: r.distilled, ratio, details });
  const icon = pass ? `${GREEN}✅${RESET}` : `${RED}❌${RESET}`;
  console.log(`${icon} R4-${String(id).padStart(2)} ${BOLD}${name}${RESET}`);
  if (r.distilled) console.log(`   ${CYAN}${r.tokensBefore}→${r.tokensAfter} (${ratio})${RESET}`);
  else console.log(`   ${DIM}passthrough (${r.tokensBefore})${RESET}`);
  console.log(`   ${DIM}${details}${RESET}`);
}

// ═══════════════════════════════════════════════════════════════════════
// 1. SAST Vulnerability Scan — 200 findings across 50 files
// Source: Claude Code Security Review, CodeMender, DeepSource
// ═══════════════════════════════════════════════════════════════════════
async function test1() {
  const severities = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];
  const categories = ["SQL_INJECTION", "XSS", "PATH_TRAVERSAL", "HARDCODED_SECRET", "BUFFER_OVERFLOW", "INSECURE_DESERIALIZATION", "OPEN_REDIRECT"];
  const lines: string[] = ["SAST Scan Results — 200 findings", "=" .repeat(50), ""];
  for (let i = 0; i < 200; i++) {
    const sev = severities[i % 5];
    const cat = categories[i % 7];
    const file = `src/${["auth","api","db","utils","middleware"][i%5]}/${["handler","service","controller","model","validator"][i%5]}.ts`;
    lines.push(`[${sev}] ${cat} at ${file}:${10 + i * 3}`);
    lines.push(`  Rule: security/${cat.toLowerCase()}`);
    lines.push(`  Description: Potential ${cat.replace(/_/g, " ").toLowerCase()} vulnerability detected`);
    lines.push(`  Code: ${i % 2 === 0 ? `const result = db.query("SELECT * FROM users WHERE id=" + userId)` : `res.send("<script>" + userInput + "</script>")`}`);
    lines.push(`  Fix: Use parameterized queries / sanitize input`);
    lines.push("");
  }
  lines.push(`Summary: ${200} findings (40 CRITICAL, 40 HIGH, 40 MEDIUM, 40 LOW, 40 INFO)`);
  const r = await runDistill(lines.join("\n"), "execute_command");
  // Should preserve CRITICAL/HIGH errors and summary line
  const keepsCritical = r.content.includes("CRITICAL") || r.content.includes("HIGH");
  pushResult(1, "SAST漏洞扫描 — 200个安全发现", r,
    r.distilled && r.tokensAfter < r.tokensBefore * 0.3,
    `安全扫描报告(SQL注入/XSS/路径遍历等), 关键漏洞保留: ${keepsCritical?"✓":"✗"}`);
}

// ═══════════════════════════════════════════════════════════════════════
// 2. Xcode Build Log — iOS app with 150 warnings and 3 errors
// Source: Mobile dev AI agent crash resolution benchmarks
// ═══════════════════════════════════════════════════════════════════════
async function test2() {
  const lines: string[] = [];
  lines.push("=== BUILD TARGET MyApp ===");
  lines.push("CompileSwift normal arm64 AppDelegate.swift");
  for (let i = 0; i < 150; i++) {
    const file = `${["View","Model","Service","Controller","Extension"][i%5]}/${["Home","Profile","Settings","Auth","Feed"][i%5]}${["View","Model","Service","VC","Cell"][i%5]}.swift`;
    lines.push(`${file}:${i*5+10}:${i%30+1}: warning: ${["unused variable", "deprecated API", "implicit conversion", "force unwrap", "string interpolation"][i%5]} '${["x","y","temp","result","value"][i%5]}'`);
  }
  lines.push("Model/AuthService.swift:42:5: error: cannot find 'KeychainWrapper' in scope");
  lines.push("View/FeedCell.swift:88:12: error: type 'UITableViewCell' has no member 'configure'");
  lines.push("Controller/HomeVC.swift:156:8: error: missing return in closure expected to return 'Bool'");
  lines.push("");
  lines.push("** BUILD FAILED **");
  lines.push("3 errors, 150 warnings");
  const r = await runDistill(lines.join("\n"), "execute_command");
  const keepsErrors = r.content.includes("error:") && r.content.includes("BUILD FAILED");
  pushResult(2, "Xcode构建日志 — 150警告+3错误", r,
    r.distilled && r.tokensAfter < r.tokensBefore * 0.4,
    `iOS构建日志, 错误保留: ${keepsErrors?"✓":"✗"}`);
}

// ═══════════════════════════════════════════════════════════════════════
// 3. Android Gradle Build — 500-line output with dependency resolution
// ═══════════════════════════════════════════════════════════════════════
async function test3() {
  const lines: string[] = ["", "> Task :app:dependencies", ""];
  const groups = ["com.google.android", "androidx.compose", "org.jetbrains.kotlin", "com.squareup.retrofit2", "com.squareup.okhttp3", "io.coil-kt", "com.google.dagger"];
  for (let i = 0; i < 80; i++) {
    const group = groups[i % 7];
    const artifact = `${["core","ui","runtime","compiler","adapter","interceptor","module"][i%7]}`;
    const version = `${1 + i % 3}.${i % 10}.${i % 5}`;
    const depth = "  ".repeat((i % 4) + 1);
    const symbol = i % 3 === 0 ? "+---" : i % 3 === 1 ? "|   +---" : "\\---";
    lines.push(`${depth}${symbol} ${group}:${artifact}:${version}`);
    if (i % 15 === 0) lines.push(`${depth}     \\--- ${group}:${artifact}-ktx:${version} (*)`);
  }
  lines.push("");
  lines.push("> Task :app:compileDebugKotlin");
  for (let i = 0; i < 40; i++) {
    lines.push(`w: /app/src/main/java/com/myapp/${["ui","data","domain","di"][i%4]}/${["Fragment","Repository","UseCase","Module"][i%4]}${i}.kt:(${i*10+5},${i%20+1}): ${["Parameter 'x' is never used","'when' expression on sealed class should be exhaustive","Unchecked cast","Unnecessary safe call"][i%4]}`);
  }
  lines.push("");
  lines.push("BUILD SUCCESSFUL in 2m 34s");
  lines.push("127 actionable tasks: 48 executed, 79 up-to-date");
  const r = await runDistill(lines.join("\n"), "execute_command");
  pushResult(3, "Gradle构建 — 依赖树+Kotlin编译警告", r,
    r.distilled && r.tokensAfter < r.tokensBefore * 0.5,
    `Android构建日志（80依赖+40编译警告）`);
}

// ═══════════════════════════════════════════════════════════════════════
// 4. XBRL Financial Report — quarterly earnings with 100+ line items
// Source: XBRL Agent (ACM 2024)
// ═══════════════════════════════════════════════════════════════════════
async function test4() {
  const items: string[] = [];
  const sections = [
    { name: "Revenue", count: 15, prefix: "us-gaap:Revenues" },
    { name: "Cost of Goods Sold", count: 10, prefix: "us-gaap:CostOfGoodsSold" },
    { name: "Operating Expenses", count: 20, prefix: "us-gaap:OperatingExpenses" },
    { name: "Other Income/Expense", count: 8, prefix: "us-gaap:OtherIncome" },
    { name: "Balance Sheet - Assets", count: 25, prefix: "us-gaap:Assets" },
    { name: "Balance Sheet - Liabilities", count: 20, prefix: "us-gaap:Liabilities" },
    { name: "Cash Flow", count: 15, prefix: "us-gaap:CashFlow" },
  ];
  for (const section of sections) {
    items.push(`\n<!-- ${section.name} -->`);
    for (let i = 0; i < section.count; i++) {
      const val = (Math.random() * 10000).toFixed(0);
      items.push(`<${section.prefix}Item${i} contextRef="FY2025Q4" unitRef="USD" decimals="-3">${val}</${section.prefix}Item${i}>`);
    }
  }
  const content = `<?xml version="1.0"?>\n<xbrl xmlns="http://www.xbrl.org/2003/instance">\n${items.join("\n")}\n</xbrl>`;
  const r = await runDistill(content, "read_file");
  pushResult(4, "XBRL财务报告 — 113行项目季度财报", r,
    r.distilled && r.tokensAfter < r.tokensBefore * 0.7,
    `XBRL格式季报（7个section/113项/USD千位精度）`);
}

// ═══════════════════════════════════════════════════════════════════════
// 5. Legal Contract Review — 40-page NDA with clauses and definitions
// Source: LegalAgentBench (ACL 2025), Thomson Reuters
// ═══════════════════════════════════════════════════════════════════════
async function test5() {
  const clauses = [
    "1. DEFINITIONS", "1.1 \"Confidential Information\" means any non-public information...",
    "1.2 \"Disclosing Party\" means the party that discloses...",
    "1.3 \"Receiving Party\" means the party that receives...",
    "2. OBLIGATIONS", "2.1 The Receiving Party shall hold all Confidential Information in strict confidence...",
    "2.2 The Receiving Party shall not disclose any Confidential Information to any third party...",
    "2.3 The Receiving Party shall use the Confidential Information solely for the Purpose...",
  ];
  const sections: string[] = [];
  sections.push("NON-DISCLOSURE AGREEMENT", "", "Date: January 15, 2026", "Parties: TechCorp Inc. and InnovateAI Ltd.", "");
  for (let s = 0; s < 12; s++) {
    sections.push(`\n## Section ${s + 1}: ${["DEFINITIONS","OBLIGATIONS","EXCEPTIONS","TERM","REMEDIES","GOVERNING LAW","DISPUTE RESOLUTION","ASSIGNMENT","NOTICES","ENTIRE AGREEMENT","AMENDMENTS","SEVERABILITY"][s]}\n`);
    for (let p = 0; p < 8; p++) {
      sections.push(`${s + 1}.${p + 1} ${["The parties agree that","Notwithstanding the foregoing,","Subject to the terms herein,","In the event that","For the avoidance of doubt,","Without limiting the generality,","To the maximum extent permitted by law,","Each party represents and warrants that"][p]} ${["all intellectual property rights","confidential information","trade secrets and proprietary data","business operations and strategies","technical specifications and designs","financial information and projections","customer lists and contact information","software source code and documentation"][p % 8]} shall be ${["protected","disclosed only as required","maintained in confidence","returned upon termination","destroyed within 30 days","subject to audit rights","governed by applicable law","enforced through injunctive relief"][p % 8]}. ${["The obligations set forth in this Section shall survive for a period of five (5) years from the date of disclosure.","This provision shall not apply to information that becomes publicly available through no fault of the Receiving Party.","Any breach of this Section shall entitle the non-breaching party to seek equitable relief.","The parties acknowledge that monetary damages may be inadequate to compensate for any breach hereof."][p % 4]}\n`);
    }
  }
  const content = sections.join("\n");
  const r = await runDistill(content, "read_file");
  pushResult(5, "法律合同 — 12节NDA保密协议", r,
    r.distilled && r.tokensAfter < r.tokensBefore * 0.6,
    `40页NDA（12节×8条×定义+义务+例外+补救）`);
}

// ═══════════════════════════════════════════════════════════════════════
// 6. dbt Model Lineage — 50 models with upstream/downstream deps
// Source: dbt Labs, data engineering AI agent workflows
// ═══════════════════════════════════════════════════════════════════════
async function test6() {
  const models: string[] = ["dbt Model Lineage Graph", "=" .repeat(40), ""];
  const layers = ["staging", "intermediate", "marts", "reporting"];
  for (let i = 0; i < 50; i++) {
    const layer = layers[Math.min(i % 4, 3)];
    const name = `${layer}_${["users","orders","products","payments","events","sessions","inventory","shipments","reviews","metrics"][i % 10]}${i < 10 ? "" : "_v" + Math.floor(i/10)}`;
    const upstream = i > 0 ? Array.from({length: Math.min(3, i)}, (_, j) => `model.${layers[0]}_${["users","orders","products"][j%3]}`).join(", ") : "(source)";
    const downstream = i < 45 ? Array.from({length: 2}, (_, j) => `model.${layers[3]}_${["dashboard","report"][j]}_${i+j}`).join(", ") : "(terminal)";
    models.push(`Model: ${name}`);
    models.push(`  Schema: analytics.${layer}`);
    models.push(`  Materialization: ${["table","view","incremental","ephemeral"][i%4]}`);
    models.push(`  Upstream: ${upstream}`);
    models.push(`  Downstream: ${downstream}`);
    models.push(`  Columns: ${10 + i % 20} (${["id","created_at","updated_at","user_id","amount"].join(", ")}, ...)`);
    models.push(`  Tests: ${["not_null","unique","relationships","accepted_values"].slice(0, 1 + i % 4).join(", ")}`);
    models.push(`  Last run: ${i % 2 === 0 ? "success" : "error"} (${i * 0.5 + 1}s)`);
    models.push("");
  }
  const r = await runDistill(models.join("\n"), "execute_command");
  pushResult(6, "dbt模型血缘 — 50个模型上下游依赖", r,
    r.distilled && r.tokensAfter < r.tokensBefore * 0.3,
    `数据工程:4层50模型(staging→marts→reporting)`);
}

// ═══════════════════════════════════════════════════════════════════════
// 7. Unity Scene Hierarchy — 200 GameObjects with components
// Source: Unity AI, game dev AI agent workflows
// ═══════════════════════════════════════════════════════════════════════
async function test7() {
  const lines: string[] = ["Unity Scene Hierarchy Dump", "Scene: MainLevel.unity", ""];
  const components = ["Transform", "MeshRenderer", "MeshFilter", "BoxCollider", "Rigidbody", "AudioSource", "ParticleSystem", "Animator", "NavMeshAgent", "Light"];
  for (let i = 0; i < 200; i++) {
    const depth = Math.min(i % 6, 4);
    const indent = "  ".repeat(depth);
    const objType = ["GameObject","Camera","Light","Canvas","EventSystem","ParticleSystem","AudioSource"][i%7];
    const name = `${["Player","Enemy","NPC","Prop","UI","Particle","Sound","Effect","Trigger","Spawn"][i%10]}_${i}`;
    lines.push(`${indent}[${i}] ${objType}: ${name}`);
    lines.push(`${indent}  Position: (${(Math.random()*100).toFixed(2)}, ${(Math.random()*50).toFixed(2)}, ${(Math.random()*100).toFixed(2)})`);
    lines.push(`${indent}  Components: [${components.slice(0, 2 + i % 4).join(", ")}]`);
    if (i % 10 === 0) lines.push(`${indent}  Script: ${["PlayerController","EnemyAI","NPCDialogue","ItemPickup"][i%4]}.cs`);
  }
  const r = await runDistill(lines.join("\n"), "execute_command");
  pushResult(7, "Unity场景层级 — 200个GameObject", r,
    r.distilled && r.tokensAfter < r.tokensBefore * 0.55,
    `游戏开发:200对象×位置×组件×脚本`);
}

// ═══════════════════════════════════════════════════════════════════════
// 8. Helm Chart Values — 300-line Kubernetes deployment config
// ═══════════════════════════════════════════════════════════════════════
async function test8() {
  const lines: string[] = ["# Helm values.yaml — Production Kubernetes Deployment", ""];
  const services = ["api-gateway", "auth-service", "user-service", "order-service", "payment-service", "notification-service", "search-service", "analytics-service"];
  for (const svc of services) {
    lines.push(`${svc}:`);
    lines.push(`  replicaCount: ${2 + Math.floor(Math.random() * 6)}`);
    lines.push(`  image:`);
    lines.push(`    repository: registry.company.com/${svc}`);
    lines.push(`    tag: "v${1 + Math.floor(Math.random()*3)}.${Math.floor(Math.random()*10)}.${Math.floor(Math.random()*100)}"`);
    lines.push(`    pullPolicy: IfNotPresent`);
    lines.push(`  resources:`);
    lines.push(`    requests: { cpu: "${100 + Math.floor(Math.random()*400)}m", memory: "${128 + Math.floor(Math.random()*384)}Mi" }`);
    lines.push(`    limits: { cpu: "${500 + Math.floor(Math.random()*1500)}m", memory: "${256 + Math.floor(Math.random()*768)}Mi" }`);
    lines.push(`  env:`);
    for (let e = 0; e < 8; e++) {
      lines.push(`    - name: ${["DATABASE_URL","REDIS_URL","JWT_SECRET","API_KEY","LOG_LEVEL","CORS_ORIGIN","RATE_LIMIT","CACHE_TTL"][e]}`);
      lines.push(`      value: "${["postgresql://db:5432/prod","redis://cache:6379","${SECRET}","${API_KEY}","info","https://app.com","1000","3600"][e]}"`);
    }
    lines.push(`  service: { type: ClusterIP, port: ${3000 + services.indexOf(svc)} }`);
    lines.push(`  ingress: { enabled: true, host: "${svc}.company.com" }`);
    lines.push(`  autoscaling: { enabled: true, minReplicas: 2, maxReplicas: ${5 + Math.floor(Math.random()*15)}, targetCPU: 70 }`);
    lines.push(`  healthCheck: { path: "/health", initialDelay: 30, period: 10 }`);
    lines.push("");
  }
  const r = await runDistill(lines.join("\n"), "read_file");
  pushResult(8, "Helm Chart — 8微服务K8s部署配置", r,
    r.distilled && r.tokensAfter < r.tokensBefore * 0.7,
    `生产K8s部署:8服务×副本×资源×环境变量×自动扩缩`);
}

// ═══════════════════════════════════════════════════════════════════════
// 9. iOS Crash Log — symbolicated stack trace with 60 frames
// Source: Mobile dev crash resolution, Apple developer forums
// ═══════════════════════════════════════════════════════════════════════
async function test9() {
  const lines: string[] = [
    "Incident Identifier: 8A2B3C4D-5E6F-7890-ABCD-EF1234567890",
    "CrashReporter Key: abc123def456",
    "Hardware Model: iPhone15,2",
    "OS Version: iOS 19.3 (23A456)",
    "Exception Type: EXC_BAD_ACCESS (SIGSEGV)",
    "Exception Codes: KERN_INVALID_ADDRESS at 0x0000000000000000",
    "Triggered by Thread: 0",
    "",
    "Thread 0 Crashed:",
  ];
  for (let i = 0; i < 30; i++) {
    const framework = i < 5 ? "MyApp" : i < 15 ? "UIKitCore" : i < 25 ? "CoreFoundation" : "libdispatch.dylib";
    const fn = i < 5
      ? `${["FeedViewController","DataManager","NetworkService","CacheManager","ImageLoader"][i]}.${["loadData","fetchItems","processResponse","invalidateCache","decodeImage"][i]}()`
      : `${["_CF","_UI","__NS","dispatch_"][i%4]}${["RunLoopRun","ApplicationMain","ObjectRelease","async_f"][i%4]}`;
    lines.push(`${i}\t${framework}\t0x${(0x100000000 + i * 0x1000).toString(16)}\t${fn} + ${i * 42}`);
  }
  lines.push("");
  lines.push("Thread 1:");
  for (let i = 0; i < 15; i++) {
    lines.push(`${i}\tlibsystem_kernel.dylib\t0x${(0x200000000 + i * 0x800).toString(16)}\t__workq_kernreturn + ${i * 8}`);
  }
  lines.push("");
  lines.push("Thread 2:");
  for (let i = 0; i < 15; i++) {
    lines.push(`${i}\tCoreData\t0x${(0x180000000 + i * 0x500).toString(16)}\t-[NSManagedObjectContext ${["save:","executeFetchRequest:","performBlock:","processPendingChanges","_processRecentChanges"][i%5]}] + ${i * 36}`);
  }
  lines.push("");
  lines.push("Binary Images:");
  for (let i = 0; i < 20; i++) {
    lines.push(`0x${(0x100000000 + i * 0x10000).toString(16)} - 0x${(0x100010000 + i * 0x10000).toString(16)} ${["MyApp","UIKitCore","CoreFoundation","libdispatch","CoreData","Foundation","Security","Network"][i%8]} arm64 <${Array.from({length:32}, () => "0123456789abcdef"[Math.floor(Math.random()*16)]).join("")}>`);
  }
  const r = await runDistill(lines.join("\n"), "execute_command");
  const keepsException = r.content.includes("EXC_BAD_ACCESS") || r.content.includes("SIGSEGV");
  pushResult(9, "iOS崩溃日志 — 3线程60帧符号化栈", r,
    r.distilled && r.tokensAfter < r.tokensBefore * 0.5,
    `EXC_BAD_ACCESS崩溃, 异常保留: ${keepsException?"✓":"✗"}`);
}

// ═══════════════════════════════════════════════════════════════════════
// 10. Ansible Playbook Output — 30 hosts × 15 tasks
// ═══════════════════════════════════════════════════════════════════════
async function test10() {
  const hosts = Array.from({length: 30}, (_, i) => `web-${String(i+1).padStart(3,"0")}.prod.internal`);
  const tasks = ["Gathering Facts", "Install packages", "Configure nginx", "Deploy app", "Set permissions",
    "Create users", "Update firewall", "Configure SSL", "Restart services", "Health check",
    "Rotate logs", "Update DNS", "Configure monitoring", "Set cron jobs", "Verify deployment"];
  const lines: string[] = ["PLAY [Deploy Production] *****", ""];
  for (const task of tasks) {
    lines.push(`TASK [${task}] ${"*".repeat(50)}`);
    for (const host of hosts) {
      const status = Math.random() > 0.95 ? "failed" : Math.random() > 0.7 ? "changed" : "ok";
      lines.push(`${status}: [${host}]${status === "failed" ? " => {\"msg\": \"Connection timed out\"}" : ""}`);
    }
    lines.push("");
  }
  lines.push("PLAY RECAP *****");
  for (const host of hosts) {
    const ok = 12 + Math.floor(Math.random()*3);
    const changed = Math.floor(Math.random()*5);
    const failed = Math.random() > 0.9 ? 1 : 0;
    lines.push(`${host.padEnd(35)} : ok=${ok}  changed=${changed}  unreachable=0  failed=${failed}`);
  }
  const r = await runDistill(lines.join("\n"), "execute_command");
  const keepsFailed = r.content.includes("failed");
  pushResult(10, "Ansible部署 — 30主机×15任务", r,
    r.distilled && r.tokensAfter < r.tokensBefore * 0.55,
    `生产部署日志(450条记录), 失败保留: ${keepsFailed?"✓":"✗"}`);
}

// ═══════════════════════════════════════════════════════════════════════
// 11. npm audit — 80 vulnerabilities across 200 packages
// ═══════════════════════════════════════════════════════════════════════
async function test11() {
  const lines: string[] = [];
  for (let i = 0; i < 80; i++) {
    const severity = ["critical","high","moderate","low"][i % 4];
    const pkg = `${["lodash","express","axios","webpack","babel","eslint","jest","react","vue","angular"][i%10]}@${i%5+1}.${i%10}.${i%3}`;
    const via = `${["prototype-pollution","regex-dos","xss","path-traversal","code-injection"][i%5]}`;
    lines.push(`${pkg}`);
    lines.push(`  Severity: ${severity}`);
    lines.push(`  ${via} - https://github.com/advisories/GHSA-${String.fromCharCode(97+i%26)}${String.fromCharCode(97+(i+5)%26)}${i%10}${i%10}`);
    lines.push(`  Depends on: ${["qs","minimist","node-fetch","glob-parent","json5"][i%5]}`);
    lines.push(`  fix available via \`npm audit fix --force\``);
    lines.push(`  Paths: node_modules/${pkg.split("@")[0]}`);
    lines.push("");
  }
  lines.push(`80 vulnerabilities (20 critical, 20 high, 20 moderate, 20 low)`);
  const r = await runDistill(lines.join("\n"), "execute_command");
  pushResult(11, "npm audit — 80个安全漏洞", r,
    r.distilled && r.tokensAfter < r.tokensBefore * 0.3,
    `80漏洞×严重级别×依赖路径×修复建议`);
}

// ═══════════════════════════════════════════════════════════════════════
// 12. Shader Code — 400-line HLSL/GLSL compute shader
// Source: Unity/Unreal shader AI generation
// ═══════════════════════════════════════════════════════════════════════
async function test12() {
  const lines: string[] = [
    "#version 450",
    "#extension GL_ARB_compute_shader : enable",
    "",
    "// Volumetric Cloud Rendering — Compute Shader",
    "// Based on Horizon Zero Dawn / Red Dead Redemption 2 approach",
    "",
    "layout(local_size_x = 8, local_size_y = 8, local_size_z = 1) in;",
    "",
    "// Uniforms",
    "layout(binding = 0) uniform sampler3D cloudNoiseLow;",
    "layout(binding = 1) uniform sampler3D cloudNoiseHigh;",
    "layout(binding = 2) uniform sampler2D weatherMap;",
    "layout(binding = 3) uniform sampler2D blueNoise;",
    "layout(binding = 4, rgba16f) uniform image2D outputColor;",
    "",
  ];
  // Generate realistic shader function bodies
  const functions = [
    { name: "remapValue", params: "float v, float lo, float hi, float nlo, float nhi", body: "return nlo + (v - lo) / (hi - lo) * (nhi - nlo);" },
    { name: "sampleCloudDensity", params: "vec3 pos, float lod", body: "float noise = texture(cloudNoiseLow, pos * 0.001).r;\nfloat detail = texture(cloudNoiseHigh, pos * 0.01).r;\nfloat weather = texture(weatherMap, pos.xz * 0.0001).r;\nfloat density = remapValue(noise, weather, 1.0, 0.0, 1.0);\ndensity -= (1.0 - detail) * 0.2;\nreturn max(density, 0.0);" },
    { name: "beerLaw", params: "float density, float stepSize", body: "return exp(-density * stepSize);" },
    { name: "henyeyGreenstein", params: "float cosAngle, float g", body: "float g2 = g * g;\nreturn (1.0 - g2) / (4.0 * 3.14159 * pow(1.0 + g2 - 2.0 * g * cosAngle, 1.5));" },
  ];
  for (const fn of functions) {
    lines.push(`float ${fn.name}(${fn.params}) {`);
    for (const bodyLine of fn.body.split("\n")) lines.push(`  ${bodyLine}`);
    lines.push("}");
    lines.push("");
  }
  // Main function with raymarching loop
  lines.push("void main() {");
  lines.push("  ivec2 pixel = ivec2(gl_GlobalInvocationID.xy);");
  lines.push("  vec2 uv = vec2(pixel) / vec2(imageSize(outputColor));");
  for (let i = 0; i < 80; i++) {
    lines.push(`  // Step ${i}: raymarch iteration`);
    lines.push(`  float t${i} = float(${i}) * stepSize;`);
    lines.push(`  vec3 pos${i} = rayOrigin + rayDir * t${i};`);
    lines.push(`  float density${i} = sampleCloudDensity(pos${i}, ${(i*0.01).toFixed(2)});`);
    lines.push(`  if (density${i} > 0.01) { totalDensity += density${i}; lightEnergy *= beerLaw(density${i}, stepSize); }`);
  }
  lines.push("  imageStore(outputColor, pixel, vec4(finalColor, 1.0));");
  lines.push("}");
  const r = await runDistill(lines.join("\n"), "read_file");
  pushResult(12, "Shader代码 — 体积云渲染计算着色器", r,
    r.distilled && r.tokensAfter < r.tokensBefore * 0.5,
    `GLSL 450体积云shader(光线步进80步+4个辅助函数)`);
}

// ═══════════════════════════════════════════════════════════════════════
// 13. Nix flake.lock — 100 dependencies with hashes
// ═══════════════════════════════════════════════════════════════════════
async function test13() {
  const nodes: Record<string, unknown> = {};
  const pkgs = ["nixpkgs", "flake-utils", "rust-overlay", "home-manager", "nix-darwin",
    "devshell", "fenix", "crane", "advisory-db", "pre-commit-hooks"];
  for (let i = 0; i < 100; i++) {
    const pkg = i < 10 ? pkgs[i] : `${pkgs[i%10]}_${Math.floor(i/10)}`;
    nodes[pkg] = {
      locked: {
        lastModified: 1700000000 + i * 86400,
        narHash: `sha256-${Array.from({length:44}, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"[Math.floor(Math.random()*64)]).join("")}`,
        owner: ["NixOS","nix-community","oxalica","numtide","LnL7"][i%5],
        repo: pkg.split("_")[0],
        rev: Array.from({length:40}, () => "0123456789abcdef"[Math.floor(Math.random()*16)]).join(""),
        type: "github"
      },
      original: { owner: ["NixOS","nix-community","oxalica","numtide","LnL7"][i%5], repo: pkg.split("_")[0], type: "github" }
    };
  }
  const content = JSON.stringify({ nodes, root: "root", version: 7 }, null, 2);
  const r = await runDistill(content, "read_file");
  pushResult(13, "Nix flake.lock — 100个依赖锁文件", r,
    r.distilled && r.tokensAfter < r.tokensBefore * 0.4,
    `Nix生态:100包×narHash×rev×owner`);
}

// ═══════════════════════════════════════════════════════════════════════
// 14. API Rate Limit Dashboard — 50 endpoints × 24h metrics
// ═══════════════════════════════════════════════════════════════════════
async function test14() {
  const endpoints = Array.from({length: 50}, (_, i) =>
    `${["GET","POST","PUT","DELETE","PATCH"][i%5]} /api/v2/${["users","orders","products","payments","sessions","events","webhooks","reports","analytics","health"][i%10]}${i > 10 ? `/${["list","detail","create","update","delete"][i%5]}` : ""}`);
  const header = "Endpoint\tRequests/24h\t2xx\t4xx\t5xx\tP50ms\tP95ms\tP99ms\tRate Limited\tQuota Used";
  const rows = endpoints.map(ep => {
    const total = 1000 + Math.floor(Math.random() * 50000);
    const _2xx = Math.floor(total * (0.9 + Math.random() * 0.09));
    const _4xx = Math.floor((total - _2xx) * 0.7);
    const _5xx = total - _2xx - _4xx;
    return `${ep}\t${total}\t${_2xx}\t${_4xx}\t${_5xx}\t${5+Math.floor(Math.random()*45)}\t${50+Math.floor(Math.random()*200)}\t${200+Math.floor(Math.random()*800)}\t${Math.floor(Math.random()*100)}\t${(Math.random()*100).toFixed(1)}%`;
  });
  const content = [header, ...rows].join("\n");
  const r = await runDistill(content, "execute_command");
  pushResult(14, "API速率限制 — 50端点×24h指标", r,
    r.distilled && r.tokensAfter < r.tokensBefore * 0.3,
    `TSV格式:50端点×请求量×状态码×延迟分位×限流`);
}

// ═══════════════════════════════════════════════════════════════════════
// 15. Git blame — 300 lines of a critical file
// ═══════════════════════════════════════════════════════════════════════
async function test15() {
  const authors = ["alice","bob","charlie","diana","eve","frank","grace","henry"];
  const lines: string[] = [];
  for (let i = 0; i < 300; i++) {
    const hash = Array.from({length:8}, () => "0123456789abcdef"[Math.floor(Math.random()*16)]).join("");
    const author = authors[i % 8];
    const date = `2025-${String(1 + i%12).padStart(2,"0")}-${String(1+i%28).padStart(2,"0")}`;
    const code = i % 10 === 0 ? `function ${["init","process","validate","transform","render"][i%5]}(${["data","config","input","state","props"][i%5]}) {` :
      i % 10 === 9 ? "}" : `  ${["const","let","if","return","await"][i%5]} ${["result","value","check","output","response"][i%5]}${i} = ${["null","true","[]","{}","0"][i%5]};`;
    lines.push(`${hash} (${author.padEnd(10)} ${date} ${String(i+1).padStart(4)}) ${code}`);
  }
  const r = await runDistill(lines.join("\n"), "execute_command");
  pushResult(15, "Git blame — 300行关键文件", r,
    r.distilled && r.tokensAfter < r.tokensBefore * 0.3,
    `8位作者×300行×commit hash×日期×代码`);
}

// ═══════════════════════════════════════════════════════════════════════
// 16. Jupyter Notebook JSON — 30 cells with mixed code/output
// ═══════════════════════════════════════════════════════════════════════
async function test16() {
  const cells = Array.from({length: 30}, (_, i) => ({
    cell_type: i % 3 === 0 ? "markdown" : "code",
    source: i % 3 === 0
      ? [`## Step ${Math.floor(i/3) + 1}: ${["Data Loading","Preprocessing","Feature Engineering","Model Training","Evaluation","Visualization"][Math.floor(i/3)%6]}\n`,
         `In this section we ${["load the dataset from CSV","clean and normalize features","create polynomial and interaction features","train a gradient boosting classifier","evaluate using cross-validation","plot confusion matrix and ROC curve"][Math.floor(i/3)%6]}.\n`]
      : [`import pandas as pd\ndf = pd.read_csv('data_${i}.csv')\nprint(df.describe())\nprint(df.shape)\nprint(df.dtypes)\n`],
    outputs: i % 3 !== 0 ? [{
      output_type: "stream",
      text: Array.from({length: 10}, (_, j) => `col_${j}    ${(Math.random()*1000).toFixed(4)}  ${(Math.random()*500).toFixed(4)}  ${(Math.random()*100).toFixed(4)}`).join("\n")
    }] : [],
    metadata: { execution: { "iopub.execute_input": `2025-12-${String(i+1).padStart(2,"0")}T10:${String(i%60).padStart(2,"0")}:00.000Z` } }
  }));
  const content = JSON.stringify({ cells, metadata: { kernelspec: { display_name: "Python 3", language: "python" }, language_info: { name: "python", version: "3.11.0" } }, nbformat: 4 }, null, 2);
  const r = await runDistill(content, "read_file");
  pushResult(16, "Jupyter Notebook — 30个cell混合代码/输出", r,
    r.distilled && r.tokensAfter < r.tokensBefore * 0.5,
    `ipynb JSON:30 cells(markdown+code+output)`);
}

// ═══════════════════════════════════════════════════════════════════════
// 17. Elasticsearch Query Response — nested aggregations
// ═══════════════════════════════════════════════════════════════════════
async function test17() {
  const hits = Array.from({length: 50}, (_, i) => ({
    _index: `logs-${2025}-${String(1+i%12).padStart(2,"0")}`,
    _id: `doc_${i}`,
    _score: (10 - i * 0.1).toFixed(2),
    _source: {
      timestamp: `2025-12-${String(1+i%28).padStart(2,"0")}T${String(i%24).padStart(2,"0")}:${String(i%60).padStart(2,"0")}:00Z`,
      level: ["ERROR","WARN","INFO","DEBUG"][i%4],
      service: ["api","auth","payment","notification","search"][i%5],
      message: `${["Connection timeout","Rate limit exceeded","Invalid token","Database deadlock","Cache miss"][i%5]} for user_${i*100}`,
      metadata: { request_id: `req_${i}`, duration_ms: 50 + Math.floor(Math.random()*5000), status_code: [500,429,401,503,200][i%5] }
    }
  }));
  const response = {
    took: 42, timed_out: false,
    hits: { total: { value: 15000, relation: "gte" }, max_score: 10, hits },
    aggregations: {
      by_service: { buckets: [
        { key: "api", doc_count: 5000, avg_duration: { value: 234.5 }, error_rate: { value: 0.05 } },
        { key: "auth", doc_count: 3000, avg_duration: { value: 156.2 }, error_rate: { value: 0.12 } },
        { key: "payment", doc_count: 2000, avg_duration: { value: 890.1 }, error_rate: { value: 0.08 } },
        { key: "notification", doc_count: 3000, avg_duration: { value: 45.3 }, error_rate: { value: 0.02 } },
        { key: "search", doc_count: 2000, avg_duration: { value: 567.8 }, error_rate: { value: 0.15 } },
      ]},
      by_level: { buckets: [
        { key: "ERROR", doc_count: 1500 }, { key: "WARN", doc_count: 3500 },
        { key: "INFO", doc_count: 8000 }, { key: "DEBUG", doc_count: 2000 },
      ]},
    }
  };
  const content = JSON.stringify(response, null, 2);
  const r = await runDistill(content, "execute_command");
  pushResult(17, "ES查询响应 — 50条hit+嵌套聚合", r,
    r.distilled && r.tokensAfter < r.tokensBefore * 0.5,
    `Elasticsearch:50 hits+服务聚合+级别聚合`);
}

// ═══════════════════════════════════════════════════════════════════════
// 18. Python requirements.txt with pinned versions — 200 packages
// ═══════════════════════════════════════════════════════════════════════
async function test18() {
  const packages = ["numpy","pandas","scikit-learn","tensorflow","torch","transformers","flask","django","fastapi","sqlalchemy",
    "celery","redis","boto3","requests","httpx","pydantic","cryptography","pillow","matplotlib","seaborn",
    "pytest","black","mypy","ruff","isort","coverage","tox","pre-commit","sphinx","mkdocs"];
  const lines: string[] = ["# requirements.txt — ML Platform Production Dependencies", "# Auto-generated by pip-compile", `# Date: ${new Date().toISOString()}`, ""];
  for (let i = 0; i < 200; i++) {
    const pkg = i < 30 ? packages[i] : `${packages[i%30]}-plugin-${Math.floor(i/30)}`;
    const version = `${1+i%5}.${i%20}.${i%10}`;
    const hash = Array.from({length:64}, () => "0123456789abcdef"[Math.floor(Math.random()*16)]).join("");
    lines.push(`${pkg}==${version} \\`);
    lines.push(`    --hash=sha256:${hash}`);
    if (i % 5 === 0) lines.push(`    # via ${packages[(i+3)%30]}`);
  }
  const r = await runDistill(lines.join("\n"), "read_file");
  pushResult(18, "requirements.txt — 200包带hash锁定", r,
    r.distilled && r.tokensAfter < r.tokensBefore * 0.3,
    `Python依赖锁定:200包×版本×sha256 hash`);
}

// ═══════════════════════════════════════════════════════════════════════
// 19. Multi-agent Research Report — 5 agents' combined output
// Source: Redis production agent workflow patterns
// ═══════════════════════════════════════════════════════════════════════
async function test19() {
  const agents = ["Researcher", "Analyst", "Writer", "Reviewer", "Editor"];
  const sections: string[] = [];
  for (const agent of agents) {
    sections.push(`\n${"=".repeat(60)}`);
    sections.push(`Agent: ${agent} — Output`);
    sections.push(`${"=".repeat(60)}\n`);
    for (let p = 0; p < 8; p++) {
      sections.push(`### ${agent} — Finding ${p + 1}`);
      sections.push(`${Array.from({length: 5}, (_, s) =>
        `${["Based on our analysis,","Furthermore,","In addition,","Notably,","As a result,"][s]} the ${["market data","user research","competitive landscape","technical assessment","regulatory environment"][s % 5]} indicates that ${["growth patterns","adoption rates","risk factors","innovation cycles","compliance requirements"][s % 5]} are ${["accelerating","stabilizing","declining","transforming","emerging"][s % 5]} across ${["North America","Europe","Asia Pacific","Latin America","Middle East"][s % 5]} markets with a ${(Math.random() * 30 + 5).toFixed(1)}% ${["increase","decrease","shift","variation","deviation"][s % 5]} year-over-year.`).join(" ")}\n`);
    }
  }
  const content = sections.join("\n");
  const r = await runDistill(content, "execute_command");
  pushResult(19, "多Agent研究报告 — 5个Agent合并输出", r,
    r.distilled && r.tokensAfter < r.tokensBefore * 0.5,
    `5 agents×8 findings×5段分析（Redis场景）`);
}

// ═══════════════════════════════════════════════════════════════════════
// 20. Strace Output — 1000 system calls from a hanging process
// Source: Linux debugging, SRE incident response
// ═══════════════════════════════════════════════════════════════════════
async function test20() {
  const syscalls = ["read", "write", "open", "close", "stat", "fstat", "mmap", "mprotect",
    "brk", "ioctl", "access", "dup2", "execve", "fcntl", "poll", "epoll_wait",
    "futex", "clock_gettime", "nanosleep", "sendto", "recvfrom", "connect"];
  const lines: string[] = [];
  for (let i = 0; i < 500; i++) {
    const sc = syscalls[i % syscalls.length];
    const time = `${Math.floor(i / 60) + 10}:${String(i % 60).padStart(2, "0")}:${String(Math.floor(Math.random()*60)).padStart(2, "0")}.${String(Math.floor(Math.random()*1000000)).padStart(6, "0")}`;
    const fd = Math.floor(Math.random() * 20);
    let args: string;
    switch (sc) {
      case "read": case "write":
        args = `(${fd}, "${Array.from({length:20}, () => String.fromCharCode(32+Math.floor(Math.random()*95))).join("").replace(/["\\\n]/g, ".")}", ${64 + Math.floor(Math.random()*4096)})`; break;
      case "epoll_wait":
        args = `(${fd}, [{EPOLLIN, {u32=${Math.floor(Math.random()*1000)}, u64=${Math.floor(Math.random()*1000000)}}}], 128, ${i % 3 === 0 ? "-1" : String(1000+Math.floor(Math.random()*4000))})`; break;
      case "futex":
        args = `(0x${(0x7f0000000000 + i * 0x100).toString(16)}, FUTEX_WAIT_PRIVATE, ${i % 2}, {tv_sec=${Math.floor(Math.random()*5)}, tv_nsec=${Math.floor(Math.random()*999999999)}})`; break;
      default:
        args = `(${fd}, 0x${(0x7f0000000000 + i * 0x10).toString(16)}, ${Math.floor(Math.random()*4096)})`;
    }
    const ret = sc === "epoll_wait" && i % 10 === 0 ? "= 0 (Timeout)" : `= ${Math.floor(Math.random()*4096)}`;
    lines.push(`[pid 12345] ${time} ${sc}${args} ${ret}`);
  }
  const r = await runDistill(lines.join("\n"), "execute_command");
  pushResult(20, "Strace输出 — 500个系统调用", r,
    r.distilled && r.tokensAfter < r.tokensBefore * 0.30,
    `进程调试:500 syscalls(read/write/epoll/futex)×参数×返回值`);
}

// ═══════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════
async function main() {
  engine = createEngine();
  console.log(`\n${BOLD}${"═".repeat(63)}${RESET}`);
  console.log(`\n${BOLD}  E2E Round 4 Tests — 20 New Real-World Scenarios${RESET}`);
  console.log(`${BOLD}${"═".repeat(63)}${RESET}\n`);

  const tests = [test1, test2, test3, test4, test5, test6, test7, test8, test9, test10,
    test11, test12, test13, test14, test15, test16, test17, test18, test19, test20];
  for (const test of tests) {
    try { await test(); } catch (err) {
      const name = test.name.replace("test", "R4-");
      console.log(`${RED}❌${RESET} ${name} ${RED}ERROR: ${err instanceof Error ? err.message : String(err)}${RESET}`);
    }
  }

  // Summary table
  console.log(`\n${BOLD}${"═".repeat(63)}${RESET}`);
  console.log(`${BOLD}  Summary${RESET}\n`);
  console.log(`  ${BOLD}┌─────┬─────────────────────────────────────────────────┬──────────┬──────────┬────────┐${RESET}`);
  console.log(`  ${BOLD}│  #  │ Test                                            │  Before  │  After   │ Ratio  │${RESET}`);
  console.log(`  ${BOLD}├─────┼─────────────────────────────────────────────────┼──────────┼──────────┼────────┤${RESET}`);
  for (const r of results) {
    const icon = r.passed ? `${GREEN}✅${RESET}` : `${RED}❌${RESET}`;
    const name = r.name.length > 47 ? r.name.slice(0, 44) + "…" : r.name;
    console.log(`  │ ${icon}${String(r.id).padStart(2)} │ ${name.padEnd(47)} │ ${String(r.tokensBefore).padStart(8)} │ ${String(r.tokensAfter).padStart(8)} │ ${r.ratio.padStart(6)} │`);
  }
  console.log(`  ${BOLD}└─────┴─────────────────────────────────────────────────┴──────────┴──────────┴────────┘${RESET}`);

  const totalBefore = results.reduce((s, r) => s + r.tokensBefore, 0);
  const totalAfter = results.reduce((s, r) => s + r.tokensAfter, 0);
  console.log(`\n  Total tokens: ${totalBefore.toLocaleString()} → ${totalAfter.toLocaleString()} (${(totalAfter/totalBefore*100).toFixed(1)}%)`);
  console.log(`  Saved: ${(totalBefore - totalAfter).toLocaleString()} tokens`);

  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  if (passed === total) {
    console.log(`\n${GREEN}${BOLD}  ${passed}/${total} ROUND 4 TESTS PASSED ✅${RESET}\n`);
  } else {
    console.log(`\n${RED}${BOLD}  ${passed}/${total} ROUND 4 TESTS PASSED ❌${RESET}\n`);
  }

  process.exit(passed === total ? 0 : 1);
}

main();
