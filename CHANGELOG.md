# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-04-02

### Added

- **Layered Recall** for oversized user/assistant messages
- **Representative Samples** fallback for low-signal long messages
- Section splitting support for labeled separators such as `--- Section 2 ---`
- Structured keypoint extraction for:
  - table headers
  - env/config lines (`KEY=value`)
  - path/grep/compiler/traceback lines
  - CSV/TSV/pipe-style field headers
- Content-aware Layered Recall routing via `analyzeContent()`
- Summary budget cap for Layered Recall
- Lightweight subtype summarizers for:
  - env/config-like output
  - kubectl pod listings
  - docker image listings
  - du-like directory size listings
  - CSV-like tabular content
  - docker build logs
  - Terraform plan summaries
  - git status output
  - lsof output
- `KNOWN_LIMITATIONS.md` user-facing limitations document

### Changed

- Improved Section Index quality for long pasted logs
- Reduced low-information envelopes in long-message handling
- Better preservation of structured signal under heavy compression
- Better control of overlong summaries in Layered Recall
- Updated quality benchmark model to score Keypoint Summary, Representative Samples, Section Index, and summary budget compliance together

### Quality

Long-message quality progression across internal 30-case evaluation:

| Stage | KP Coverage | Weak Envelopes |
|---|---:|---:|
| Previous baseline | 6/30 | 24 |
| P0 | 14/30 | 16 |
| P1 | 19/30 | 11 |
| P2-A | 21/30 | 9 |
| P2-B | 23/30 | 7 |
| Final scored benchmark | **23/30 KP, 0/30 weak** |

## [0.1.0] - 2026-03-21

### Added

- **Core distillation engine** with 6 pluggable rules sorted by priority
- **Content intelligence layer** — automatic detection of search results, API responses, install logs, help text, and error output with dynamic budget adjustment
- **Rule: domain-aware (P4)** — BibTeX bibliography compression, CSV/TSV statistical summary, Markdown skeleton extraction
- **Rule: repetition-elimination (P5)** — 4-tier dedup system: multi-line records → exact line dedup → block dedup → template pattern dedup
- **Rule: error-extraction (P8)** — preserves error/warning/failure lines from verbose logs before truncation
- **Rule: tool-output-truncation (P10)** — JSON structural summary, file listing summary, LLM-powered summarization, head+tail truncation
- **Rule: patch-distill (P10)** — unified diff compression keeping changed lines with configurable context
- **Rule: file-content-distill (P10)** — code structural summary (imports + definitions), JSON config compression, LLM summary
- **Sync hook implementation** — pure synchronous `distillSync()` for Gateway's `tool_result_persist` hook (no Promise/async/await)
- **Persistent statistics** — `.stats.json` sidecar with throttled atomic writes, survives Gateway restarts
- **Agent tools** — `distill_status` (view stats + config) and `distill_configure` (runtime tuning)
- **Three-tier configuration** — env vars > plugin config > defaults, with aggressiveness multipliers
- **CJK-aware token estimation** — consistent with lossless-claw convention (CJK/1.5 + ASCII/4)
- **Search result preservation** — structured JSON summary preserving URLs, titles, snippets (prevents the "6 token disaster")
- **API response body preservation** — paragraph-level truncation with metadata extraction (budgetMultiplier 4.0×)

### Fixed

- **P0: Search results over-compression** — Tavily/Google search JSON was being head-tail truncated to 6 tokens. Now detected and summarized with structured preservation
- **P0: Sync hook execution** — Gateway's tool_result_persist is strictly sync; Promise.then callbacks were silently ignored. Replaced with pure sync implementation
- **P1: web_fetch body loss** — API response budgetMultiplier increased from 2.5× to 4.0×, added paragraph-level body preservation

### Testing

- 229 automated test assertions (144 unit + 85 E2E)
- 20-case live research scenario testing (20/20 passed)
- 9 live Gateway integration scenarios
- Cumulative: 98 distillations, 636,186 tokens saved
