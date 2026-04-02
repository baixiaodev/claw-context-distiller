# context-distiller

Intelligent context compression for OpenClaw.

`context-distiller` reduces token waste before verbose content enters the context window, while trying to preserve the signal that actually matters: errors, summaries, search results, structured data, file paths, and representative samples.

It works across two major paths:

1. **tool_result_persist** — compresses verbose tool results before persistence
2. **before_message_write** — applies **Layered Recall** to oversized user/assistant messages

---

## Why this exists

OpenClaw sessions often accumulate a lot of low-value bulk content:
- large test logs
- install/build output
- file listings
- grep results
- long diffs
- JSON/API responses
- users pasting huge logs into chat

Without compression, this kind of content wastes context window budget and makes downstream reasoning worse.

`context-distiller` tries to keep the useful parts while shrinking the rest.

---

## Core capabilities

### Tool-result compression
For verbose tool outputs, the plugin can:
- remove repetition
- extract error-heavy lines
- summarize JSON / API responses
- summarize file listings
- compress diffs
- apply domain-aware compression for structured content like CSV and BibTeX

### Layered Recall for long messages
For oversized user/assistant messages, the plugin builds a structured envelope instead of keeping the full raw content directly in context.

Depending on the input, the envelope may contain:
- **Keypoint Summary**
- **Representative Samples**
- **Section Index**
- **Full-text Access** pointer

This helps the agent retain a compact understanding of a large message while keeping a path back to the original content.

### Content-aware handling
The plugin distinguishes between content types such as:
- search results
- API responses
- error-heavy outputs
- file listings
- environment/config dumps
- docker/kubernetes listings
- tabular data

Different content types receive different compression strategies.

---

## Installation

### Local/path install
Install the plugin into your OpenClaw plugin directory and enable it in config.

### Marketplace / ClawHub install
Install from ClawHub and enable the plugin entry in your OpenClaw config.

### Example config
```json
{
  "plugins": {
    "entries": {
      "context-distiller": {
        "enabled": true,
        "config": {
          "toolOutputMaxTokens": 1200,
          "patchMaxTokens": 600,
          "fileContentMaxTokens": 1000,
          "messageMaxTokens": 3000,
          "messageSummaryMaxLines": 40,
          "aggressiveness": "moderate"
        }
      }
    }
  }
}
```

---

## Configuration

| Option | Default | Purpose |
|---|---:|---|
| `enabled` | `true` | Master switch |
| `toolOutputMaxTokens` | `1200` | Threshold for tool output compression |
| `patchMaxTokens` | `600` | Threshold for diff/patch compression |
| `fileContentMaxTokens` | `1000` | Threshold for inline file content compression |
| `messageMaxTokens` | `3000` | Threshold for Layered Recall on user/assistant messages |
| `messageSummaryMaxLines` | `40` | Maximum lines retained in summary sections |
| `aggressiveness` | `moderate` | Compression aggressiveness (`conservative`, `moderate`, `aggressive`) |
| `distillModel` | optional | LLM model override |
| `distillProvider` | optional | LLM provider override |

---

## Recommended presets

### Conservative
Best when detail preservation matters most.

```json
{
  "aggressiveness": "conservative",
  "toolOutputMaxTokens": 1600,
  "patchMaxTokens": 900,
  "fileContentMaxTokens": 1400,
  "messageMaxTokens": 4000,
  "messageSummaryMaxLines": 60
}
```

### Balanced (recommended)
Good default for most users.

```json
{
  "aggressiveness": "moderate",
  "toolOutputMaxTokens": 1200,
  "patchMaxTokens": 600,
  "fileContentMaxTokens": 1000,
  "messageMaxTokens": 3000,
  "messageSummaryMaxLines": 40
}
```

### Aggressive
Best when you deal with huge logs constantly and want stronger compression.

```json
{
  "aggressiveness": "aggressive",
  "toolOutputMaxTokens": 900,
  "patchMaxTokens": 450,
  "fileContentMaxTokens": 800,
  "messageMaxTokens": 2200,
  "messageSummaryMaxLines": 28
}
```

---

## Example Layered Recall envelope

```md
`[LAYERED RECALL] user message: 344 lines, 20,239 chars → ~4,048 chars (84.9% compression)`

## Keypoint Summary
- 5 failed, 145 passed
- TimeoutError: Request timed out after 30s
- AssertionError in test_order_calculation

## Representative Samples
- test_models.py::test_user_validation FAILED
- E AssertionError: expected username to be valid
- test_integration.py::test_end_to_end_workflow FAILED

## Section Index
- L1-L88: build output ...
- L89-L214: failing tests ...
- L215-L344: summary and tracebacks ...

## Full-text Access
Session ID: `...`
Original size: 344 lines, 20,239 chars
```

---

## Quality / benchmark snapshot

Internal long-message evaluation (30 cases):

| Metric | Current Result |
|---|---:|
| Keypoint Summary coverage | 23/30 |
| Representative Samples coverage | 7/30 |
| Multi-section coverage | 30/30 |
| Summary budget compliance | 30/30 |
| High-information envelopes | 13/30 |
| Medium-information envelopes | 17/30 |
| Weak envelopes | 0/30 |

### Why this benchmark matters
Earlier internal scoring over-penalized outputs that used structured summaries or representative samples instead of classic Keypoint Summary blocks. The current benchmark reflects all major envelope signal channels, not just one summary format.

---

## Best-fit use cases

`context-distiller` works especially well for:
- test results
- tracebacks / compiler errors
- grep/path-heavy output
- file listings
- commit logs / change history
- environment/config dumps
- repeated terminal output
- long pasted logs and reports

---

## When not to use it

This plugin may be a poor fit if:
- you require strict verbatim preservation of all content in context
- you mostly work with small, already concise messages
- you do not want any automatic compression before persistence

---

## Internal test exports

The plugin exposes several `_test*` exports for internal validation:
- `_testDistillSync`
- `_testAnalyzeContent`
- `_testSyncHeadTailTruncation`
- `_testSyncLayeredRecall`

These are **internal testing interfaces**, not stable public APIs.

---

## Known limitations

See [KNOWN_LIMITATIONS.md](./KNOWN_LIMITATIONS.md).

---

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

---

## License

MIT
