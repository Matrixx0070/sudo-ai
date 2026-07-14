/**
 * SurvivalProbe — model availability probing and migration history.
 * Extracted to keep survival.ts under 300 lines.
 */

import Database from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import { getProviderApiKey, llmFetch, type ProviderKeyName } from '../../llm/client.js';
import { XAI_MODELS_URL, OPENAI_MODELS_URL, ANTHROPIC_MODELS_URL } from '../../llm/endpoints.js';

const log = createLogger('persistence:probe');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ModelMigration {
  fromModel:  string;
  toModel:    string;
  reason:     string;
  migratedAt: string;
  success:    boolean;
}

export interface ModelProbeResult {
  model:      string;
  available:  boolean;
  latencyMs:  number;
}

// ---------------------------------------------------------------------------
// Internal DB row shape
// ---------------------------------------------------------------------------

interface MigrationRow {
  id:          number;
  from_model:  string;
  to_model:    string;
  reason:      string;
  migrated_at: string;
  success:     number;
}

// ---------------------------------------------------------------------------
// Known model probes
// ---------------------------------------------------------------------------

const MODEL_PROBES: Array<{ model: string; url: string; key: ProviderKeyName }> = [
  { model: 'xai/grok',         url: XAI_MODELS_URL,       key: 'xai' },
  { model: 'openai/gpt',       url: OPENAI_MODELS_URL,    key: 'openai' },
  { model: 'anthropic/claude', url: ANTHROPIC_MODELS_URL, key: 'anthropic' },
];

// ---------------------------------------------------------------------------
// SurvivalProbe
// ---------------------------------------------------------------------------

export class SurvivalProbe {
  constructor(private readonly db: Database.Database) {}

  /**
   * Probe each configured LLM provider and return latency results.
   * A model is available when an API key env var is set and the endpoint
   * responds within 10 seconds.
   */
  async testModelAvailability(): Promise<ModelProbeResult[]> {
    const results: ModelProbeResult[] = [];

    for (const probe of MODEL_PROBES) {
      const apiKey = getProviderApiKey(probe.key);
      if (!apiKey) {
        results.push({ model: probe.model, available: false, latencyMs: 0 });
        continue;
      }

      const start      = Date.now();
      const controller = new AbortController();
      const timer      = setTimeout(() => controller.abort(), 10_000);

      try {
        const resp = await llmFetch(probe.url, {
          headers: { Authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey },
          signal:  controller.signal,
        }, { caller: 'cron:survival-probe', purpose: 'provider liveness' });
        clearTimeout(timer);
        const latencyMs = Date.now() - start;
        results.push({ model: probe.model, available: resp.ok, latencyMs });
        log.info({ model: probe.model, available: resp.ok, latencyMs }, 'Model probe complete');
      } catch (err) {
        clearTimeout(timer);
        const latencyMs = Date.now() - start;
        log.warn({ model: probe.model, err: String(err) }, 'Model probe failed');
        results.push({ model: probe.model, available: false, latencyMs });
      }
    }

    return results;
  }

  /** Return all recorded model migration events, newest first. */
  getMigrationHistory(): ModelMigration[] {
    return this.db
      .prepare<[], MigrationRow>('SELECT * FROM model_migrations ORDER BY migrated_at DESC')
      .all()
      .map((row) => ({
        fromModel:  row.from_model,
        toModel:    row.to_model,
        reason:     row.reason,
        migratedAt: row.migrated_at,
        success:    row.success === 1,
      }));
  }

  /**
   * Record a model migration event.
   *
   * @param fromModel - Previous model identifier.
   * @param toModel   - New model identifier.
   * @param reason    - Human-readable reason for the migration.
   * @param success   - Whether the migration succeeded.
   */
  recordMigration(fromModel: string, toModel: string, reason: string, success = true): void {
    this.db.prepare(`
      INSERT INTO model_migrations (from_model, to_model, reason, success)
      VALUES (:from_model, :to_model, :reason, :success)
    `).run({
      from_model: fromModel,
      to_model:   toModel,
      reason,
      success:    success ? 1 : 0,
    });
    log.info({ fromModel, toModel, reason, success }, 'Model migration recorded');
  }
}
