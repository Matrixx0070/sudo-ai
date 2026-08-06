/**
 * @file provider.ts — Shared chunk/message types for the SUDO-AI chat TUI,
 * plus the TUI's config/.env bootstrap.
 *
 * This module used to ALSO carry a second, parallel way to serve a turn: it
 * built an official Anthropic/OpenAI SDK client from whatever API key happened
 * to sit in the environment and streamed from it directly. Nothing ever called
 * it. Real turns go App.tsx → TuiAgentAdapter → AgentLoop → Brain →
 * src/llm/transport.ts, which does its own routing, budgeting and failover.
 * The SDK path was deleted; what remains is types + the .env bootstrap.
 */

import fs from 'node:fs';
import { PATHS } from '../../../core/shared/constants.js';

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

// LOAD-BEARING — do not delete, and do not move below the type exports.
//
// `sudo-ai chat` is registered in cli/index.ts WITHOUT the `preAction` dotenv
// hook that `grok` and `voice` install, so this module-scope call is the ONLY
// thing that hydrates config/.env for the whole TUI process. App.tsx imports
// this module for DEFAULT_SYSTEM, which is what causes it to run — and it must
// run at IMPORT time, because paths.ts/constants.ts latch DATA_DIR the first
// time they are loaded. Hydrating later (e.g. inside runChat()) would be too
// late for anything already resolved at module load.
//
// Measured both directions: with this call, importing cli/commands/chat.js
// hydrates a sentinel from config/.env; with it commented out the same import
// leaves the sentinel ABSENT. Pinned by tests/cli/chat/provider-dotenv.test.ts.
//
// This is the same class of invisible contract as the DATA_DIR capture
// documented in agent-loop-adapter.ts — hence the test rather than a comment.
loadDotEnv(PATHS.ENV);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProviderKind = 'anthropic' | 'ollama' | 'openai' | 'xai';

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

/**
 * The model that ACTUALLY served the turn, from the agent loop's routing trace.
 *
 * The header must render this, and nothing else. The deleted getProviderInfo()
 * reported whichever API key happened to be present on this machine — a value
 * with no connection to the model the Brain actually used. On a box whose only
 * key was an exhausted OpenAI one, the header read "OpenAI / gpt-4o-mini" while
 * every turn was in fact answered over the Claude seat lane.
 */
export interface ModelChunk {
  type: 'model';
  provider: string;
  model: string;
}

export type ProviderChunk = StreamChunk | DoneChunk
  | ToolStartChunk | ToolEndChunk | ToolErrorChunk | ToolPermissionChunk
  | ModelChunk;

export interface ProviderInfo {
  provider: ProviderKind;
  model: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Default system prompt
// ---------------------------------------------------------------------------

export const DEFAULT_SYSTEM =
  "You are SUDO-AI, an autonomous agent. Be direct, useful, and act within the owner's goals.";
