/**
 * Claude CLI Provider — uses Claude Code CLI as a subprocess to access Claude Max.
 *
 * This bypasses the API OAuth limitation by using Claude Code's own auth.
 * Claude Code handles OAuth token refresh internally.
 *
 * Usage: Set CLAUDE_CLI_ENABLED=true in .env to enable.
 */

import { execFile } from 'node:child_process';
import { createLogger } from '../shared/logger.js';

const log = createLogger('brain:claude-cli');

const CLAUDE_BIN = '/usr/bin/claude';
const DEFAULT_TIMEOUT = 120_000; // 2 minutes

export interface ClaudeCLIResponse {
  content: string;
  model: string;
  success: boolean;
  durationMs: number;
}

/**
 * Call Claude via the CLI subprocess.
 * Uses -p (print mode) for non-interactive output.
 */
export async function callClaudeCLI(
  prompt: string,
  options?: {
    systemPrompt?: string;
    timeout?: number;
    model?: string;
  },
): Promise<ClaudeCLIResponse> {
  const startTime = Date.now();
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT;

  return new Promise((resolve) => {
    // Use wrapper script with stdin — works reliably under systemd
    const scriptPath = require('path').join(process.cwd(), 'scripts', 'claude-call.sh');

    const child = execFile('/bin/bash', [scriptPath], {
      timeout,
      maxBuffer: 1024 * 1024 * 10,
      env: {
        ...process.env,
        HOME: '/root',
        TERM: 'xterm-256color',
      },
    }, (error, stdout, _stderr) => {
      const durationMs = Date.now() - startTime;

      if (error) {
        log.warn({ err: error.message.substring(0, 200), durationMs }, 'Claude CLI call failed');
        resolve({ content: '', model: 'claude-cli', success: false, durationMs });
        return;
      }

      const content = stdout.trim();
      log.info({ chars: content.length, durationMs }, 'Claude CLI call succeeded');
      resolve({ content, model: 'claude-cli', success: true, durationMs });
    });

    // Write prompt to stdin
    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

/**
 * Check if Claude CLI is available and authenticated.
 */
export async function isClaudeCLIAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(CLAUDE_BIN, ['auth', 'status'], { timeout: 5000 }, (error, stdout) => {
      if (error) {
        resolve(false);
        return;
      }
      const loggedIn = stdout.includes('"loggedIn": true') || stdout.includes('"loggedIn":true');
      resolve(loggedIn);
    });
  });
}
