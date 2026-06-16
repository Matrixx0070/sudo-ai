// No explicit import of fetch needed: Node.js 22 includes fetch globally.

/**
 * Represents a message exchanged with the xAI chat API. A role of
 * `system` sets the behavior of the assistant, `user` provides the
 * request and `assistant` conveys model responses. See xAI API docs for
 * details on supported roles.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * All recognized roles within the Forge system. Each role is mapped to
 * a corresponding Grok model which specialises in different tasks such
 * as architecture design, complex logic construction, rapid coding,
 * multi‑pass review, vulnerability analysis and documentation.
 */
export type ForgeRole =
  | 'architect'
  | 'complex-builder'
  | 'fast-builder'
  | 'code-specialist'
  | 'reviewer'
  | 'security'
  | 'docs'
  | 'tester';

/**
 * Wrapper around the xAI chat completions API. It maps internal roles
 * to specific Grok models, manages retries with exponential backoff,
 * handles rate limiting and tracks token usage per model. Use one
 * instance per logical workflow to accumulate usage statistics.
 */
export class XaiEnsemble {
  /**
   * Accumulates token usage per model. Each entry holds prompt and
   * completion token counts which can be aggregated to understand
   * consumption patterns.
   */
  public readonly usageByModel: Map<string, { promptTokens: number; completionTokens: number }> =
    new Map();

  /**
   * Performs a chat completion call against the xAI API using the model
   * associated with the provided role. Supports optional temperature and
   * maxTokens settings. Retries up to three times on transient errors
   * using exponential backoff. For rate limiting (HTTP 429), waits the
   * duration indicated by the Retry‑After header before retrying.
   *
   * @param role The high‑level role driving model selection.
   * @param messages The ordered conversation messages to send.
   * @param opts Optional temperature and maxTokens overrides.
   * @returns The model’s generated content.
   */
  public async callModel(
    role: ForgeRole,
    messages: ChatMessage[],
    opts?: { temperature?: number; maxTokens?: number }
  ): Promise<string> {
    // Map Forge roles to Grok model identifiers. These names correspond to
    // current versions of the Grok models as of March 2026. Should new
    // models become available, update this mapping accordingly.
    const roleToModel: Record<ForgeRole, string> = {
      architect: 'grok-4.20-0309-reasoning',
      'complex-builder': 'grok-4-fast-reasoning',
      'fast-builder': 'grok-4-fast-non-reasoning',
      'code-specialist': 'grok-4-fast-non-reasoning',
      reviewer: 'grok-4-1-fast-non-reasoning',
      security: 'grok-4.20-0309-reasoning',
      docs: 'grok-4-fast-non-reasoning',
      tester: 'grok-4-fast-reasoning',
    };
    const model = roleToModel[role];
    if (!model) {
      throw new Error(`Unrecognised role: ${role}`);
    }
    const body: {
      model: string;
      messages: ChatMessage[];
      temperature?: number;
      max_tokens?: number;
    } = {
      model,
      messages,
    };
    if (opts?.temperature !== undefined) {
      body.temperature = opts.temperature;
    }
    if (opts?.maxTokens !== undefined) {
      body.max_tokens = opts.maxTokens;
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.XAI_API_KEY ?? ''}`,
    };
    const url = 'https://api.x.ai/v1/chat/completions';
    let attempt = 0;
    let lastError: unknown;
    while (attempt < 3) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
        // If rate limited, respect Retry‑After header.
        if (response.status === 429) {
          const retryAfter = response.headers.get('Retry-After');
          const delayMs = retryAfter ? parseFloat(retryAfter) * 1000 : Math.pow(2, attempt) * 1000;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          attempt++;
          continue;
        }
        if (!response.ok) {
          lastError = await response.text();
          throw new Error(
            `xAI API request failed (status ${response.status}): ${lastError || response.statusText}`
          );
        }
        // Shape of the xAI chat-completions response fields we consume.
        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: unknown } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const choice = data?.choices?.[0]?.message?.content ?? '';
        const usage = data?.usage;
        if (usage) {
          const prev = this.usageByModel.get(model) ?? { promptTokens: 0, completionTokens: 0 };
          this.usageByModel.set(model, {
            promptTokens: prev.promptTokens + (usage.prompt_tokens ?? 0),
            completionTokens: prev.completionTokens + (usage.completion_tokens ?? 0),
          });
        }
        return typeof choice === 'string' ? choice : JSON.stringify(choice);
      } catch (err: unknown) {
        lastError = err;
        // For transient network or server errors, apply exponential backoff.
        const delayMs = Math.pow(2, attempt) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        attempt++;
      }
    }
    const lastErrorMessage = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Failed to call xAI model after retries: ${lastErrorMessage}`);
  }
}
