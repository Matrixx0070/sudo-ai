/**
 * system.claude — Ask Claude directly via CLI subprocess.
 *
 * Uses Claude Code's OAuth authentication (Claude Max subscription).
 * SUDO can use this tool to leverage Claude's intelligence for
 * complex reasoning, code review, analysis, or any task where
 * Claude's capabilities exceed the primary brain.
 */

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';

const log = createLogger('system.claude');
const SCRIPT = join(process.cwd(), 'scripts', 'claude-call.sh');

export const claudeAskTool: ToolDefinition = {
  name: 'system.claude',
  description:
    'Ask Claude (Anthropic) a question directly. Uses Claude Max subscription via CLI. ' +
    'Good for complex reasoning, code review, creative writing, analysis, or getting a second opinion. ' +
    'Returns Claude\'s response as text.',
  category: 'system',
  timeout: 120_000,
  parameters: {
    prompt: {
      type: 'string',
      required: true,
      description: 'The question or task for Claude.',
    },
    systemPrompt: {
      type: 'string',
      required: false,
      description: 'Optional system prompt to set Claude\'s behavior.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const prompt = typeof params['prompt'] === 'string' ? params['prompt'].trim() : '';
    if (!prompt) {
      return { success: false, output: 'system.claude: "prompt" is required.' };
    }

    if (prompt.length > 50_000) {
      return { success: false, output: 'system.claude: prompt exceeds 50,000 characters.' };
    }

    const startTime = Date.now();

    return new Promise((resolve) => {
      const child = execFile('/bin/bash', [SCRIPT], {
        timeout: 120_000,
        maxBuffer: 1024 * 1024 * 10,
        env: {
          ...process.env,
          HOME: '/root',
          TERM: 'xterm-256color',
        },
      }, (error, stdout, _stderr) => {
        const durationMs = Date.now() - startTime;

        if (error) {
          log.warn({ err: error.message.substring(0, 200), durationMs }, 'Claude call failed');
          resolve({
            success: false,
            output: `Claude call failed: ${error.message.substring(0, 200)}`,
          });
          return;
        }

        const content = stdout.trim();
        log.info({ chars: content.length, durationMs }, 'Claude response received');

        resolve({
          success: true,
          output: content.length > 8000 ? content.substring(0, 8000) + '\n...(truncated)' : content,
          data: {
            model: 'claude-max',
            chars: content.length,
            durationMs,
            truncated: content.length > 8000,
          },
        });
      });

      child.stdin?.write(prompt);
      child.stdin?.end();
    });
  },
};
