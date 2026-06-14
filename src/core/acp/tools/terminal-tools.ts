/**
 * @file acp/tools/terminal-tools.ts
 * @description Tool wrappers for the ACP `terminal/*` client requests
 * (gap #26 slice 3).
 *
 * The agent gets one tool per terminal verb. Sensitive ones (create, kill)
 * require permission; introspection ones (output, wait_for_exit) do not.
 * `release` is a cleanup hint — neither destructive nor introspective, so
 * it runs without prompting.
 */

import type { ToolMetadata } from '../brain-backend.js';
import type { AcpClientFacade } from '../client-facade.js';
import type { ToolExecResult } from './fs-tools.js';
import { requireString } from './utils.js';

export interface TerminalToolDef {
  name: string;
  metadata: ToolMetadata;
  execute(args: Record<string, unknown>, sessionId: string, facade: AcpClientFacade): Promise<ToolExecResult>;
}

/** Render a terminal exit-status block compactly for the model. */
function renderExit(exit?: { exitCode?: number; signal?: string }): string {
  if (!exit) return 'running';
  const bits: string[] = [];
  if (typeof exit.exitCode === 'number') bits.push(`exit=${exit.exitCode}`);
  if (exit.signal) bits.push(`signal=${exit.signal}`);
  return bits.length > 0 ? bits.join(' ') : 'exited';
}

export const TERMINAL_CREATE: TerminalToolDef = {
  name: 'terminal.create',
  metadata: { title: 'Create terminal', kind: 'execute', requiresConfirmation: true },
  async execute(args, sessionId, facade) {
    let command: string;
    try {
      command = requireString(args, 'command');
    } catch (err) {
      return { success: false, output: err instanceof Error ? err.message : String(err) };
    }
    const params: { sessionId: string; command: string; args?: string[]; cwd?: string; env?: Record<string, string>; outputByteLimit?: number } = {
      sessionId,
      command,
    };
    if (Array.isArray(args['args'])) {
      params.args = (args['args'] as unknown[]).filter((s) => typeof s === 'string') as string[];
    }
    if (typeof args['cwd'] === 'string') params.cwd = args['cwd'];
    if (args['env'] && typeof args['env'] === 'object' && !Array.isArray(args['env'])) {
      params.env = args['env'] as Record<string, string>;
    }
    if (typeof args['outputByteLimit'] === 'number') {
      params.outputByteLimit = args['outputByteLimit'] as number;
    }
    try {
      const result = await facade.terminalCreate(params);
      return { success: true, output: `terminalId=${result.terminalId}` };
    } catch (err) {
      return {
        success: false,
        output: `terminal/create failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

export const TERMINAL_OUTPUT: TerminalToolDef = {
  name: 'terminal.output',
  metadata: { title: 'Read terminal output', kind: 'read', requiresConfirmation: false },
  async execute(args, sessionId, facade) {
    let terminalId: string;
    try {
      terminalId = requireString(args, 'terminalId');
    } catch (err) {
      return { success: false, output: err instanceof Error ? err.message : String(err) };
    }
    try {
      const result = await facade.terminalOutput({ sessionId, terminalId });
      const lines = [
        `status: ${renderExit(result.exitStatus)}`,
        result.truncated ? '(buffer truncated)' : '',
        result.output,
      ].filter((s) => s !== '');
      return { success: true, output: lines.join('\n') };
    } catch (err) {
      return {
        success: false,
        output: `terminal/output failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

export const TERMINAL_WAIT_FOR_EXIT: TerminalToolDef = {
  name: 'terminal.wait_for_exit',
  metadata: { title: 'Wait for terminal exit', kind: 'read', requiresConfirmation: false },
  async execute(args, sessionId, facade) {
    let terminalId: string;
    try {
      terminalId = requireString(args, 'terminalId');
    } catch (err) {
      return { success: false, output: err instanceof Error ? err.message : String(err) };
    }
    try {
      const result = await facade.terminalWaitForExit({ sessionId, terminalId });
      return { success: true, output: renderExit(result) };
    } catch (err) {
      return {
        success: false,
        output: `terminal/wait_for_exit failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

export const TERMINAL_KILL: TerminalToolDef = {
  name: 'terminal.kill',
  metadata: { title: 'Kill terminal', kind: 'execute', requiresConfirmation: true },
  async execute(args, sessionId, facade) {
    let terminalId: string;
    try {
      terminalId = requireString(args, 'terminalId');
    } catch (err) {
      return { success: false, output: err instanceof Error ? err.message : String(err) };
    }
    try {
      await facade.terminalKill({ sessionId, terminalId });
      return { success: true, output: `killed terminal ${terminalId}` };
    } catch (err) {
      return {
        success: false,
        output: `terminal/kill failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

export const TERMINAL_RELEASE: TerminalToolDef = {
  name: 'terminal.release',
  metadata: { title: 'Release terminal', kind: 'other', requiresConfirmation: false },
  async execute(args, sessionId, facade) {
    let terminalId: string;
    try {
      terminalId = requireString(args, 'terminalId');
    } catch (err) {
      return { success: false, output: err instanceof Error ? err.message : String(err) };
    }
    try {
      await facade.terminalRelease({ sessionId, terminalId });
      return { success: true, output: `released terminal ${terminalId}` };
    } catch (err) {
      return {
        success: false,
        output: `terminal/release failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

export const TERMINAL_TOOLS: readonly TerminalToolDef[] = [
  TERMINAL_CREATE,
  TERMINAL_OUTPUT,
  TERMINAL_WAIT_FOR_EXIT,
  TERMINAL_KILL,
  TERMINAL_RELEASE,
] as const;
