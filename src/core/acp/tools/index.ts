/**
 * @file acp/tools/index.ts
 * @description Build an {@link AcpToolHost} that serves the ACP fs/* +
 * terminal/* tools (gap #26 slice 3).
 *
 * The factory takes an {@link AcpClientFacade}. At dispatch time the host
 * looks up the tool by name and forwards to its `execute()` method with the
 * sessionId the backend supplies + the facade the factory was built with.
 */

import type { AcpClientFacade } from '../client-facade.js';
import type { AcpToolHost, ToolMetadata } from '../brain-backend.js';
import { FS_TOOLS, type FsToolDef } from './fs-tools.js';
import { TERMINAL_TOOLS, type TerminalToolDef } from './terminal-tools.js';

export interface BuildAcpToolHostOptions {
  facade: AcpClientFacade;
}

/** Build the host wiring fs.* + terminal.* tools onto the facade. */
export function buildAcpToolHost(opts: BuildAcpToolHostOptions): AcpToolHost {
  const tools = new Map<string, FsToolDef | TerminalToolDef>();
  for (const t of FS_TOOLS) tools.set(t.name, t);
  for (const t of TERMINAL_TOOLS) tools.set(t.name, t);

  return {
    describe(toolName: string): ToolMetadata | undefined {
      const def = tools.get(toolName);
      return def ? def.metadata : undefined;
    },
    async execute(toolName, args, signal, sessionId) {
      if (signal.aborted) {
        return { success: false, output: 'aborted' };
      }
      const def = tools.get(toolName);
      if (!def) {
        return { success: false, output: `unknown tool: ${toolName}` };
      }
      return def.execute(args, sessionId, opts.facade);
    },
  };
}

/** Names of every tool the host serves — exported for catalog inspection. */
export function listAcpTools(): string[] {
  return [...FS_TOOLS, ...TERMINAL_TOOLS].map((t) => t.name);
}

export type { FsToolDef } from './fs-tools.js';
export type { TerminalToolDef } from './terminal-tools.js';
