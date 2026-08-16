/**
 * @file god-mode-host-access.test.ts
 * @description God mode means the owner's commands take effect on the REAL
 * HOST, and a contained run says so.
 *
 * Found live (2026-08-16): after god mode lifted the approval layer, an
 * owner command `touch /etc/sudo-ai-godmode-proof` still ran inside the bwrap
 * sandbox. The tool reported success, the model reported "full root access
 * confirmed", and the host file did not exist. Two defects in one: the owner
 * did not actually have host access, and the report was untrue.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execTool } from '../../src/core/tools/builtin/system/shell-exec.js';
import type { ToolContext } from '../../src/core/tools/types.js';

const ENV_KEYS = ['SUDO_AUTHORITY_GOD_MODE', 'SUDO_AUTHORITY_MODE', 'SUDO_SANDBOX_DISABLE'] as const;
let saved: Record<string, string | undefined>;
let workspace: string;
let target: string;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  workspace = mkdtempSync(join(tmpdir(), 'godmode-ws-'));
  // A path OUTSIDE the session workspace: the sandbox must not reach it,
  // god mode must.
  target = join(mkdtempSync(join(tmpdir(), 'godmode-host-')), 'proof.txt');
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(workspace, { recursive: true, force: true });
  rmSync(target, { force: true });
});

function ctx(isOwner: boolean): ToolContext {
  return {
    sessionId: 'godmode-test',
    isOwner,
    workspaceDir: workspace,
    workingDir: workspace,
    sandboxPolicy: { enabled: true },
  } as unknown as ToolContext;
}

describe('god mode — real host access for the verified owner', () => {
  it('writes to the HOST when god mode is on and the caller is the owner', async () => {
    process.env['SUDO_AUTHORITY_GOD_MODE'] = '1';

    const res = await execTool.execute({ command: `touch ${target}` }, ctx(true));

    expect(res.success).toBe(true);
    // The whole point: the effect is real, not namespaced away.
    expect(existsSync(target), 'owner command must affect the real host').toBe(true);
    expect((res.data as { sandboxed?: boolean })?.sandboxed).not.toBe(true);
  });

  it('keeps a NON-owner contained even with god mode on', async () => {
    process.env['SUDO_AUTHORITY_GOD_MODE'] = '1';

    const res = await execTool.execute({ command: `touch ${target}` }, ctx(false));

    // Contained: the host path must not appear.
    expect(existsSync(target), 'non-owner must not reach the host').toBe(false);
    // …and the report must SAY it was contained, so nothing can claim
    // "file written" for a write that never touched the host.
    expect(String(res.output)).toContain('sandboxed');
  });

  it('keeps the OWNER contained when god mode is OFF (opt-in, not default)', async () => {
    const res = await execTool.execute({ command: `touch ${target}` }, ctx(true));

    expect(existsSync(target), 'god mode is opt-in').toBe(false);
    expect(String(res.output)).toContain('sandboxed');
  });
});
