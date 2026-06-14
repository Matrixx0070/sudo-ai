/**
 * @file acp/tools/fs-tools.ts
 * @description Tool wrappers that map agent tool calls to ACP `fs/*` client
 * requests (gap #26 slice 3).
 *
 * The tool host's `execute(toolName, args)` is the boundary; for `fs.read` it
 * calls `facade.fsReadTextFile()` which the standalone ACP entry has bound to
 * `conn.sendRequest('fs/read_text_file', ...)`. Tests inject a stub facade so
 * they exercise the args→params mapping without any wire.
 */

import type { ToolMetadata } from '../brain-backend.js';
import type { AcpClientFacade } from '../client-facade.js';
import { requireString } from './utils.js';

/** Result shape `AcpToolHost.execute` expects. */
export interface ToolExecResult {
  success: boolean;
  output: string;
}

/** Definition record for one fs tool. */
export interface FsToolDef {
  name: string;
  metadata: ToolMetadata;
  execute(args: Record<string, unknown>, sessionId: string, facade: AcpClientFacade): Promise<ToolExecResult>;
}

export const FS_READ_TEXT_FILE: FsToolDef = {
  name: 'fs.read_text_file',
  metadata: {
    title: 'Read text file',
    kind: 'read',
    // Reads are NOT gated by `session/request_permission` — the trust contract
    // is that the client surfaced a permission once when the session began,
    // and per-read prompts would make the agent unusable. Writes (below)
    // require confirmation.
    requiresConfirmation: false,
  },
  async execute(args, sessionId, facade) {
    let path: string;
    try {
      path = requireString(args, 'path');
    } catch (err) {
      return { success: false, output: err instanceof Error ? err.message : String(err) };
    }
    const params: { sessionId: string; path: string; line?: number; limit?: number } = {
      sessionId,
      path,
    };
    if (typeof args['line'] === 'number') params.line = args['line'] as number;
    if (typeof args['limit'] === 'number') params.limit = args['limit'] as number;
    try {
      const result = await facade.fsReadTextFile(params);
      return { success: true, output: result.content ?? '' };
    } catch (err) {
      return {
        success: false,
        output: `fs/read_text_file failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

export const FS_WRITE_TEXT_FILE: FsToolDef = {
  name: 'fs.write_text_file',
  metadata: {
    title: 'Write text file',
    kind: 'edit',
    // Writes are destructive. Always round-trip permission so the client
    // surfaces the path + (truncated) content for the user to inspect.
    requiresConfirmation: true,
  },
  async execute(args, sessionId, facade) {
    let path: string;
    let content: string;
    try {
      path = requireString(args, 'path');
      content = typeof args['content'] === 'string' ? args['content'] as string : '';
    } catch (err) {
      return { success: false, output: err instanceof Error ? err.message : String(err) };
    }
    try {
      await facade.fsWriteTextFile({ sessionId, path, content });
      return { success: true, output: `wrote ${content.length} byte(s) to ${path}` };
    } catch (err) {
      return {
        success: false,
        output: `fs/write_text_file failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

export const FS_TOOLS: readonly FsToolDef[] = [FS_READ_TEXT_FILE, FS_WRITE_TEXT_FILE] as const;
