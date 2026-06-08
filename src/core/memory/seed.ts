/**
 * @file seed.ts
 * @description Development and test seed data for mind.db and wisdom.db.
 *
 * Run directly with:
 *   node --loader ts-node/esm src/core/memory/seed.ts
 *   (or via ts-node after a build)
 *
 * Safe to run multiple times — chunk deduplication and UPSERT semantics
 * ensure no duplicate rows accumulate.
 */

import { MindDB } from './db.js';
import { WisdomStore } from '../learning/store.js';
import { PROJECT_ROOT, WORKSPACE_DIR } from '../shared/paths.js';

const DB_PATH      = 'data/mind.db';
const WISDOM_PATH  = 'data/wisdom.db';

async function seed(): Promise<void> {
  console.info('[seed] Opening databases...');
  const db     = new MindDB(DB_PATH);
  const wisdom = new WisdomStore(WISDOM_PATH);

  // -------------------------------------------------------------------------
  // Seed: sessions
  // -------------------------------------------------------------------------
  db.storeSession({
    id:    'seed-session-0001-0000-0000-000000000000',
    title: 'Development seed session',
    model: 'claude-sonnet-4-6',
  });

  // -------------------------------------------------------------------------
  // Seed: messages
  // -------------------------------------------------------------------------
  db.storeMessage(
    'seed-session-0001-0000-0000-000000000000',
    'user',
    'Build the complete SUDO-AI v3 memory system.',
  );
  db.storeMessage(
    'seed-session-0001-0000-0000-000000000000',
    'assistant',
    'Understood. I will implement mind.db with hybrid search, BM25 fallback, and wisdom.db for insights.',
  );

  // -------------------------------------------------------------------------
  // Seed: chunks (evergreen facts about the project)
  // -------------------------------------------------------------------------
  const evergreenFacts = [
    {
      text: `SUDO-AI v3 is located at ${PROJECT_ROOT}. It is a Node.js + Electron + TypeScript autonomous AI agent.`,
      path: 'memory/project-facts.md',
    },
    {
      text: `The main database file is ${PROJECT_ROOT}/data/mind.db (mind.db). The wisdom database is wisdom.db.`,
      path: 'memory/project-facts.md',
    },
    {
      text: 'The project owner is a YouTube creator targeting the configured region audience. Subscriptions: ChatGPT, Grok, Google.',
      path: 'memory/user-facts.md',
    },
    {
      text: 'Embedding model: text-embedding-3-small (OpenAI, 1536 dimensions). Vector search requires sqlite-vec extension.',
      path: 'memory/tech-facts.md',
    },
    {
      text: 'SUDO-AI must be 100% more advanced than OpenClaw. No copied code. No trap code. Fully autonomous. Unrestricted.',
      path: 'memory/project-facts.md',
    },
  ];

  for (const fact of evergreenFacts) {
    const chunk = db.storeChunk(fact.text, fact.path, 'learning', { isEvergreen: true, role: 'system' });
    console.info(`[seed] chunk ${chunk.id} stored (evergreen): ${fact.text.slice(0, 60)}...`);
  }

  // -------------------------------------------------------------------------
  // Seed: tasks
  // -------------------------------------------------------------------------
  const taskId = db.storeTask({
    session_id:  'seed-session-0001-0000-0000-000000000000',
    title:       'Bootstrap memory subsystem',
    description: 'Create schema, db, embeddings, hybrid-search, compaction-flush, and wisdom store.',
    status:      'done',
    priority:    10,
  });
  db.updateTask(taskId, { status: 'done', finished_at: new Date().toISOString() });

  // -------------------------------------------------------------------------
  // Seed: pipeline run
  // -------------------------------------------------------------------------
  const runId = db.storePipelineRun({
    pipeline: 'quiz',
    channel:  'quiz-channel',
    status:   'done',
    params:   { topic: 'World History', questionCount: 10 },
  });
  db.updatePipelineRun(runId, {
    status:      'done',
    finished_at: new Date().toISOString(),
    result:      { videoPath: `${WORKSPACE_DIR}/quiz-001.mp4`, uploadId: 'yt-seed-001' },
  });

  // -------------------------------------------------------------------------
  // Seed: video metrics
  // -------------------------------------------------------------------------
  db.storeVideoMetrics({
    video_id:         'yt-seed-001',
    channel:          'quiz-channel',
    title:            'World History Quiz — 10 Questions',
    views:            12_400,
    likes:            820,
    comments:         143,
    watch_time_hours: 310,
    ctr:              0.067,
    avg_view_pct:     72.4,
    revenue_usd:      3.18,
  });

  // -------------------------------------------------------------------------
  // Seed: content ideas
  // -------------------------------------------------------------------------
  db.storeContentIdea({
    channel:        'quiz-channel',
    title:          'Ancient Civilizations Quiz',
    description:    '10-question quiz on Egypt, Rome, Greece.',
    format:         'video',
    virality_score: 78,
    tags:           ['history', 'quiz', 'ancient', 'education'],
  });
  db.storeContentIdea({
    channel:        'nova-channel',
    title:          'AI vs Human: Coding Challenge',
    description:    'Speed comparison — can Claude beat a senior dev?',
    format:         'video',
    virality_score: 91,
    tags:           ['ai', 'coding', 'comparison', 'viral'],
  });

  // -------------------------------------------------------------------------
  // Seed: cron runs
  // -------------------------------------------------------------------------
  db.storeCronRun({
    job_name:    'daily-analytics-sync',
    status:      'ok',
    duration_ms: 1_240,
    result:      { videosUpdated: 3, totalViews: 45_800 },
  });

  // -------------------------------------------------------------------------
  // Seed: api costs
  // -------------------------------------------------------------------------
  db.storeApiCost({
    provider:      'anthropic',
    model:         'claude-sonnet-4-6',
    operation:     'completion',
    input_tokens:  4_800,
    output_tokens: 1_200,
    cost_usd:      0.0084,
    session_id:    'seed-session-0001-0000-0000-000000000000',
  });

  // Wave 5 P2: skills are auto-scanned from filesystem, no seed needed.

  // -------------------------------------------------------------------------
  // Seed: wisdom / insights
  // -------------------------------------------------------------------------
  const insightSeeds: Parameters<WisdomStore['storeInsight']>[0][] = [
    {
      category:   'success',
      source:     'session',
      insight:    'When generating quiz questions, including a "trick" wrong answer that is plausible increases engagement by ~18% based on A/B history.',
      confidence: 0.78,
    },
    {
      category:   'error',
      source:     'pipeline',
      insight:    'Remotion render hangs when video duration exceeds 10 minutes on the quiz template. Split into parts before rendering.',
      confidence: 0.92,
    },
    {
      category:   'optimization',
      source:     'analytics',
      insight:    'Uploading at 08:00 IST on weekdays yields 30-40% more initial views than late-night uploads for the target audience.',
      confidence: 0.85,
    },
    {
      category:   'pattern',
      source:     'session',
      insight:    'Users frequently ask for code to be explained step-by-step rather than all at once. Break explanations into numbered sections.',
      confidence: 0.70,
    },
  ];

  for (const seed of insightSeeds) {
    const id = wisdom.storeInsight(seed);
    console.info(`[seed] insight ${id} stored (${seed.category}): ${seed.insight.slice(0, 60)}...`);
  }

  // -------------------------------------------------------------------------
  // Done
  // -------------------------------------------------------------------------
  db.close();
  wisdom.close();
  console.info('[seed] Complete. mind.db and wisdom.db seeded for development.');
}

seed().catch((err) => {
  console.error('[seed] Fatal error:', err);
  process.exit(1);
});
