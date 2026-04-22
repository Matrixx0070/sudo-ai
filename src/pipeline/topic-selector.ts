/**
 * @file topic-selector.ts
 * Picks topics from topic-bank.json using weighted random selection,
 * category rotation, and a 30-day deduplication window.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { createLogger } from '../core/shared/logger.js';
import { PipelineError } from '../core/shared/errors.js';
import { ageInDays, genId } from '../core/shared/utils.js';
import type {
  TopicBank,
  TopicEntry,
  SelectedTopic,
  PipelineState,
  TopicUsageRecord,
} from './types.js';

const log = createLogger('pipeline:topic-selector');

const DEFAULT_DEDUP_WINDOW_DAYS = 30;
const FALLBACK_DEDUP_WINDOW_DAYS = 15;

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

/**
 * Load and parse the local topic-bank.json file.
 * @returns Parsed TopicBank object.
 * @throws PipelineError if the file is missing or malformed.
 */
export function loadTopicBank(): TopicBank {
  let raw: string;
  try {
    const filePath = fileURLToPath(new URL('./topic-bank.json', import.meta.url));
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new PipelineError(
      `Cannot read topic-bank.json: ${String(err)}`,
      'pipeline_topic_bank_read_error',
    );
  }
  try {
    const parsed = JSON.parse(raw) as TopicBank;
    if (!parsed?.categories) {
      throw new Error('missing categories field');
    }
    log.debug({ totalTopics: parsed.totalTopics }, 'Topic bank loaded');
    return parsed;
  } catch (err) {
    throw new PipelineError(
      `topic-bank.json parse error: ${String(err)}`,
      'pipeline_topic_bank_parse_error',
    );
  }
}

/**
 * Determine whether a topic was used within the given window.
 * @param topicId    - Topic identifier to check.
 * @param usage      - Historical usage records from pipeline state.
 * @param windowDays - Look-back window in days (default 30).
 */
export function isTopicRecentlyUsed(
  topicId: string,
  usage: TopicUsageRecord[],
  windowDays: number = DEFAULT_DEDUP_WINDOW_DAYS,
): boolean {
  if (!topicId) return false;
  return usage.some((r) => r.topicId === topicId && ageInDays(r.usedAt) < windowDays);
}

/**
 * Return all topics not used within the dedup window, annotated with category.
 * @param state      - Pipeline state carrying usage history.
 * @param windowDays - Dedup window (default 30).
 */
export function getAvailableTopics(
  state: PipelineState,
  windowDays: number = DEFAULT_DEDUP_WINDOW_DAYS,
): Array<TopicEntry & { category: string }> {
  const bank = loadTopicBank();
  const available: Array<TopicEntry & { category: string }> = [];
  for (const [cat, data] of Object.entries(bank.categories)) {
    for (const topic of data.topics) {
      if (!isTopicRecentlyUsed(topic.id, state.topicUsage, windowDays)) {
        available.push({ ...topic, category: cat });
      }
    }
  }
  log.debug({ count: available.length, windowDays }, 'Available topics after dedup');
  return available;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function weightedRandom(
  topics: Array<TopicEntry & { category: string }>,
): TopicEntry & { category: string } {
  const weights = topics.map((t) => t.viral_score ** 2);
  const total = weights.reduce((s, w) => s + w, 0);
  let cursor = Math.random() * total;
  for (let i = 0; i < topics.length; i++) {
    cursor -= weights[i] as number;
    if (cursor <= 0) return topics[i] as TopicEntry & { category: string };
  }
  return topics[topics.length - 1] as TopicEntry & { category: string };
}

function categoryLastUsedMs(
  cat: string,
  bank: TopicBank,
  usage: TopicUsageRecord[],
): number {
  const ids = new Set((bank.categories[cat]?.topics ?? []).map((t) => t.id));
  let latest = 0;
  for (const r of usage) {
    if (ids.has(r.topicId)) {
      const ts = new Date(r.usedAt).getTime();
      if (ts > latest) latest = ts;
    }
  }
  return latest;
}

function selectWithWindow(
  count: number,
  state: PipelineState,
  windowDays: number,
  batchId: string,
): SelectedTopic[] {
  const bank = loadTopicBank();
  const available = getAvailableTopics(state, windowDays);
  if (available.length === 0) return [];

  const byCategory = new Map<string, Array<TopicEntry & { category: string }>>();
  for (const t of available) {
    const bucket = byCategory.get(t.category) ?? [];
    bucket.push(t);
    byCategory.set(t.category, bucket);
  }

  const sortedCats = [...byCategory.keys()].sort(
    (a, b) =>
      categoryLastUsedMs(a, bank, state.topicUsage) -
      categoryLastUsedMs(b, bank, state.topicUsage),
  );

  const selected: SelectedTopic[] = [];
  const usedIds = new Set<string>();
  const effectiveCount = Math.min(count, available.length);
  const now = new Date().toISOString();
  let catIdx = 0;

  while (selected.length < effectiveCount) {
    const activeCats = sortedCats.filter((c) => (byCategory.get(c)?.length ?? 0) > 0);
    if (activeCats.length === 0) break;

    const catName = activeCats[catIdx % activeCats.length] as string;
    const bucket = byCategory.get(catName)!;
    const remaining = bucket.filter((t) => !usedIds.has(t.id));

    if (remaining.length === 0) {
      byCategory.set(catName, []);
      catIdx++;
      continue;
    }

    const chosen = weightedRandom(remaining);
    usedIds.add(chosen.id);
    byCategory.set(catName, bucket.filter((t) => t.id !== chosen.id));

    selected.push({
      entry: {
        id: chosen.id,
        title: chosen.title,
        hook: chosen.hook,
        emotion: chosen.emotion,
        viral_score: chosen.viral_score,
      },
      category: chosen.category,
      selectedAt: now,
      batchId,
    });
    catIdx++;
  }

  return selected;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Select `count` unique topics for a batch with category rotation and dedup.
 * Shrinks the dedup window to 15 days if the default 30-day window yields zero
 * candidates. Throws if the bank is exhausted even after the window shrink.
 *
 * @param count - Number of topics to select.
 * @param state - Current pipeline state (usage history).
 * @returns Array of SelectedTopic (may be fewer than count if bank is low).
 */
export function selectTopics(count: number, state: PipelineState): SelectedTopic[] {
  if (!Number.isInteger(count) || count <= 0) {
    throw new PipelineError(
      `selectTopics: count must be a positive integer, got ${count}`,
      'pipeline_topic_invalid_count',
    );
  }

  const batchId = genId();
  log.info({ count, batchId }, 'Selecting topics for batch');

  let results = selectWithWindow(count, state, DEFAULT_DEDUP_WINDOW_DAYS, batchId);

  if (results.length === 0) {
    log.warn('Zero topics with 30-day window — retrying with 15-day window');
    results = selectWithWindow(count, state, FALLBACK_DEDUP_WINDOW_DAYS, batchId);
  }

  if (results.length === 0) {
    throw new PipelineError(
      'No topics available even after shrinking dedup window to 15 days',
      'pipeline_topic_bank_exhausted',
    );
  }

  if (results.length < count) {
    log.warn({ requested: count, available: results.length }, 'Reduced topic count');
  }

  log.info(
    { batchId, selected: results.length, categories: [...new Set(results.map((r) => r.category))] },
    'Topic selection complete',
  );
  return results;
}
