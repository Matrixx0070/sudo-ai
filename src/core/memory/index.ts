/**
 * @file index.ts
 * @description Barrel export for the SUDO-AI memory subsystem.
 *
 * Consumers import from this file only — never from the individual modules directly.
 *
 * Usage:
 * ```ts
 * import { MindDB, EmbeddingService, hybridSearch } from '../core/memory/index.js';
 * ```
 */

// Types
export type {
  MemoryChunk,
  SearchResult,
  SearchOptions,
  EmbeddingCache,
} from './types.js';

// DB — MindDB class + row types used by other core modules (brain, sessions, etc.)
export { MindDB } from './db.js';
export type {
  SessionRow,
  MessageRow,
  TaskRow,
  PipelineRunRow,
  ApiCostRow,
  CronRunRow,
  VideoMetricsRow,
  ContentIdeaRow,
  StoreChunkOptions,
} from './db.js';

// Embeddings
export { EmbeddingService } from './embeddings.js';

// Hybrid search + individual scoring helpers (useful for callers that want raw scores)
export {
  hybridSearch,
  bm25RankToScore,
  applyTemporalDecay,
  mergeHybridResults,
  mmrRerank,
} from './hybrid-search.js';

// Compaction flush
export { flushBeforeCompaction } from './compaction-flush.js';

// Semantic contradiction resolution for the free-text chunks store (#7)
export {
  resolveChunkContradictions,
  isChunkContradictionEnabled,
  resolveSimThreshold,
  cosineSimilarity,
} from './chunk-contradiction.js';
export type {
  ChunkContradictionDeps,
  ContradictionJudge,
  ContradictionOptions,
  ContradictionResult,
} from './chunk-contradiction.js';

// Corpus-side ANN backfill — embeds stored chunks into chunks_vec so the
// hybrid-search vector path actually returns results (was BM25-only).
export {
  backfillChunkVectors,
  isVectorBackfillEnabled,
  MindDBVectorStore,
} from './vector-backfill.js';
export type {
  ChunkVectorStore,
  BackfillEmbedder,
  BackfillOptions,
  BackfillResult,
} from './vector-backfill.js';

// Schema utilities (needed by devops / migration tooling)
export { initializeSchema, initializeVecTable, SCHEMA_SQL } from './schema.js';

// Unified cross-store memory search
export { UnifiedMemory } from './unified.js';
export type { MemoryResult, MemoryQuery, MemorySummary } from './unified.js';

// InsightForge — query decomposition + parallel search + RRF merging
export { forgeInsights, reciprocalRankFusion } from './insight-forge.js';
export type { ForgeResult, ForgeOptions, SubQuestion } from './insight-forge.js';

// Session auto-summarizer
export { AutoSummarizer } from './auto-summarizer.js';
export type { SessionSummary } from './auto-summarizer.js';

// Injection scanner (memory security)
export {
  MEMORY_THREAT_PATTERNS,
  scanMemoryContent,
  assertMemorySafe,
  guardMemoryWrite,
  setHookManager,
  MemoryInjectionError,
} from './injection-scanner.js';
export type { ScanResult } from './injection-scanner.js';
