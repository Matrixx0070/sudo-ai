/**
 * custom.codex — Autonomous coding agent using Vercel AI SDK.
 *
 * Uses generateText() with all configured providers in priority order.
 * No external CLI binary — pure SDK, works with any provider that has an API key.
 *
 * Provider priority (auto-fallback):
 *   1. xai/grok-4-1-fast-reasoning   — always available (paid subscription)
 *   2. openai/o4-mini                 — when OpenAI billing OK
 *   3. anthropic/claude-sonnet-4-5    — when Anthropic key available
 *   4. google/gemini-2.5-flash        — when Gemini key available
 *   5. groq/llama-3.3-70b-versatile   — when Groq key available (free tier)
 *
 * Actions: run (default), review
 */

import { generateText } from 'ai';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { getModel, listAvailableProviders } from '../../../brain/providers.js';
import { PROJECT_ROOT } from '../../../shared/paths.js';

const logger = createLogger('custom.codex');

// ---------------------------------------------------------------------------
// Provider cascade — tried in order, first success wins
// ---------------------------------------------------------------------------

interface ProviderOption {
  model: string;
  label: string;
  maxTokens: number;
}

const PROVIDER_CASCADE: ProviderOption[] = [
  { model: 'xai/grok-4-0709',              label: 'Grok 4 (2M ctx)',    maxTokens: 32768 },
  { model: 'xai/grok-4.20-0309-reasoning', label: 'Grok 4.20 Reasoning',maxTokens: 32768 },
  { model: 'xai/grok-4-1-fast-reasoning',  label: 'Grok Fast Reasoning',maxTokens: 16384 },
  { model: 'openai/o4-mini',               label: 'OpenAI o4-mini',     maxTokens: 16384 },
  { model: 'anthropic/claude-sonnet-4-5',  label: 'Claude Sonnet',      maxTokens: 8192  },
  { model: 'google/gemini-2.5-flash',      label: 'Gemini 2.5 Flash',   maxTokens: 8192  },
  { model: 'groq/llama-3.3-70b-versatile', label: 'Groq Llama 3.3 70B', maxTokens: 8192  },
];

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const CODING_SYSTEM = `You are an expert autonomous coding agent. Your job is to complete coding tasks fully and correctly.

Rules:
- Analyse the task carefully before writing any code
- Write complete, working code — no placeholders or "TODO" stubs
- Follow the existing code style in the project
- Handle errors properly
- If multiple files need changing, show ALL of them
- End your response with a clear summary: what was done, what files changed, what to test`;

const REVIEW_SYSTEM = `You are an expert code reviewer conducting an adversarial security and quality review.

Review for:
1. Security vulnerabilities (injection, XSS, auth bypass, data exposure)
2. Logic errors and edge cases
3. Performance issues
4. TypeScript type safety gaps
5. Missing error handling
6. Code quality and maintainability

Be specific — cite file names and line numbers. Rate severity: CRITICAL / HIGH / MEDIUM / LOW.`;

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const codexTool: ToolDefinition = {
  name: 'custom.codex',
  description:
    'Autonomous coding agent powered by Vercel AI SDK — automatically uses the best available ' +
    'provider (Grok → OpenAI o4-mini → Claude → Gemini → Groq) with fallback. ' +
    'Actions: run (complete a coding task), review (adversarial code review), providers (list available). ' +
    'Best for: complex bug fixes, refactoring, writing tests, architecture questions, code review. ' +
    'Provide specific task descriptions with file paths and error messages for best results.',
  category: 'meta' as const,
  timeout: 120_000,
  parameters: {
    task: {
      type: 'string',
      description:
        'The coding task to complete. Be specific — include file paths, error messages, or ' +
        'acceptance criteria. E.g.: "Fix the TypeScript error in src/core/agent/loop.ts line 45"',
    },
    action: {
      type: 'string',
      description: 'What to do: "run" (complete coding task, default), "review" (code review), "providers" (list available).',
      enum: ['run', 'review', 'providers'],
      default: 'run',
    },
    model: {
      type: 'string',
      description:
        'Force a specific model (e.g. "openai/o4-mini", "xai/grok-4-1-fast-reasoning"). ' +
        'Leave empty for automatic provider selection with fallback.',
    },
    context: {
      type: 'string',
      description: 'Extra context to include — paste relevant code, error messages, or file contents.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action  = (params['action']  as string | undefined) ?? 'run';
    const task    = (params['task']    as string | undefined)?.trim() ?? '';
    const forced  = (params['model']   as string | undefined)?.trim() ?? '';
    const context = (params['context'] as string | undefined)?.trim() ?? '';

    logger.info({ session: ctx.sessionId, action, forced }, 'custom.codex invoked');

    // ---- PROVIDERS ----
    if (action === 'providers') {
      const available = listAvailableProviders();
      const lines = PROVIDER_CASCADE.map(p => {
        const [providerName] = p.model.split('/');
        const isAvail = available.includes(providerName as never);
        return `  ${isAvail ? '✅' : '❌'} ${p.model.padEnd(35)} ${p.label}`;
      });
      return {
        success: true,
        output: `**custom.codex — Available Providers:**\n\n${lines.join('\n')}\n\nProviders auto-fallback in order shown.`,
      };
    }

    if (!task && action !== 'review') {
      return { success: false, output: 'custom.codex: "task" is required.' };
    }

    const systemPrompt = action === 'review' ? REVIEW_SYSTEM : CODING_SYSTEM;

    const userPrompt = action === 'review'
      ? `Review the codebase at ${PROJECT_ROOT}/src for security, quality, and correctness issues.\n\n${task ? `Focus on: ${task}` : 'Full adversarial review.'}`
      : `Task: ${task}${context ? `\n\nContext:\n${context}` : ''}`;

    // ---- Try forced model first, then cascade ----
    const cascade: ProviderOption[] = forced
      ? [{ model: forced, label: forced, maxTokens: 16384 }, ...PROVIDER_CASCADE]
      : PROVIDER_CASCADE;

    const errors: string[] = [];

    for (const option of cascade) {
      try {
        const model = getModel(option.model);
        logger.info({ model: option.model, action }, 'Trying provider');

        const result = await generateText({
          model,
          system: systemPrompt,
          prompt: userPrompt,
          maxOutputTokens: option.maxTokens,
          temperature: action === 'review' ? 0.3 : 0.5,
        });

        const output = result.text?.trim() ?? '';
        if (!output) {
          errors.push(`${option.label}: empty response`);
          continue;
        }

        logger.info({ model: option.model, chars: output.length }, 'Codex task completed');

        return {
          success: true,
          output: `**[CODEX — ${option.label}]**\n\n${output}`,
          data: { model: option.model, chars: output.length, action },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isUnconfigured = msg.includes('not configured') || msg.includes('API key');
        const isQuota = msg.includes('quota') || msg.includes('billing') || msg.includes('429') || msg.includes('insufficient');

        if (isUnconfigured) {
          logger.debug({ model: option.model }, 'Provider not configured — skipping');
          continue; // silently skip unconfigured providers
        }

        logger.warn({ model: option.model, err: msg }, 'Provider failed — trying next');
        errors.push(`${option.label}: ${isQuota ? 'quota/billing issue' : msg.slice(0, 80)}`);
        continue;
      }
    }

    // All providers failed
    return {
      success: false,
      output: [
        'custom.codex: All providers failed.',
        '',
        'Attempted:',
        ...errors.map(e => `  • ${e}`),
        '',
        'Check API keys in config/.env or add credits to your accounts.',
      ].join('\n'),
    };
  },
};
