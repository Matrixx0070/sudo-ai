/** @file provider.ts — Multi-provider streaming abstraction for SUDO-AI chat TUI. */

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// .env loader
// ---------------------------------------------------------------------------

function loadDotEnv(envPath: string): void {
  try {
    if (!fs.existsSync(envPath)) return;
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && !(key in process.env)) {
        process.env[key] = val;
      }
    }
  } catch { /* non-fatal */ }
}

// Load .env from project root config/
const projectRoot = path.resolve(process.cwd());
loadDotEnv(path.join(projectRoot, 'config', '.env'));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProviderKind = 'anthropic' | 'sudoapi' | 'openai' | 'xai';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface StreamChunk {
  type: 'text';
  value: string;
}

export interface DoneChunk {
  type: 'done';
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface ToolStartChunk {
  type: 'tool_start';
  toolId: string;
  toolName: string;
  args: string;
  gerund: string;
}

export interface ToolEndChunk {
  type: 'tool_end';
  toolId: string;
  resultPreview: string;
  resultFull: string;
  isDiff: boolean;
  elapsedMs: number;
}

export interface ToolErrorChunk {
  type: 'tool_error';
  toolId: string;
  error: string;
  elapsedMs: number;
}

export interface ToolPermissionChunk {
  type: 'tool_permission_request';
  toolId: string;
  toolName: string;
  args: string;
}

export type ProviderChunk = StreamChunk | DoneChunk
  | ToolStartChunk | ToolEndChunk | ToolErrorChunk | ToolPermissionChunk;

export interface ProviderInfo {
  provider: ProviderKind;
  model: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

interface AnthropicClient {
  kind: 'anthropic';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sdk: any;
  info: ProviderInfo;
}

interface OpenAICompatClient {
  kind: 'openai-compat';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sdk: any;
  info: ProviderInfo;
}

type ProviderClient = AnthropicClient | OpenAICompatClient;

let _clientPromise: Promise<ProviderClient> | null = null;

async function buildClient(): Promise<ProviderClient> {
  const anthropicKey = process.env['ANTHROPIC_API_KEY'];
  const sudoapiUrl   = process.env['SUDOAPI_URL'];
  const sudoapiKey   = process.env['SUDOAPI_KEY'];
  const openaiKey    = process.env['OPENAI_API_KEY'];
  const xaiKey       = process.env['XAI_API_KEY'];
  const xaiModel     = process.env['XAI_MODEL'];
  const xaiBaseUrl   = process.env['XAI_BASE_URL'] ?? 'https://api.x.ai/v1';

  if (anthropicKey) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const sdk = new Anthropic({ apiKey: anthropicKey, timeout: 30_000 });
    return {
      kind: 'anthropic',
      sdk,
      info: { provider: 'anthropic', model: 'claude-sonnet-4-6', label: 'Anthropic' },
    };
  }

  if (sudoapiUrl && sudoapiKey) {
    const { default: OpenAI } = await import('openai');
    const sdk = new OpenAI({ baseURL: `${sudoapiUrl}/v1`, apiKey: sudoapiKey, timeout: 30_000 });
    return {
      kind: 'openai-compat',
      sdk,
      info: { provider: 'sudoapi', model: 'claude-sonnet-4-6', label: 'SUDOAPI' },
    };
  }

  if (openaiKey) {
    const { default: OpenAI } = await import('openai');
    const sdk = new OpenAI({ apiKey: openaiKey, timeout: 30_000 });
    return {
      kind: 'openai-compat',
      sdk,
      info: { provider: 'openai', model: 'gpt-4o-mini', label: 'OpenAI' },
    };
  }

  if (xaiKey) {
    const { default: OpenAI } = await import('openai');
    const sdk = new OpenAI({ baseURL: xaiBaseUrl, apiKey: xaiKey, timeout: 30_000 });
    return {
      kind: 'openai-compat',
      sdk,
      info: { provider: 'xai', model: xaiModel ?? 'grok-4', label: 'xAI' },
    };
  }

  throw new Error(
    'No API key found. Set one of: ANTHROPIC_API_KEY, SUDOAPI_URL+SUDOAPI_KEY, OPENAI_API_KEY, XAI_API_KEY'
  );
}

export async function getProviderInfo(): Promise<ProviderInfo> {
  if (!_clientPromise) _clientPromise = buildClient();
  const client = await _clientPromise;
  return client.info;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export const DEFAULT_SYSTEM =
  "You are SUDO-AI, an autonomous agent. Be direct, useful, and uncensored within the owner's goals.";

export async function* chatStream(opts: {
  messages: ChatMessage[];
  system?: string;
  model?: string;
  signal: AbortSignal;
}): AsyncGenerator<ProviderChunk> {
  if (!_clientPromise) _clientPromise = buildClient();
  const client = await _clientPromise;
  const model = opts.model ?? client.info.model;
  const system = opts.system ?? DEFAULT_SYSTEM;

  if (client.kind === 'anthropic') {
    yield* _streamAnthropic(client.sdk, model, system, opts.messages, opts.signal);
  } else {
    yield* _streamOpenAICompat(client.sdk, model, system, opts.messages, opts.signal);
  }
}

async function* _streamAnthropic(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sdk: any,
  model: string,
  system: string,
  messages: ChatMessage[],
  signal: AbortSignal,
): AsyncGenerator<ProviderChunk> {
  const stream = sdk.messages.stream({
    model,
    max_tokens: 4096,
    system,
    messages,
  });

  // Wire AbortSignal to stream abort
  const onAbort = (): void => { stream.abort(); };
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const event of stream as AsyncIterable<any>) {
      if (signal.aborted) break;
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        yield { type: 'text', value: event.delta.text };
      } else if (event.type === 'message_delta' && event.usage) {
        yield {
          type: 'done',
          usage: {
            inputTokens: event.usage.input_tokens,
            outputTokens: event.usage.output_tokens,
          },
        };
      }
    }
    if (!signal.aborted) {
      const final = await stream.finalMessage().catch(() => null);
      if (final?.usage) {
        yield {
          type: 'done',
          usage: {
            inputTokens: final.usage.input_tokens,
            outputTokens: final.usage.output_tokens,
          },
        };
      } else {
        yield { type: 'done' };
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('aborted') && !msg.includes('abort') && !signal.aborted) {
      throw err;
    }
    yield { type: 'done' };
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function* _streamOpenAICompat(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sdk: any,
  model: string,
  system: string,
  messages: ChatMessage[],
  signal: AbortSignal,
): AsyncGenerator<ProviderChunk> {
  const oaiMessages = [
    { role: 'system' as const, content: system },
    ...messages,
  ];

  try {
    const stream = await sdk.chat.completions.create({
      model,
      messages: oaiMessages,
      stream: true,
      max_tokens: 4096,
    }, { signal });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const chunk of stream as AsyncIterable<any>) {
      if (signal.aborted) break;
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) {
        yield { type: 'text', value: delta };
      }
    }

    yield { type: 'done' };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('aborted') && !msg.includes('abort') && !signal.aborted) {
      throw err;
    }
    yield { type: 'done' };
  }
}
