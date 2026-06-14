/**
 * @file tests/acp/fs-terminal-tools.test.ts
 * @description Tests for the ACP fs/* + terminal/* tool wrappers and the
 * AcpClientFacade (gap #26 slice 3).
 */

import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  JsonRpcConnection,
  AcpRpcError,
  JsonRpcErrorCode,
} from '../../src/core/acp/jsonrpc.js';
import { makeJsonRpcClientFacade, type AcpClientFacade } from '../../src/core/acp/client-facade.js';
import { buildAcpToolHost, listAcpTools } from '../../src/core/acp/tools/index.js';
import {
  FS_READ_TEXT_FILE,
  FS_WRITE_TEXT_FILE,
} from '../../src/core/acp/tools/fs-tools.js';
import {
  TERMINAL_CREATE,
  TERMINAL_OUTPUT,
  TERMINAL_WAIT_FOR_EXIT,
  TERMINAL_KILL,
  TERMINAL_RELEASE,
} from '../../src/core/acp/tools/terminal-tools.js';

// ---------------------------------------------------------------------------
// Stub facade
// ---------------------------------------------------------------------------

function stubFacade(overrides: Partial<AcpClientFacade> = {}): AcpClientFacade {
  return {
    fsReadTextFile: async () => ({ content: 'default-content' }),
    fsWriteTextFile: async () => ({} as never),
    terminalCreate: async () => ({ terminalId: 'term-1' }),
    terminalOutput: async () => ({ output: '', truncated: false }),
    terminalWaitForExit: async () => ({ exitCode: 0 }),
    terminalKill: async () => ({} as never),
    terminalRelease: async () => ({} as never),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// listAcpTools / buildAcpToolHost
// ---------------------------------------------------------------------------

describe('buildAcpToolHost + listAcpTools (gap #26 slice 3)', () => {
  it('lists every fs/terminal tool', () => {
    const names = listAcpTools();
    expect(names).toContain('fs.read_text_file');
    expect(names).toContain('fs.write_text_file');
    expect(names).toContain('terminal.create');
    expect(names).toContain('terminal.output');
    expect(names).toContain('terminal.wait_for_exit');
    expect(names).toContain('terminal.kill');
    expect(names).toContain('terminal.release');
  });

  it('describe() returns metadata for known tools, undefined for unknown', () => {
    const host = buildAcpToolHost({ facade: stubFacade() });
    expect(host.describe('fs.read_text_file')?.kind).toBe('read');
    expect(host.describe('fs.write_text_file')?.requiresConfirmation).toBe(true);
    expect(host.describe('terminal.create')?.requiresConfirmation).toBe(true);
    expect(host.describe('terminal.output')?.requiresConfirmation).toBe(false);
    expect(host.describe('does.not.exist')).toBeUndefined();
  });

  it('execute() routes to the matching tool', async () => {
    let captured = '';
    const facade = stubFacade({
      fsReadTextFile: async (p) => {
        captured = p.path;
        return { content: 'hello' };
      },
    });
    const host = buildAcpToolHost({ facade });
    const ac = new AbortController();
    const res = await host.execute('fs.read_text_file', { path: 'a.txt' }, ac.signal, 's1');
    expect(res.success).toBe(true);
    expect(res.output).toBe('hello');
    expect(captured).toBe('a.txt');
  });

  it('execute() returns honest failure for an unknown tool', async () => {
    const host = buildAcpToolHost({ facade: stubFacade() });
    const res = await host.execute('mystery', {}, new AbortController().signal, 's1');
    expect(res.success).toBe(false);
    expect(res.output).toContain('unknown tool');
  });

  it('execute() honors aborted signal up-front', async () => {
    const host = buildAcpToolHost({ facade: stubFacade() });
    const ac = new AbortController();
    ac.abort();
    const res = await host.execute('fs.read_text_file', { path: 'a' }, ac.signal, 's1');
    expect(res.success).toBe(false);
    expect(res.output).toBe('aborted');
  });
});

// ---------------------------------------------------------------------------
// fs.* tools
// ---------------------------------------------------------------------------

describe('FS_READ_TEXT_FILE', () => {
  it('requires path and surfaces a clean error when missing', async () => {
    const res = await FS_READ_TEXT_FILE.execute({}, 's1', stubFacade());
    expect(res.success).toBe(false);
    expect(res.output).toContain('path must be');
  });

  it('forwards line/limit when provided', async () => {
    let captured: { line?: number; limit?: number } = {};
    const facade = stubFacade({
      fsReadTextFile: async (p) => {
        captured = { line: p.line, limit: p.limit };
        return { content: 'X' };
      },
    });
    const res = await FS_READ_TEXT_FILE.execute(
      { path: 'a.txt', line: 5, limit: 100 },
      's1',
      facade,
    );
    expect(res.success).toBe(true);
    expect(captured.line).toBe(5);
    expect(captured.limit).toBe(100);
  });

  it('wraps facade errors as failures (no throw to caller)', async () => {
    const facade = stubFacade({
      fsReadTextFile: async () => {
        throw new Error('client refused');
      },
    });
    const res = await FS_READ_TEXT_FILE.execute({ path: 'a.txt' }, 's1', facade);
    expect(res.success).toBe(false);
    expect(res.output).toContain('client refused');
  });
});

describe('FS_WRITE_TEXT_FILE', () => {
  it('writes content of any length and reports byte count', async () => {
    const facade = stubFacade();
    const res = await FS_WRITE_TEXT_FILE.execute(
      { path: 'b.txt', content: 'hello' },
      's1',
      facade,
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('5 byte(s)');
    expect(res.output).toContain('b.txt');
  });

  it('treats missing content as empty string', async () => {
    const res = await FS_WRITE_TEXT_FILE.execute({ path: 'b.txt' }, 's1', stubFacade());
    expect(res.success).toBe(true);
    expect(res.output).toContain('0 byte(s)');
  });
});

// ---------------------------------------------------------------------------
// terminal.* tools
// ---------------------------------------------------------------------------

describe('TERMINAL_CREATE', () => {
  it('returns the terminalId on success', async () => {
    const facade = stubFacade({
      terminalCreate: async () => ({ terminalId: 't-abc' }),
    });
    const res = await TERMINAL_CREATE.execute({ command: 'ls' }, 's1', facade);
    expect(res.success).toBe(true);
    expect(res.output).toBe('terminalId=t-abc');
  });

  it('passes args/cwd/env through when provided', async () => {
    let captured: { args?: string[]; cwd?: string; env?: Record<string, string> } = {};
    const facade = stubFacade({
      terminalCreate: async (p) => {
        captured = { args: p.args, cwd: p.cwd, env: p.env };
        return { terminalId: 't' };
      },
    });
    await TERMINAL_CREATE.execute(
      {
        command: 'node',
        args: ['-e', '1+1'],
        cwd: '/tmp',
        env: { FOO: 'bar' },
      },
      's1',
      facade,
    );
    expect(captured.args).toEqual(['-e', '1+1']);
    expect(captured.cwd).toBe('/tmp');
    expect(captured.env).toEqual({ FOO: 'bar' });
  });
});

describe('TERMINAL_OUTPUT', () => {
  it('renders running status when no exitStatus is present', async () => {
    const facade = stubFacade({
      terminalOutput: async () => ({ output: 'line one', truncated: false }),
    });
    const res = await TERMINAL_OUTPUT.execute({ terminalId: 't' }, 's1', facade);
    expect(res.success).toBe(true);
    expect(res.output).toContain('status: running');
    expect(res.output).toContain('line one');
  });

  it('flags truncated output for the model', async () => {
    const facade = stubFacade({
      terminalOutput: async () => ({
        output: 'tail',
        truncated: true,
        exitStatus: { exitCode: 0 },
      }),
    });
    const res = await TERMINAL_OUTPUT.execute({ terminalId: 't' }, 's1', facade);
    expect(res.output).toContain('(buffer truncated)');
    expect(res.output).toContain('exit=0');
  });

  it('renders signal when reported by the client', async () => {
    const facade = stubFacade({
      terminalOutput: async () => ({
        output: '',
        truncated: false,
        exitStatus: { signal: 'SIGTERM' },
      }),
    });
    const res = await TERMINAL_OUTPUT.execute({ terminalId: 't' }, 's1', facade);
    expect(res.output).toContain('signal=SIGTERM');
  });
});

describe('TERMINAL_WAIT_FOR_EXIT', () => {
  it('returns a compact exit summary', async () => {
    const facade = stubFacade({
      terminalWaitForExit: async () => ({ exitCode: 137, signal: 'SIGKILL' }),
    });
    const res = await TERMINAL_WAIT_FOR_EXIT.execute({ terminalId: 't' }, 's1', facade);
    expect(res.success).toBe(true);
    expect(res.output).toBe('exit=137 signal=SIGKILL');
  });
});

describe('TERMINAL_KILL + TERMINAL_RELEASE', () => {
  it('kill confirms the action', async () => {
    const res = await TERMINAL_KILL.execute({ terminalId: 't-9' }, 's1', stubFacade());
    expect(res.success).toBe(true);
    expect(res.output).toContain('killed terminal t-9');
  });
  it('release confirms the action', async () => {
    const res = await TERMINAL_RELEASE.execute({ terminalId: 't-9' }, 's1', stubFacade());
    expect(res.success).toBe(true);
    expect(res.output).toContain('released terminal t-9');
  });
});

// ---------------------------------------------------------------------------
// makeJsonRpcClientFacade — request/response round-trip over real streams
// ---------------------------------------------------------------------------

describe('makeJsonRpcClientFacade (gap #26 slice 3)', () => {
  it('sends an fs/read_text_file request and resolves with the response', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const conn = new JsonRpcConnection(stdin, stdout);
    conn.start();
    const facade = makeJsonRpcClientFacade(conn);

    const outbound: string[] = [];
    stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) outbound.push(line.trim());
      }
    });

    const promise = facade.fsReadTextFile({ sessionId: 's1', path: 'a.txt' });

    await new Promise((r) => setImmediate(r));
    const req = JSON.parse(outbound[0]!) as { method: string; id: string; params: Record<string, unknown> };
    expect(req.method).toBe('fs/read_text_file');
    expect(req.params['path']).toBe('a.txt');

    stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: req.id,
        result: { content: 'file body' },
      }) + '\n',
    );

    const result = await promise;
    expect(result.content).toBe('file body');
  });

  it('propagates AcpRpcError when the client returns an error envelope', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const conn = new JsonRpcConnection(stdin, stdout);
    conn.start();
    const facade = makeJsonRpcClientFacade(conn);

    const outbound: string[] = [];
    stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) outbound.push(line.trim());
      }
    });

    const promise = facade.terminalCreate({ sessionId: 's1', command: 'ls' });
    await new Promise((r) => setImmediate(r));
    const req = JSON.parse(outbound[0]!) as { id: string };

    stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: req.id,
        error: { code: JsonRpcErrorCode.InvalidParams, message: 'denied' },
      }) + '\n',
    );

    await expect(promise).rejects.toBeInstanceOf(AcpRpcError);
  });

  it('uses the spec method names (slash-separated, not dot-separated)', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const conn = new JsonRpcConnection(stdin, stdout);
    conn.start();
    const facade = makeJsonRpcClientFacade(conn);
    const outbound: string[] = [];
    stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) outbound.push(line.trim());
      }
    });

    // Fire each facade method; capture the promises so we can settle them at
    // the end (verifier MED 3 — abandoned promises leak unsettled pending
    // entries in conn.pendingOutbound and produce unhandled-rejection noise
    // when a future jsonrpc.destroy() path is added).
    const pending: Promise<unknown>[] = [
      facade.fsReadTextFile({ sessionId: 's', path: 'x' }),
      facade.fsWriteTextFile({ sessionId: 's', path: 'x', content: '' }),
      facade.terminalCreate({ sessionId: 's', command: 'x' }),
      facade.terminalOutput({ sessionId: 's', terminalId: 't' }),
      facade.terminalWaitForExit({ sessionId: 's', terminalId: 't' }),
      facade.terminalKill({ sessionId: 's', terminalId: 't' }),
      facade.terminalRelease({ sessionId: 's', terminalId: 't' }),
    ];

    await new Promise((r) => setImmediate(r));
    const methods = outbound.map((line) => (JSON.parse(line) as { method: string }).method);
    expect(methods).toEqual([
      'fs/read_text_file',
      'fs/write_text_file',
      'terminal/create',
      'terminal/output',
      'terminal/wait_for_exit',
      'terminal/kill',
      'terminal/release',
    ]);

    // Settle every pending request with a synthetic empty success response so
    // pendingOutbound drains and Vitest does not see late unhandled rejections.
    for (const line of outbound) {
      const { id } = JSON.parse(line) as { id: string };
      stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result: {} }) + '\n');
    }
    await Promise.all(pending);
  });
});
