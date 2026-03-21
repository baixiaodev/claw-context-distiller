/**
 * stats-store.ts — Persistent statistics storage for context-distiller
 *
 * Problem: Gateway reloads plugins on every request, so in-memory stats
 * (DistillerEngine.stats) are lost between requests. This makes
 * `distill_status` always show zeros, misleading users into thinking
 * the plugin isn't working.
 *
 * Solution: A lightweight JSON file sidecar that accumulates stats
 * across Gateway restarts and request cycles. The file is:
 *   ~/.openclaw/extensions/context-distiller/.stats.json
 *
 * Design decisions:
 *   - fs.readFileSync / fs.writeFileSync — plugin hooks are sync
 *   - Throttled writes: at most once per 5 seconds to avoid I/O spam
 *   - Atomic-ish: write to .tmp then rename (rename is atomic on POSIX)
 *   - Graceful degradation: if disk I/O fails, stats just won't persist
 *   - File size: ~300 bytes — negligible
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface PersistedStats {
  /** Total distillations across all sessions */
  totalDistillations: number;
  /** Total tokens saved across all sessions */
  totalTokensSaved: number;
  /** Total messages processed across all sessions */
  totalMessagesProcessed: number;
  /** Per-rule hit counts across all sessions */
  ruleHits: Record<string, number>;
  /** Timestamp of the very first distillation ever */
  firstDistilledAt: number | null;
  /** Timestamp of the most recent distillation */
  lastDistilledAt: number | null;
  /** How many times the plugin was loaded (i.e., Gateway requests served) */
  loadCount: number;
  /** Schema version for forward compatibility */
  version: number;
}

const SCHEMA_VERSION = 1;

function emptyStats(): PersistedStats {
  return {
    totalDistillations: 0,
    totalTokensSaved: 0,
    totalMessagesProcessed: 0,
    ruleHits: {},
    firstDistilledAt: null,
    lastDistilledAt: null,
    loadCount: 0,
    version: SCHEMA_VERSION,
  };
}

export class StatsStore {
  private filePath: string;
  private stats: PersistedStats;
  private dirty = false;
  private lastWriteAt = 0;
  private writeThrottleMs: number;

  constructor(pluginDir: string, throttleMs = 5000) {
    this.filePath = path.join(pluginDir, ".stats.json");
    this.writeThrottleMs = throttleMs;
    this.stats = this.load();
    this.stats.loadCount++;
    this.dirty = true;
    this.flushIfNeeded(); // Persist the incremented loadCount
  }

  /**
   * Load persisted stats from disk. Returns empty stats if file
   * doesn't exist or is corrupted.
   */
  private load(): PersistedStats {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.version === SCHEMA_VERSION) {
        return {
          totalDistillations: Number(parsed.totalDistillations) || 0,
          totalTokensSaved: Number(parsed.totalTokensSaved) || 0,
          totalMessagesProcessed: Number(parsed.totalMessagesProcessed) || 0,
          ruleHits: parsed.ruleHits && typeof parsed.ruleHits === "object"
            ? parsed.ruleHits
            : {},
          firstDistilledAt: parsed.firstDistilledAt ?? null,
          lastDistilledAt: parsed.lastDistilledAt ?? null,
          loadCount: Number(parsed.loadCount) || 0,
          version: SCHEMA_VERSION,
        };
      }
    } catch {
      // File doesn't exist or is corrupted — start fresh
    }
    return emptyStats();
  }

  /**
   * Record a single distillation event.
   * Called from the sync hook — must be fast.
   */
  recordDistillation(tokensSaved: number, rule: string): void {
    this.stats.totalDistillations++;
    this.stats.totalTokensSaved += tokensSaved;
    this.stats.totalMessagesProcessed++;
    this.stats.ruleHits[rule] = (this.stats.ruleHits[rule] ?? 0) + 1;
    const now = Date.now();
    if (!this.stats.firstDistilledAt) {
      this.stats.firstDistilledAt = now;
    }
    this.stats.lastDistilledAt = now;
    this.dirty = true;
    this.flushIfNeeded();
  }

  /**
   * Throttled write — at most once per `writeThrottleMs`.
   * Uses rename for atomic writes on POSIX.
   */
  private flushIfNeeded(): void {
    if (!this.dirty) return;
    const now = Date.now();
    if (now - this.lastWriteAt < this.writeThrottleMs) return;

    try {
      const tmpPath = this.filePath + ".tmp";
      const json = JSON.stringify(this.stats, null, 2);
      fs.writeFileSync(tmpPath, json, "utf-8");
      fs.renameSync(tmpPath, this.filePath);
      this.dirty = false;
      this.lastWriteAt = now;
    } catch {
      // Disk I/O failure — graceful degradation, stats just won't persist this cycle
    }
  }

  /**
   * Force flush — called at the end of register() to ensure
   * any pending stats are written even if throttle hasn't expired.
   */
  flush(): void {
    if (!this.dirty) return;
    try {
      const tmpPath = this.filePath + ".tmp";
      const json = JSON.stringify(this.stats, null, 2);
      fs.writeFileSync(tmpPath, json, "utf-8");
      fs.renameSync(tmpPath, this.filePath);
      this.dirty = false;
      this.lastWriteAt = Date.now();
    } catch {
      // Graceful degradation
    }
  }

  /**
   * Get the accumulated persistent stats for display.
   */
  getStats(): Readonly<PersistedStats> {
    return { ...this.stats };
  }

  /**
   * Reset persistent stats (user-initiated via distill_status --reset).
   */
  reset(): void {
    const loadCount = this.stats.loadCount; // Preserve load count
    this.stats = emptyStats();
    this.stats.loadCount = loadCount;
    this.dirty = true;
    this.flush();
  }
}
