/**
 * Grok-seat toolkit — exposes the owner's FREE grok $30 subscription
 * capabilities as in-chat agent tools:
 *
 *   meta.grok-models      — seat model catalog + tier defaults + rate limits
 *   coder.grok-run-code   — grok's server-side Python sandbox (stdout/stderr)
 *   knowledge.grok-rag    — grounded answer over uploaded documents
 *
 * All three are OWNER-ONLY: they spend the owner's subscription seat, so an
 * explicitly-untrusted turn (ctx.isOwner === false) is refused before any work.
 * Enablement gates live in the underlying llm modules (SUDO_GROK_WEBSESSION for
 * models/rag; the grok subscription proxy for run-code) — this file never reads
 * those env vars or any provider hostname directly. Heavy deps (session manager,
 * statsig oracle, warm browser) are imported lazily inside execute() so tool
 * registration stays cheap. Never falls back to a metered API.
 */

import type { ToolRegistry } from '../../registry.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger('grok-seat-builtin');

const OWNER_ONLY =
  "This tool is owner-only — it spends the owner's grok subscription — and this turn is not the owner.";

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Map the shared grok web-session errors to an actionable one-liner. Imported
 * lazily (only on the error path) so registration never pulls the lib; both
 * classes are re-exported from grok-models.js.
 */
