# Known Limitations

This document describes the current boundaries of `context-distiller` so users know what to expect before installing it.

## 1. Compression quality depends on content shape
The plugin performs best when the input contains recognizable structure or signal, such as:
- error lines
- summary lines
- repeated records
- recognizable JSON/API layouts
- file/path-heavy output
- long messages with section markers

It performs less elegantly on content that is both:
- highly repetitive, and
- weakly structured semantically

## 2. Not every structured output gets a perfect summary
Some content types are currently handled by lightweight subtype summarizers.
These are usually usable, but not always elegant.
Examples include:
- some CSV layouts
- some Terraform plan variants
- some kubectl output variants
- some docker image/build formats
- some API responses with unusual JSON shapes
- some lsof-style outputs

## 3. Layered Recall is compact understanding, not lossless retention
For oversized user/assistant messages, Layered Recall creates a compressed envelope.
This is intended to preserve actionable understanding, not a perfect semantic mirror of the original message.
If exact original text matters, the full transcript should still be retrieved.

## 4. Different paths may produce different-looking summaries
The plugin has two major processing paths:
- tool-result compression
- long-message Layered Recall

The same raw content can therefore look somewhat different depending on where it entered the pipeline.
This is expected behavior, not necessarily a bug.

## 5. Heuristic content classification can miss edge cases
Content analysis is heuristic-based.
For unusual or mixed-format input, the plugin may choose a non-optimal summary strategy.
Fallback behavior exists, but the selected summary may not always be the most informative possible one.

## 6. Internal test exports are not public API
The plugin exposes `_test*` helpers for validation and regression testing.
These are internal-only interfaces and may change without notice.

## 7. Advanced users should still validate presets for their own workload
The documented presets are a strong starting point, but users with unusually large logs, niche output formats, or high-detail requirements should validate them against their own usage patterns.
