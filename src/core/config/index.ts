/**
 * Public barrel export for src/core/config.
 */

export { ConfigLoader } from './loader.js';
export { SudoConfigSchema } from './schema.js';
export type { SudoConfigFromSchema } from './schema.js';
export type {
  SudoConfig,
  MetaConfig,
  AgentsConfig,
  ModelEntry,
  ModelsConfig,
  ProviderAuth,
  AuthConfig,
  TelegramConfig,
  WhatsAppConfig,
  DiscordConfig,
  ChannelsConfig,
  BrowserConfig,
  ToolsConfig,
  CronJobConfig,
  CronConfig,
  GatewayConfig,
} from './types.js';

// Permission modes (reverse-engineered from Claude Code)
export { PermissionModeManager } from './permission-modes.js';
export type {
  PermissionModeType,
  PermissionModeConfig,
  ActionCategory,
} from './permission-modes.js';

// Settings manager (project + local scopes)
export { SettingsManager } from './settings-manager.js';
export type {
  SettingsScope,
  SettingsEntry,
  SettingsFile,
  SettingsManagerConfig,
} from './settings-manager.js';
