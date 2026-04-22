/**
 * Public barrel export for src/core/shared.
 * Import from this module rather than individual files.
 */

export { logger, createLogger } from './logger.js';

export {
  SudoError,
  LLMError,
  ToolError,
  ChannelError,
  ConfigError,
  MemoryError,
  PipelineError,
  categorizeError,
} from './errors.js';

export type { ErrorCategory } from './errors.js';

export {
  APP_NAME,
  APP_VERSION,
  DEFAULT_MODEL,
  FALLBACK_MODEL,
  EMBEDDING_MODEL,
  EMBEDDING_DIMS,
  CHUNK_SIZE,
  CHUNK_OVERLAP,
  MAX_COMPACTION_CHARS,
  DEFAULT_MAX_RESULTS,
  DEFAULT_MIN_SCORE,
  DEFAULT_VECTOR_WEIGHT,
  DEFAULT_TEXT_WEIGHT,
  DEFAULT_HALF_LIFE_DAYS,
  DEFAULT_MMR_LAMBDA,
  HEARTBEAT_INTERVAL_MS,
  CONFIG_RELOAD_DEBOUNCE_MS,
  MAX_AGENT_ITERATIONS,
  OVERLOAD_BACKOFF,
  TRANSIENT_COOLDOWN,
  BILLING_COOLDOWN,
  PATHS,
  HEALTH_PORT,
  PID_PATH,
} from './constants.js';

export {
  genId,
  contentHash,
  retry,
  sleep,
  debounce,
  truncate,
  estimateTokens,
  todayISO,
  ageInDays,
  safeJsonParse,
} from './utils.js';
