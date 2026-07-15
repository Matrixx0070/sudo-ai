import { afterEach, describe, expect, it } from 'vitest';
import {
  ConnectParamsSchema,
  RpcRequestSchema,
  RPC_PROTOCOL_VERSION,
  buildHelloOk,
  mayCallMethod,
  requiredScopeFor,
  rpcV2Enabled,
} from '../../src/core/gateway/rpc-schema.js';
import type { GatewayPrincipal } from '../../src/core/gateway/auth.js';

const admin: GatewayPrincipal = {
  ok: true, credential: 'gateway-token', scopes: ['operator.admin'], isOwner: true, reason: 't',
};
const readOnly: GatewayPrincipal = {
  ok: true, credential: 'web-chat-token', scopes: ['operator.read'], isOwner: false, reason: 't',
};

describe('rpc-schema (WS RPC v2)', () => {
  const saved = process.env['SUDO_GATEWAY_RPC_V2'];
  afterEach(() => {
    if (saved === undefined) delete process.env['SUDO_GATEWAY_RPC_V2'];
    else process.env['SUDO_GATEWAY_RPC_V2'] = saved;
  });

  it('rpcV2Enabled reflects the env flag (default off)', () => {
    delete process.env['SUDO_GATEWAY_RPC_V2'];
    expect(rpcV2Enabled()).toBe(false);
    process.env['SUDO_GATEWAY_RPC_V2'] = '1';
    expect(rpcV2Enabled()).toBe(true);
    process.env['SUDO_GATEWAY_RPC_V2'] = '0';
    expect(rpcV2Enabled()).toBe(false);
  });

  it('RpcRequestSchema validates the frame shape', () => {
    expect(RpcRequestSchema.safeParse({ id: '1', method: 'health' }).success).toBe(true);
    expect(RpcRequestSchema.safeParse({ id: '1', method: 'health', params: { x: 1 } }).success).toBe(true);
    expect(RpcRequestSchema.safeParse({ id: '', method: 'health' }).success).toBe(false);
    expect(RpcRequestSchema.safeParse({ method: 'health' }).success).toBe(false);
    expect(RpcRequestSchema.safeParse({ id: '1' }).success).toBe(false);
  });

  it('ConnectParamsSchema accepts undefined / partial / extra, rejects bad types', () => {
    expect(ConnectParamsSchema.safeParse(undefined).success).toBe(true);
    expect(ConnectParamsSchema.safeParse({}).success).toBe(true);
    expect(ConnectParamsSchema.safeParse({ minProtocol: 1, maxProtocol: 1 }).success).toBe(true);
    expect(ConnectParamsSchema.safeParse({ extra: 'ok' }).success).toBe(true);
    expect(ConnectParamsSchema.safeParse({ minProtocol: 'x' }).success).toBe(false);
  });

  it('requiredScopeFor maps read/write and defaults to write', () => {
    expect(requiredScopeFor('health')).toBe('operator.read');
    expect(requiredScopeFor('sessions.list')).toBe('operator.read');
    expect(requiredScopeFor('tools.catalog')).toBe('operator.read');
    expect(requiredScopeFor('chat.send')).toBe('operator.write');
    expect(requiredScopeFor('cron.remove')).toBe('operator.write');
    expect(requiredScopeFor('unknown.method')).toBe('operator.write');
  });

  it('mayCallMethod enforces scope (admin all; read-only denied writes)', () => {
    expect(mayCallMethod(admin, 'chat.send')).toBe(true);
    expect(mayCallMethod(admin, 'health')).toBe(true);
    expect(mayCallMethod(readOnly, 'health')).toBe(true);
    expect(mayCallMethod(readOnly, 'sessions.list')).toBe(true);
    expect(mayCallMethod(readOnly, 'chat.send')).toBe(false);
    expect(mayCallMethod(readOnly, 'unknown.method')).toBe(false);
    expect(mayCallMethod(undefined, 'health')).toBe(false);
  });

  it('buildHelloOk carries protocol, scopes, methods', () => {
    const hello = buildHelloOk(admin, ['health', 'chat.send']);
    expect(hello.type).toBe('hello-ok');
    expect(hello.protocol).toBe(RPC_PROTOCOL_VERSION);
    expect(hello.scopes).toEqual(['operator.admin']);
    expect(hello.methods).toEqual(['health', 'chat.send']);
    expect(hello.server.protocol).toBe(RPC_PROTOCOL_VERSION);
  });
});
