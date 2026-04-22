/**
 * @file auto-research.ts
 * @description AutoResearch — automatic research loop triggered by recurring failures.
 *
 * When a tool or domain accumulates repeated failures, AutoResearch generates a
 * targeted research query, sends it to the LLM brain, and stores the findings
 * as a 'semantic' memory entry in the structured-memory store.
 *
 * Findings are returned as a plain string so callers can log, display, or relay them.
 */

import { createLogger } from '../shared/logger.js';
import { saveMemory } from '../memory/structured-memory.js';

const log = createLogger('self-improvement:auto-research');

const MAX_PROMPT_CHARS = 4000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FailurePattern {
  /** The capability domain or tool name with recurring failures. */
  domain: string;
  /** Number of observed failures for this domain. */
  failureCount: number;
  /** The most recent error message for context. */
  lastError: string;
}

// ---------------------------------------------------------------------------
// AutoResearch
// ---------------------------------------------------------------------------

export class AutoResearch {
  private readonly brainCall: (prompt: string) => Promise<string>;

  constructor(brainCall: (prompt: string) => Promise<string>) {
    if (typeof brainCall !== 'function') throw new TypeError('brainCall must be a function');
    this.brainCall = brainCall;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Run a research pass for a given failure pattern.
   *
   * 1. Builds a targeted research prompt from the pattern.
   * 2. Calls the LLM brain for findings.
   * 3. Persists findings as a 'semantic' structured memory entry.
   * 4. Returns the raw findings string.
   *
   * @param pattern - Failure pattern describing what to research.
   * @returns Research findings as a plain string.
   */
  async runForPattern(pattern: FailurePattern): Promise<string> {
    if (!pattern?.domain?.trim()) throw new Error('pattern.domain must not be empty');
    if (pattern.failureCount < 0) throw new Error('pattern.failureCount must be >= 0');

    const domain = pattern.domain.trim();
    const lastError = (pattern.lastError ?? '').slice(0, 500);

    log.info(
      { domain, failureCount: pattern.failureCount },
      'AutoResearch: starting research pass',
    );

    const prompt = this._buildPrompt(domain, pattern.failureCount, lastError);

    let findings: string;
    try {
      const raw = await this.brainCall(prompt);
      findings = (raw ?? '').trim();
      if (!findings) {
        log.warn({ domain }, 'AutoResearch: brain returned empty findings');
        findings = `No findings returned for domain: ${domain}`;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error({ domain, err: errMsg }, 'AutoResearch: brain call failed');
      throw new Error(`AutoResearch brainCall failed for domain "${domain}": ${errMsg}`);
    }

    // Persist findings as a semantic memory entry
    await this._storeFindings(domain, pattern.failureCount, findings);

    log.info({ domain, findingsLength: findings.length }, 'AutoResearch: research complete');
    return findings;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private _buildPrompt(domain: string, failureCount: number, lastError: string): string {
    const prompt = `You are a self-improvement researcher for an AI system. The system has experienced ${failureCount} repeated failures in the domain: "${domain}".

Most recent error: ${lastError || '(not provided)'}

Your task:
1. Identify the most likely root causes for failures in this domain.
2. Suggest 3-5 concrete, actionable strategies to prevent these failures.
3. List any known best practices or patterns relevant to this domain.

Be concise and practical. Focus on what an AI agent can implement immediately.`;

    return prompt.slice(0, MAX_PROMPT_CHARS);
  }

  private async _storeFindings(
    domain: string,
    failureCount: number,
    findings: string,
  ): Promise<void> {
    const name = `auto_research_${domain.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`;
    const description = `Auto-research findings for domain "${domain}" after ${failureCount} failures`;

    try {
      await saveMemory({
        type: 'semantic',
        name,
        description,
        content: findings,
      });
      log.debug({ domain, name }, 'AutoResearch: findings stored as semantic memory');
    } catch (err) {
      // Non-fatal — log and continue; findings are still returned to caller
      log.warn(
        { domain, err: String(err) },
        'AutoResearch: failed to persist findings to structured memory',
      );
    }
  }
}