async function webSessionErrorMessage(err: unknown): Promise<string | null> {
  const { GrokWebDisabledError, GrokWebReloginRequiredError } = await import(
    '../../../../llm/grok-models.js'
  );
  if (err instanceof GrokWebDisabledError) {
    return 'The grok seat is off. Enable the free grok subscription (set SUDO_GROK_WEBSESSION=1) and retry.';
  }
  if (err instanceof GrokWebReloginRequiredError) {
    return 'The grok web session expired. Re-authenticate with `sudo-ai grok websession` and retry.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// meta.grok-models
// ---------------------------------------------------------------------------

const modelsTool: ToolDefinition = {
  name: 'meta.grok-models',
  description:
    "List the model catalog and tier defaults on the owner's FREE grok subscription seat, and (when modelName is given) that model's remaining rate-limit window. Owner-only. Requires SUDO_GROK_WEBSESSION=1.",
  category: 'meta',
  timeout: 60_000,
  parameters: {
    modelName: {
      type: 'string',
      description: 'If set, also return remaining/total query windows for this model (e.g. "grok-4").',
    },
    requestKind: {
      type: 'string',
      description: 'Rate-limit request kind for modelName (default DEFAULT).',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (ctx.isOwner === false) return { success: false, output: OWNER_ONLY };
    const modelName = (params['modelName'] as string | undefined)?.trim();
    const requestKind = (params['requestKind'] as string | undefined)?.trim();
    logger.info({ session: ctx.sessionId, modelName }, 'meta.grok-models invoked');

    try {
      const mod = await import('../../../../llm/grok-models.js');
      const catalog = await mod.getGrokModelCatalog();
      const names = catalog.models.map((m) => {
        const rec = m as unknown as Record<string, unknown>;
        return String(rec['modelId'] ?? rec['name'] ?? 'unknown');
      });
      let out = `Grok seat models (${names.length}): ${names.join(', ')}\nTier defaults: ${JSON.stringify(catalog.defaults)}`;
      let rateLimits: unknown;
      if (modelName) {
        const rl = await mod.getGrokRateLimits(modelName, requestKind ? { requestKind } : {});
        rateLimits = rl;
        out += `\nRate limit for ${rl.modelName} (${rl.requestKind}): ${rl.remainingQueries}/${rl.totalQueries} remaining in a ${rl.windowSizeSeconds}s window.`;
      }
      return { success: true, output: out, data: { catalog, ...(rateLimits ? { rateLimits } : {}) } };
    } catch (err) {
      const wm = await webSessionErrorMessage(err);
      return { success: false, output: wm ?? `grok models failed: ${errText(err)}` };
    }
  },
};

// ---------------------------------------------------------------------------
// coder.grok-run-code
// ---------------------------------------------------------------------------

const runCodeTool: ToolDefinition = {
  name: 'coder.grok-run-code',
  description:
    "Execute Python in grok's server-side sandbox (a Python REPL) on the owner's FREE grok subscription and return its stdout/stderr. Owner-only. Python only; files the code writes are NOT returned — print whatever you need to stdout. Requires the grok subscription proxy (SUDO_XAI_OAUTH_SUBSCRIPTION).",
  category: 'coder',
  timeout: 150_000,
  parameters: {
    code: {
      type: 'string',
      required: true,
      description: 'Python source to execute. Print results to stdout.',
    },
    language: {
      type: 'string',
      description: 'Language — Python only.',
      default: 'python',
      enum: ['python', 'python3', 'py'],
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (ctx.isOwner === false) return { success: false, output: OWNER_ONLY };
    const code = (params['code'] as string | undefined) ?? '';
    const language = (params['language'] as string | undefined) ?? 'python';
    logger.info({ session: ctx.sessionId, language, codeLen: code.length }, 'coder.grok-run-code invoked');
    if (!code.trim()) return { success: false, output: 'code is required.' };

    try {
      const mod = await import('../../../../llm/grok-runcode.js');
      const r = await mod.runGrokCode(language, code);
      const parts: string[] = [];
      if (r.stdout) parts.push(r.stdout.replace(/\n$/, ''));
      if (r.stderr) parts.push(`[stderr]\n${r.stderr.replace(/\n$/, '')}`);
      return {
        success: true,
        output: parts.join('\n') || '(no output)',
        data: { stdout: r.stdout, stderr: r.stderr },
      };
    } catch (err) {
      // GrokRunCodeError (disabled / relogin / unsupported_language / not_executed)
      // and the input TypeErrors all carry user-grade messages — surface directly.
      return { success: false, output: `grok run-code failed: ${errText(err)}` };
    }
  },
};

// ---------------------------------------------------------------------------
// knowledge.grok-rag
// ---------------------------------------------------------------------------

const ragTool: ToolDefinition = {
  name: 'knowledge.grok-rag',
  description:
    "Answer a question grounded in one or more documents by uploading them to grok and asking on the owner's FREE grok subscription. Provide files (local paths) and/or texts (inline). Owner-only. Returns grok's grounded answer (not raw chunks). Requires SUDO_GROK_WEBSESSION=1.",
  category: 'knowledge',
  timeout: 200_000,
  parameters: {
    question: {
      type: 'string',
      required: true,
      description: 'The question to answer from the provided documents.',
    },
    files: {
      type: 'array',
      description: 'Local file path(s) to attach as documents.',
      items: { type: 'string', description: 'Absolute path to a document.' },
    },
    texts: {
      type: 'array',
      description: 'Inline text document(s) to attach.',
      items: { type: 'string', description: 'Document text.' },
    },
    modelName: {
      type: 'string',
      description: 'Answering model override (default grok-4).',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (ctx.isOwner === false) return { success: false, output: OWNER_ONLY };
    const question = (params['question'] as string | undefined)?.trim() ?? '';
    const files = (params['files'] as string[] | undefined) ?? [];
    const texts = (params['texts'] as string[] | undefined) ?? [];
    const modelName = (params['modelName'] as string | undefined)?.trim();
    logger.info(
      { session: ctx.sessionId, files: files.length, texts: texts.length },
      'knowledge.grok-rag invoked',
    );
    if (!question) return { success: false, output: 'question is required.' };
    if (files.length === 0 && texts.length === 0) {
      return { success: false, output: 'Provide at least one document via files (paths) or texts (inline).' };
    }

    try {
      const mod = await import('../../../../llm/grok-rag.js');
      const r = await mod.grokRagQuery({ question, files, texts, ...(modelName ? { modelName } : {}) });
      return { success: true, output: r.answer, data: { conversationId: r.conversationId, fileIds: r.fileIds } };
    } catch (err) {
      const wm = await webSessionErrorMessage(err);
      return { success: false, output: wm ?? `grok rag failed: ${errText(err)}` };
    }
  },
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const GROK_SEAT_TOOLS: ToolDefinition[] = [modelsTool, runCodeTool, ragTool];

/**
 * Register all grok-seat tools with the given registry.
 * Called automatically by the built-in tool loader.
 *
 * @param registry - The application's central {@link ToolRegistry}.
 */
export function registerGrokSeatTools(registry: ToolRegistry): void {
  logger.info({ count: GROK_SEAT_TOOLS.length }, 'Registering grok-seat tools');
  for (const tool of GROK_SEAT_TOOLS) {
    registry.register(tool);
  }
  logger.info({ count: GROK_SEAT_TOOLS.length }, 'Grok-seat tools registered');
}
