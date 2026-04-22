/**
 * TypeBox schema for sudo-ai.json5.
 * Must mirror types.ts exactly; used at runtime for config validation.
 *
 * Validation is intentionally lenient on optional fields (all optional keys
 * have defaults) so operators need not specify every field in their config.
 */

import { Type, type Static } from '@sinclair/typebox';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const Str = (opts: object = {}) => Type.String({ minLength: 1, ...opts });
const NonNegInt = (opts: object = {}) => Type.Integer({ minimum: 0, ...opts });
const PosInt = (opts: object = {}) => Type.Integer({ minimum: 1, ...opts });
const Probability = () => Type.Number({ minimum: 0, maximum: 1 });

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

const MetaSchema = Type.Object({
  name: Str({ description: 'Human-readable agent instance name' }),
  timezone: Str({ description: 'IANA timezone, e.g. UTC' }),
});

const AgentsSchema = Type.Object({
  maxIterations: PosInt({ description: 'Hard cap on tool-call iterations per run' }),
  systemPrompt: Type.String({ description: 'Default system prompt for every session' }),
});

const ModelEntrySchema = Type.Object({
  id: Str({ description: 'Provider-qualified model ID, e.g. xai/grok-3-fast' }),
  contextWindow: PosInt({ description: 'Context window size in tokens' }),
  maxOutputTokens: PosInt({ description: 'Maximum tokens to generate per call' }),
  temperature: Type.Number({
    minimum: 0,
    maximum: 2,
    description: 'Sampling temperature',
  }),
});

const ModelsSchema = Type.Object({
  primary: Type.Array(ModelEntrySchema, { minItems: 1 }),
  fallback: ModelEntrySchema,
  embedding: Type.Object({
    id: Str(),
    dims: PosInt(),
  }),
});

const ProviderAuthSchema = Type.Object({
  envKey: Str({ description: 'Name of the env-var holding the API key' }),
});

const AuthSchema = Type.Object({
  xai: ProviderAuthSchema,
  openai: ProviderAuthSchema,
  anthropic: ProviderAuthSchema,
  google: ProviderAuthSchema,
});

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

const TelegramSchema = Type.Object({
  enabled: Type.Boolean(),
  tokenEnvKey: Str(),
  allowedUsers: Type.Array(Type.String()),
});

const WhatsAppSchema = Type.Object({
  enabled: Type.Boolean(),
  sessionPath: Str(),
  allowedJids: Type.Array(Type.String()),
});

const DiscordSchema = Type.Object({
  enabled: Type.Boolean(),
  tokenEnvKey: Str(),
  allowedChannelIds: Type.Array(Type.String()),
});

const ChannelsSchema = Type.Object({
  telegram: TelegramSchema,
  whatsapp: WhatsAppSchema,
  discord: DiscordSchema,
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const BrowserSchema = Type.Object({
  headless: Type.Boolean(),
  timeoutMs: PosInt({ description: 'Navigation timeout in milliseconds' }),
});

const ToolsSchema = Type.Object({
  disabled: Type.Array(Type.String(), { description: 'Tool names to disable globally' }),
  browser: BrowserSchema,
});

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

const CronJobSchema = Type.Object({
  id: Str(),
  schedule: Str({ description: 'Standard cron expression, e.g. 0 9 * * *' }),
  description: Type.String(),
  enabled: Type.Boolean(),
  task: Type.String({ description: 'Prompt / task payload for this job' }),
});

const CronSchema = Type.Object({
  jobs: Type.Array(CronJobSchema),
});

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

const GatewaySchema = Type.Object({
  enabled: Type.Boolean(),
  port: NonNegInt({ minimum: 1, maximum: 65_535 }),
  allowedHosts: Type.Array(Type.String()),
  secretEnvKey: Str(),
});

// ---------------------------------------------------------------------------
// Root schema
// ---------------------------------------------------------------------------

export const SudoConfigSchema = Type.Object(
  {
    meta: MetaSchema,
    agents: AgentsSchema,
    models: ModelsSchema,
    auth: AuthSchema,
    channels: ChannelsSchema,
    tools: ToolsSchema,
    cron: CronSchema,
    gateway: GatewaySchema,
  },
  { additionalProperties: false },
);

/** Inferred static type from the schema (should match SudoConfig in types.ts). */
export type SudoConfigFromSchema = Static<typeof SudoConfigSchema>;
