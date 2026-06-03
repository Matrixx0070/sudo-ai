/**
 * Application-wide constants for SUDO-AI v3.
 * All values are `as const` — no mutation at runtime.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const APP_NAME = 'SUDO-AI' as const;
export const APP_VERSION = '3.1.0' as const;

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

// Override via env SUDO_DEFAULT_MODEL / SUDO_FALLBACK_MODEL.
// Single LLM brain: Ollama Cloud deepseek-v4-pro:cloud, qwen3.5:latest fallback.
export const DEFAULT_MODEL = (process.env['SUDO_DEFAULT_MODEL'] ?? 'ollama/deepseek-v4-pro:cloud') as string;
export const FALLBACK_MODEL = (process.env['SUDO_FALLBACK_MODEL'] ?? 'ollama/qwen3.5:latest') as string;
export const EMBEDDING_MODEL = 'openai/text-embedding-3-small' as const;
export const EMBEDDING_DIMS = 1536 as const;

/** Single LLM routing — all tasks use deepseek-v4-pro:cloud. */
export const SUDOAPI_MODELS = {
  coding: 'ollama/deepseek-v4-pro:cloud',
  analysis: 'ollama/deepseek-v4-pro:cloud',
  fast: 'ollama/deepseek-v4-pro:cloud',
  research: 'ollama/deepseek-v4-pro:cloud',
} as const;

// ---------------------------------------------------------------------------
// Memory / chunking
// ---------------------------------------------------------------------------

/** Target chunk size in tokens. */
export const CHUNK_SIZE = 400 as const;
/** Overlap between consecutive chunks in tokens. */
export const CHUNK_OVERLAP = 80 as const;
/** Maximum characters before a memory context is compacted. */
export const MAX_COMPACTION_CHARS = 16_000 as const;

// ---------------------------------------------------------------------------
// Retrieval defaults
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_RESULTS = 6 as const;
export const DEFAULT_MIN_SCORE = 0.35 as const;
export const DEFAULT_VECTOR_WEIGHT = 0.7 as const;
export const DEFAULT_TEXT_WEIGHT = 0.3 as const;
export const DEFAULT_HALF_LIFE_DAYS = 30 as const;
export const DEFAULT_MMR_LAMBDA = 0.7 as const;

// ---------------------------------------------------------------------------
// Timings
// ---------------------------------------------------------------------------

/** Interval between keep-alive heartbeat pings (ms). */
export const HEARTBEAT_INTERVAL_MS = 1_800_000 as const; // 30 minutes in ms

/** Debounce window for config file reload events (ms). */
export const CONFIG_RELOAD_DEBOUNCE_MS = 300 as const;

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

/** Hard cap on tool-call iterations per agent run. 25 allows fast autonomous tasks with early stop. */
export const MAX_AGENT_ITERATIONS = 25 as const;

// ---------------------------------------------------------------------------
// Backoff / cooldown schedules
// ---------------------------------------------------------------------------

/** Short backoff for transient overload retries (ms). */
export const OVERLOAD_BACKOFF: readonly number[] = [250, 500, 1_000, 1_500] as const;

/**
 * Cooldown durations for transient errors (rate-limit, timeout, overloaded).
 * Indexed by consecutive failure count (capped at length - 1).
 * Values: 1 min, 5 min, 25 min, 1 hour.
 */
export const TRANSIENT_COOLDOWN: readonly number[] = [
  5_000,    // 5s  — gateway handles retries, brain just needs a short pause
  10_000,   // 10s
  30_000,   // 30s
  60_000,   // 60s max — never wait more than 1 minute
] as const;

/**
 * Cooldown durations for billing errors.
 * Values: 5 h, 10 h, 20 h, 24 h.
 */
export const BILLING_COOLDOWN: readonly number[] = [
  30_000,    // 30s  — gateway + SUDOAPI handle provider switching
  60_000,    // 1min
  300_000,   // 5min
  600_000,   // 10min max
] as const;

// ---------------------------------------------------------------------------
// File-system paths (relative to project root)
// ---------------------------------------------------------------------------

export const PATHS = {
  DATA: 'data',
  MIND_DB: 'data/mind.db',
  WISDOM_DB: 'data/wisdom.db',
  SESSIONS: 'data/sessions',
  CRON: 'data/cron',
  CACHE: 'data/cache',
  MEDIA: 'data/media',
  LOGS: 'data/logs',
  CONFIG: 'config/sudo-ai.json5',
  ENV: 'config/.env',
  WORKSPACE: 'workspace',
  SKILLS: 'skills',
} as const;

// ---------------------------------------------------------------------------
// CLI / health server
// ---------------------------------------------------------------------------

/** TCP port the OpenAI-compatible API server (and health endpoint) listens on. */
export const HEALTH_PORT = 3001 as const;

/** Path to the PID file written by `sudo-ai start`. */
export const PID_PATH = `${PATHS.DATA}/sudo-ai.pid` as const;

// ---------------------------------------------------------------------------
// Upgrade 35: Truncation Policy Constants
// ---------------------------------------------------------------------------

/** Maximum context window tokens (from Codex config). */
export const CONTEXT_WINDOW = 272_000 as const;

/** Default truncation policy token limit. */
export const TRUNCATION_TOKEN_LIMIT = 10_000 as const;

/** Shell execution type identifier. */
export const SHELL_TYPE = 'shell_command' as const;

/** Minimum client version for compatibility checks. */
export const MIN_CLIENT_VERSION = '5.0.0' as const;

// ---------------------------------------------------------------------------
// Pre-compaction memory flush
// ---------------------------------------------------------------------------

/**
 * When true, a MEMORY FLUSH system message is injected into the session
 * before context compaction runs.  Set to false to disable the reminder
 * without changing any other compaction behaviour.
 */
export const PRE_COMPACTION_FLUSH = true as const;

/**
 * Fraction of MAX_CONTEXT_TOKENS at which the pre-compaction flush reminder
 * is injected.  Must be lower than the shouldCompact threshold (0.5) so the
 * agent gets at least one full turn to save context before the history is
 * replaced by a summary.
 */
export const PRE_COMPACTION_FLUSH_THRESHOLD = 0.4 as const;

// ---------------------------------------------------------------------------
// v5 Upgrade: Swarm / effort constants
// ---------------------------------------------------------------------------

/** Hard cap on total tool-call steps for a single agent run in v5. */
export const MAX_AGENT_STEPS = 300 as const;

/** Hard cap on concurrent agents in a swarm. */
export const MAX_SWARM_AGENTS = 100 as const;

/**
 * Effort-level presets that control reasoning depth, step limits, temperature,
 * and interleaved-thinking behaviour.  All values are immutable at runtime.
 */
export const EFFORT_LEVELS = {
  min: { maxSteps: 10, temperature: 0.3, reasoningLevel: 'low', thinkingBudgetTokens: 0, interleavedThinking: false },
  low: { maxSteps: 50, temperature: 0.5, reasoningLevel: 'low', thinkingBudgetTokens: 1024, interleavedThinking: false },
  normal: { maxSteps: 150, temperature: 0.7, reasoningLevel: 'medium', thinkingBudgetTokens: 4096, interleavedThinking: false },
  high: { maxSteps: 300, temperature: 0.8, reasoningLevel: 'high', thinkingBudgetTokens: 16384, interleavedThinking: true },
  max: { maxSteps: 500, temperature: 1.0, reasoningLevel: 'xhigh', thinkingBudgetTokens: 32768, interleavedThinking: true },
} as const;
