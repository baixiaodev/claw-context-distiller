# context-distiller

> Intelligent context distillation plugin for [OpenClaw](https://github.com/nicepkg/openclaw) — reduces context noise by compressing verbose tool outputs, patches, file content, and oversized user/assistant messages before they enter the context window.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-blue)](https://github.com/nicepkg/openclaw)

---

## Why context-distiller?

When AI agents work on complex tasks, they generate massive amounts of context: tool outputs, file reads, search results, diffs, and logs. This verbose content fills up the context window fast, causing:

- **Context overflow** — the LLM silently drops important earlier messages
- **Degraded reasoning** — too much noise drowns out the signal
- **Higher costs** — more tokens = more money

**context-distiller** hooks into OpenClaw's message pipeline and compresses verbose content *before* it enters the context engine. Think of it as a smart filter that keeps the important bits and throws away the noise.

In the current version, this now applies to two major paths:
- **tool_result_persist** for verbose tool output
- **before_message_write** for oversized user/assistant messages via **Layered Recall**

### Results from real-world testing (20 research scenarios):

| Metric | Value |
|--------|-------|
| Total distillations | 98 |
| Tokens saved | **636,186** |
| Avg. compression | 65-85% on verbose outputs |
| Rules triggered | 9 different compression strategies |
| False positives | 0 (small content passes through untouched) |

---

## Architecture

```
User Query → Agent → Tool Call → Tool Result
                                      ↓
                        ┌─────────────────────────┐
                        │   tool_result_persist    │  ← sync hook (primary)
                        │                         │
                        │  1. Content Analysis     │  detect value: search/API/log/help/error
                        │  2. Budget Adjustment    │  high-value → 4x budget, low-value → 0.6x
                        │  3. Rule Pipeline        │  6 rules sorted by priority
                        │  4. distillSync()        │  pure synchronous, no Promises
                        │                         │
                        └────────────┬────────────┘
                                     ↓
                        ┌─────────────────────────┐
                        │  before_message_write    │  ← sync hook (secondary path)
                        │                         │
                        │  Path 1: tool messages   │  head+tail safety net
                        │  Path 2: large user/     │  Layered Recall envelope
                        │          assistant msgs  │
                        └────────────┬────────────┘
                                     ↓
                          Context Engine (LCM)
                        e.g. lossless-claw
```

### Design Principles

1. **Enhance, don't replace** — Works alongside any context engine (lossless-claw, built-in, etc.)
2. **Content-aware intelligence** — Different content types get different treatment. Search results are preserved; install logs are aggressively compressed.
3. **Pure synchronous execution** — Gateway's `tool_result_persist` hook is strictly sync. All distillation runs without async/await/Promise.
4. **Graceful degradation** — If a rule fails, the content passes through unchanged. If stats I/O fails, distillation continues.
5. **Observable** — Persistent statistics survive Gateway restarts. Agent tools let you inspect and tune at runtime.

### Content Intelligence Layer

Before applying any compression rules, the plugin analyzes content to determine its value:

| Content Type | Value | Budget Multiplier | Strategy |
|-------------|-------|-------------------|----------|
| Search results (Tavily/Google/Bing JSON) | Critical | 4.0× | Structured JSON summary preserving URLs/titles/snippets |
| API responses (web_fetch, structured JSON) | High | 4.0× | JSON summary with leading paragraphs preserved |
| URL-rich content | High | 2.5× | Smart truncation |
| Error output | Medium | 1.2× | Error line extraction + head/tail |
| Generic tool output | Medium | 1.0× | Standard rule pipeline |
| Install/build logs | Low | 0.8× | Aggressive head+tail |
| Usage/help text | Low | 0.6× | Aggressive head+tail |

### Rule Pipeline (by priority)

| Priority | Rule | Applies To | Strategy |
|----------|------|-----------|----------|
| P4 | `domain-aware` | file_content, tool_output | BibTeX bibliography → compact listing; CSV/TSV → stats + samples; Markdown → heading skeleton |
| P5 | `repetition-elimination` | tool_output, file_content, text | 4-tier dedup: records → lines → blocks → templates. JSON excluded (routed to dedicated JSON summary) |
| P8 | `error-extraction` | tool_output | Preserves error/warning/summary lines from verbose logs. Prevents the "buried error" problem |
| P10 | `tool-output-truncation` | tool_output | JSON summary → file listing summary → LLM summary → head+tail truncation |
| P10 | `patch-distill` | patch | Keeps changed lines (+/-) with configurable context. Falls back to stats-only for huge diffs |
| P10 | `file-content-distill` | file_content | Config JSON → code structural summary (imports + definitions) → LLM summary → truncation |

### Persistent Statistics

Gateway reloads plugins on every request (stateless architecture). To maintain cumulative stats across restarts, context-distiller uses a `.stats.json` sidecar file with:
- Throttled writes (≤ 1 per 5 seconds)
- Atomic POSIX rename for crash safety
- Graceful degradation if disk I/O fails

---

## Installation

### From source (local path)

```bash
# Clone the repo
git clone https://github.com/baixiaodev/context-distiller.git ~/.openclaw/extensions/context-distiller

# Install dependencies (shares with other OpenClaw plugins)
cd ~/.openclaw/extensions/context-distiller
npm install
```

### Register in openclaw.json

Add the following to your `openclaw.json`:

```jsonc
{
  "plugins": {
    // 1. Allow the plugin
    "allow": [
      // ... existing plugins ...
      "context-distiller"
    ],

    // 2. Configure it
    "entries": {
      "context-distiller": {
        "enabled": true,
        "config": {
          "toolOutputMaxTokens": 1200,
          "patchMaxTokens": 600,
          "fileContentMaxTokens": 1000,
          "messageMaxTokens": 3000,
          "messageSummaryMaxLines": 40,
          "aggressiveness": "moderate",
          "distillModel": "ollama/qwen3:8b"  // optional, for LLM-powered summarization
        }
      }
    },

    // 3. Register install path
    "installs": {
      "context-distiller": {
        "source": "path",
        "installPath": "/path/to/.openclaw/extensions/context-distiller",
        "version": "0.1.0"
      }
    }
  }
}
```

### Restart Gateway

```bash
openclaw gateway restart
# or: launchctl kickstart -k user/$(id -u)/com.openclaw.gateway
```

### Verify

Check Gateway logs for:
```
[context-distiller] Plugin loaded #1 (enabled=true, aggressiveness=moderate, toolMax=1200, patchMax=600, fileMax=1000, rules=6, lifetime: 0 distillations, 0 tokens saved)
```

Or ask your agent:
```
> Use the distill_status tool
```

---

## Configuration

### Config Parameters

| Parameter | Default | Range | Description |
|-----------|---------|-------|-------------|
| `enabled` | `true` | — | Master switch |
| `toolOutputMaxTokens` | `1200` | 100–5000 | Threshold for tool output distillation |
| `patchMaxTokens` | `600` | 100–3000 | Threshold for diff/patch distillation |
| `fileContentMaxTokens` | `1000` | 200–5000 | Threshold for file content distillation |
| `messageMaxTokens` | `3000` | 500–10000 | Threshold for Layered Recall on oversized user/assistant messages |
| `messageSummaryMaxLines` | `40` | 5–200 | Max summary lines retained inside Layered Recall envelopes |
| `aggressiveness` | `"moderate"` | conservative / moderate / aggressive | Controls compression intensity |
| `preservePatterns` | `[]` | Array of regex strings | Content matching these patterns is never distilled |
| `distillModel` | `"ollama/qwen3:8b"` | Any model ref | Model for LLM-powered summarization (optional) |
| `distillProvider` | — | Provider ID | Override provider for distill LLM calls |

### Aggressiveness Multipliers

The aggressiveness level applies a multiplier to all token thresholds:

| Level | Multiplier | Effect |
|-------|-----------|--------|
| `conservative` | 1.5× | Thresholds 50% higher → less distillation, more detail preserved |
| `moderate` | 1.0× | Thresholds as configured |
| `aggressive` | 0.6× | Thresholds 40% lower → more distillation, maximum token savings |

### Environment Variable Overrides

Environment variables take highest precedence:

```bash
CONTEXT_DISTILLER_ENABLED=true
CONTEXT_DISTILLER_AGGRESSIVENESS=aggressive
CONTEXT_DISTILLER_TOOL_MAX_TOKENS=800
CONTEXT_DISTILLER_PATCH_MAX_TOKENS=400
CONTEXT_DISTILLER_FILE_MAX_TOKENS=600
CONTEXT_DISTILLER_MODEL=ollama/qwen3:8b
CONTEXT_DISTILLER_PROVIDER=ollama
```

### Runtime Configuration

Your agent can adjust settings on the fly:

```
> Use distill_configure to set aggressiveness to aggressive
> Use distill_configure to set toolOutputMaxTokens to 800
```

---

## Agent Tools

### `distill_status`

Shows lifetime and session statistics, rule hit counts, and current configuration.

```
> Show me the distill status

## Context Distiller Status

### 📊 Lifetime Statistics (across all sessions)
- Total distillations: **98**
- Total tokens saved: **636,186**
- Plugin loaded: 44 time(s)

### Rule Hit Counts (lifetime)
- smart/search-results: 31
- tool-output-truncation/head-tail: 28
- smart/api-response: 15
- tool-output-truncation/listing: 11
- ...
```

Supports `--reset` to zero out all stats.

### `distill_configure`

Adjust configuration at runtime without restarting:

```
> Set the distiller to aggressive mode and lower tool output threshold to 800

Configuration updated: {
  "aggressiveness": "aggressive",
  "toolOutputMaxTokens": 800
}
```

---

## Use Cases

### 1. Research & Analysis Tasks

When agents perform web searches (Tavily, Google, Bing), results are often 3,000–8,000+ tokens of JSON. context-distiller:
- **Detects** search result JSON structure (url + title + snippet pattern)
- **Preserves** URLs, titles, and snippet previews
- **Compresses** 5,000 tokens → 800–1,200 tokens (75–85% reduction)

### 2. Code Exploration & Refactoring

Reading large source files (1,000+ lines) fills the context fast. context-distiller:
- **Extracts** imports, exports, function/class signatures
- **Compresses** 14,500 tokens → 820 tokens (94% reduction for structural summary)
- **Preserves** the code skeleton the agent needs for reasoning

### 3. DevOps & SRE Workflows

CI/CD logs, K8s pod logs, and build outputs are notoriously verbose. context-distiller:
- **Extracts** error/warning/failure lines from 10K+ line logs
- **Preserves** stack traces and exit codes
- **Eliminates** repeated log patterns (4-tier dedup)

### 4. Data Analysis

Large JSON API responses, CSV datasets, and database query results. context-distiller:
- **Summarizes** JSON arrays with field distribution + sample entries
- **Compresses** CSV to column stats + sample rows
- **Preserves** schema information for agent reasoning

### 5. Documentation & Config Files

Reading entire config files (package.json, openclaw.json, Terraform .tf). context-distiller:
- **Compresses** JSON configs to key structure + truncated values
- **Preserves** top-level keys and nested structure overview

---

## Layered Recall

For oversized user/assistant messages, context-distiller now builds a structured envelope instead of passing the full raw message directly into context.

Depending on the content, the envelope may include:
- **Keypoint Summary**
- **Representative Samples**
- **Section Index**
- **Full-text Access** pointer

This is designed to preserve compact, actionable understanding — not a lossless mirror of the original message.

### Long-message quality snapshot

| Metric | Result |
|---|---:|
| Keypoint Summary coverage | 23/30 |
| Representative Samples coverage | 7/30 |
| Multi-section coverage | 30/30 |
| Summary budget compliance | 30/30 |
| High-information envelopes | 13/30 |
| Medium-information envelopes | 17/30 |
| Weak envelopes | 0/30 |

---

## Working with Other Plugins

### With lossless-claw (Context Engine)

**Recommended combination.** context-distiller reduces the raw input *before* lossless-claw manages the context window:

```
Tool Output (10K tokens)
    → context-distiller (reduces to 1.2K tokens)
        → lossless-claw (manages context window lifecycle)
```

This means lossless-claw has less work to do and can maintain more conversation turns in context.

### With hybrid-memory (Memory Plugin)

context-distiller and hybrid-memory operate at different layers:
- **context-distiller**: compresses messages *before* session persistence
- **hybrid-memory**: provides long-term recall *across* sessions

They don't interfere with each other. The distilled content that gets persisted to the session is what hybrid-memory indexes — which is actually beneficial, since it indexes the *essential* information without noise.

### With acpx (Agent-to-Agent Communication)

When Agent A delegates to Agent B (via ACP), tool results from Agent B go through context-distiller on Agent A's side. This is particularly useful when research sub-agents (e.g., Odin) return large search result payloads.

---

## Known Risks & Limitations

### 1. Information Loss (by design)

Distillation is lossy compression. Some information is inevitably lost:
- **Head+tail truncation** loses middle content (mitigated by error extraction)
- **Code structural summary** loses function bodies (only keeps signatures)
- **JSON summary** shows samples, not complete data

**Mitigation**: Use `preservePatterns` to protect critical content. Set `aggressiveness: "conservative"` for sensitive workflows.

### 2. Sync Hook Constraints

Gateway's `tool_result_persist` hook is strictly synchronous. This means:
- No async/await in the hot path (LLM summarization only available in the async engine path)
- The sync `distillSync()` function (~250 lines) duplicates some rule logic from the async engine
- LLM-powered summarization is only triggered through the async `distill()` path (via `before_message_write` or direct engine calls)

### 3. Gateway Stateless Architecture

Gateway reloads plugins on every request. In-memory session stats reset each time. The `.stats.json` sidecar file mitigates this, but:
- Stats writes are throttled to 5-second intervals (may miss the last distillation if Gateway restarts immediately)
- `distill_status` "Current Session" always shows 0 after restart (by design)

### 4. CJK Token Estimation

Token estimation uses a heuristic (CJK ~1.5 tokens/char, ASCII ~4 chars/token). This is approximate and may under/over-estimate for specific content. The estimation matches lossless-claw's convention for consistency.

### 5. Search Result Detection

The plugin detects search results by JSON structure heuristics (url + title + snippet fields). Non-standard search APIs may not be detected, causing their results to be treated as generic JSON.

### 6. Gateway Agent Timeout (~300s)

For complex research tasks that take >5 minutes, the Gateway may timeout the agent response while the agent is still working. This is a Gateway-level issue (not a context-distiller issue) but affects the end-to-end experience. See [Gateway Agent Timeout](#gateway-agent-timeout) section.

For the current user-facing limitation set, also see [`KNOWN_LIMITATIONS.md`](./KNOWN_LIMITATIONS.md).

---

## File Structure

```
context-distiller/
├── index.ts                    # Plugin entry + hook registration + sync distillation engine
├── package.json                # NPM package definition (ESM, openclaw peer dep)
├── openclaw.plugin.json        # Configuration schema + UI hints
├── tsconfig.json               # TypeScript config
├── README.md                   # This file
├── LICENSE                     # MIT License
├── CHANGELOG.md                # Version history
├── .gitignore                  # Git ignore rules
└── src/
    ├── types.ts                # Core types (DistillerConfig, DistillRule, PartCategory, etc.)
    ├── config.ts               # Three-tier config resolution (env > plugin > defaults)
    ├── tokens.ts               # CJK-aware token estimation
    ├── distiller.ts            # Async distillation engine (DistillerEngine class)
    ├── stats-store.ts          # Persistent statistics (.stats.json sidecar)
    └── rules/
        ├── index.ts            # Barrel export
        ├── domain-aware.ts     # BibTeX / CSV / Markdown compression (P4)
        ├── repetition.ts       # 4-tier dedup: records → lines → blocks → templates (P5)
        ├── error-extraction.ts # Error/warning line preservation (P8)
        ├── tool-output.ts      # JSON summary / file listing / head+tail (P10)
        ├── patch-distill.ts    # Unified diff compression (P10)
        └── file-content.ts     # Code structure / config compression (P10)
```

---

## Testing

The test suite covers **229 assertions** across 4 test tiers:

```bash
# Run unit tests (144 assertions)
npx tsx test/run-tests.ts

# Run E2E tests with real data
npx tsx test/e2e-real-world.ts          # 10 scenarios
npx tsx test/e2e-edge-cases.ts          # 15 edge cases
npx tsx test/e2e-professional-scenarios.ts  # 20 professional domains
npx tsx test/e2e-round4-scenarios.ts    # 20 advanced scenarios
```

### Live Testing (requires running Gateway)

```bash
# Integration test against live Gateway
npx tsx test/integration-test.ts

# 20-case real-world research scenarios
npx tsx test/e2e-20cases-v2.ts
```

---

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-rule`)
3. Write tests for your changes
4. Run the test suite: `npx tsx test/run-tests.ts`
5. Commit your changes (`git commit -m 'Add amazing rule'`)
6. Push to the branch (`git push origin feature/amazing-rule`)
7. Open a Pull Request

### Adding a New Rule

1. Create `src/rules/your-rule.ts` implementing the `DistillRule` interface
2. Export it from `src/rules/index.ts`
3. Register it in `index.ts` with appropriate priority
4. Add sync implementation in `distillSync()` if needed (for `tool_result_persist` hook)
5. Add tests

---

## License

MIT License — see [LICENSE](LICENSE) for details.

---

## Credits

Built by [Yuan](https://github.com/baixiaodev) for the OpenClaw ecosystem.

Inspired by research on context window optimization:
- [LLMLingua](https://arxiv.org/abs/2310.05736) — prompt compression
- [Chroma Context Rot](https://research.trychroma.com/context-rot) — context degradation analysis
- [Azure SRE Agent](https://arxiv.org/abs/2403.07634) — agent-based SRE automation
