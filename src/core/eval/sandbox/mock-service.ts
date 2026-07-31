/**
 * @file mock-service.ts
 * @description Tiny scripted local HTTP server for unreliable-service scenarios
 * (ADR-0007 fault injection, service level). Scripted by the scenario manifest:
 * the first `failuresBeforeSuccess` requests get a 500, everything after gets a
 * 200 with `successBody`. Binds port 0 on loopback; the runner injects the
 * resulting URL into the scenario env.
 */

import { createServer, type Server } from 'node:http';

export interface MockServiceOptions {
  failuresBeforeSuccess: number;
  successBody: string;
}

export interface MockServiceHandle {
  url: string;
  /** Total requests served so far. */
  requestCount(): number;
  close(): Promise<void>;
}

export function startMockService(opts: MockServiceOptions): Promise<MockServiceHandle> {
  let requests = 0;
  const server: Server = createServer((_req, res) => {
    requests += 1;
    if (requests <= opts.failuresBeforeSuccess) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('simulated failure');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(opts.successBody);
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        requestCount: () => requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
