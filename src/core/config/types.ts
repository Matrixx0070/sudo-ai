/**
 * TypeScript interfaces for the SUDO-AI v3 configuration file (sudo-ai.json5).
 * These types are the single source of truth; the TypeBox schema in schema.ts
 * must mirror them exactly.
 */

// ---------------------------------------------------------------------------
// Sub-interfaces
// ---------------------------------------------------------------------------

export interface MetaConfig {
  /** Human-readable name of this agent instance. */
  name: string;
  /** Timezone string, e.g. "UTC". Used by cron and logging. */
  timezone: string;
}

export interface AgentsConfig {
  /** Hard cap on tool-call iterations per agent run. */
  maxIterations: number;
  /** Default system prompt injected at the start of every agent session. */
  systemPrompt: string;
}

export interface ModelEntry {
  /** Provider-qualified model ID, e.g. "xai/grok-3-fast". */
  id: string;
  /** Maximum context window in tokens. */
  contextWindow: number;
  /** Maximum tokens to generate per call. */
  maxOutputTokens: number;
  /** Sampling temperature (0–2). */
  temperature: number;
}

export interface ModelsConfig {
  /** Ordered list of primary models tried in sequence. */
  primary: ModelEntry[];
  /** Fallback model used when all primary models are unavailable. */
  fallback: ModelEntry;
  /**
   * Optional explicit, ordered fallback chain of "provider/model" refs, tried
   * after the primary models (mirrors a primary + fallbacks[] chain). Lets
   * operators declare the failover order instead of relying on primary-array
   * ordering plus the single `fallback`.
   */
  fallbacks?: string[];
  /**
   * Optional cheap-tier model ref ("provider/model") for the smart-route
   * fast-path. Resolution order is SUDO_CHEAP_MODEL env → this → cost-optimizer.
   */
  cheap?: string;
  /** Embedding model configuration. */
  embedding: {
    id: string;
    dims: number;
  };
}

export interface ProviderAuth {
  /** Environment-variable name that holds the API key. */
  envKey: string;
}

export interface AuthConfig {
  xai: ProviderAuth;
  openai: ProviderAuth;
  anthropic: ProviderAuth;
  google: ProviderAuth;
}

// ---------------------------------------------------------------------------
// Channel configs
// ---------------------------------------------------------------------------

export interface TelegramConfig {
  enabled: boolean;
  /** Environment-variable name containing the bot token. */
  tokenEnvKey: string;
  /** Comma-separated list of allowed Telegram user IDs (as strings). */
  allowedUsers: string[];
}

export interface WhatsAppConfig {
  enabled: boolean;
  /** Path to store WhatsApp session credentials. */
  sessionPath: string;
  /** Allowed sender JIDs, e.g. "918882991782@s.whatsapp.net". */
  allowedJids: string[];
}

export interface DiscordConfig {
  enabled: boolean;
  /** Environment-variable name containing the bot token. */
  tokenEnvKey: string;
  /** Discord channel IDs the bot is permitted to respond in. */
  allowedChannelIds: string[];
}

export interface ChannelsConfig {
  telegram: TelegramConfig;
  whatsapp: WhatsAppConfig;
  discord: DiscordConfig;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface BrowserConfig {
  /** Whether to run Playwright/Puppeteer in headless mode. */
  headless: boolean;
  /** Navigation timeout in milliseconds. */
  timeoutMs: number;
}

export interface ToolsConfig {
  /** List of tool names that are globally disabled. */
  disabled: string[];
  browser: BrowserConfig;
}

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

export interface CronJobConfig {
  /** Unique identifier for the job. */
  id: string;
  /** Cron expression, e.g. "0 9 * * *". */
  schedule: string;
  /** Human-readable description of the job. */
  description: string;
  /** Whether the job is active. */
  enabled: boolean;
  /** Prompt or task payload executed by the job. */
  task: string;
}

export interface CronConfig {
  jobs: CronJobConfig[];
}

// ---------------------------------------------------------------------------
// Gateway (HTTP API)
// ---------------------------------------------------------------------------

export interface GatewayConfig {
  /** Whether to start the local HTTP gateway. */
  enabled: boolean;
  /** Port to listen on. */
  port: number;
  /** Hosts allowed to connect (CORS / validation). */
  allowedHosts: string[];
  /** Environment-variable name that holds the gateway API secret. */
  secretEnvKey: string;
}

// ---------------------------------------------------------------------------
// Update (Auto-Update System)
// ---------------------------------------------------------------------------

export interface UpdateConfig {
  /** Enable or disable the auto-update system entirely. Kill-switch: SUDO_UPDATE_DISABLE=1 overrides. */
  enabled: boolean;
  /** Which channel to track: 'latest' or 'stable'. */
  channel: 'latest' | 'stable';
  /** Check interval in milliseconds. Minimum 60 000. */
  checkIntervalMs: number;
  /** Number of previous versions to retain for rollback. */
  rollbackVersions: number;
  /** Whether to apply updates automatically or just notify. */
  autoApply: boolean;
  /** Whether to verify SHA-256 checksums before applying. */
  verifyChecksums: boolean;
  /** Maximum version to install (kill switch). Undefined = no limit. */
  maxVersion?: string;
  /** Specific versions to skip (known-bad releases). */
  skipVersions: string[];
  /** Health gate: block updates when Watchdog reports critical. */
  healthGate: boolean;
  /** Lock file timeout in milliseconds. */
  lockTimeoutMs: number;
  /** npm package name for version resolution. */
  packageName: string;
  /** Git remote URL for git-based fallback resolution. */
  gitRemoteUrl: string;
  /** Git branch for version resolution. */
  gitBranch: string;
}

// ---------------------------------------------------------------------------
// Root config
// ---------------------------------------------------------------------------

/** Complete SUDO-AI v4 configuration schema. */
export interface SudoConfig {
  meta: MetaConfig;
  agents: AgentsConfig;
  models: ModelsConfig;
  auth: AuthConfig;
  channels: ChannelsConfig;
  tools: ToolsConfig;
  cron: CronConfig;
  gateway: GatewayConfig;
  /** Auto-update configuration (optional — merged with DEFAULT_UPDATE_CONFIG). */
  update?: Partial<UpdateConfig>;
}
