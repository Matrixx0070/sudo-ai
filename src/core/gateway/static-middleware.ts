/**
 * gateway/static-middleware.ts — Static file serving for React SPAs.
 *
 * Serves built React applications from dist/renderer/:
 *   /v1/admin/dashboard → dist/renderer/admin/index.html
 *   /chat               → dist/renderer/chat/index.html
 *   /v1/admin/dashboard/* → dist/renderer/admin/* (assets)
 *   /chat/*             → dist/renderer/chat/* (assets)
 *
 * Security: path traversal protection, kill-switches, MIME types.
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const DIST_DIR = resolve(process.cwd(), 'dist/renderer');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * Generate a random nonce for CSP (base64-encoded, 16 bytes = ~22 chars).
 */
function generateNonce(): string {
  return randomBytes(16).toString('base64');
}

/**
 * Build CSP header for HTML pages. Uses nonce for script/style, strict defaults.
 */
function buildCSPHeader(nonce: string): string {
  return [
    `default-src 'self'`,
    `script-src 'nonce-${nonce}' 'strict-dynamic'`,
    `style-src 'nonce-${nonce}'`,
    `img-src 'self' data: blob:`,
    `font-src 'self'`,
    `connect-src 'self' ws: wss: http://127.0.0.1:* ws://127.0.0.1:*`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `frame-ancestors 'none'`,
  ].join('; ');
}

/**
 * Serve static files from dist/renderer/.
 * @returns true if file was served, false to let other handlers try.
 */
export function serveStaticFile(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  // Kill-switch: disable static serving
  if (process.env['SUDO_NO_STATIC'] === '1') return false;

  // Legacy fallback: use old inline HTML
  if (pathname === '/v1/admin/dashboard' && process.env['SUDO_LEGACY_DASHBOARD'] === '1') return false;
  if (pathname === '/chat' && process.env['SUDO_LEGACY_CHAT'] === '1') return false;

  // Map SPA routes to their index.html
  let filePath: string;
  if (pathname === '/v1/admin/dashboard' || pathname === '/v1/admin/dashboard/') {
    filePath = join(DIST_DIR, 'admin/index.html');
  } else if (pathname === '/chat' || pathname === '/chat/') {
    filePath = join(DIST_DIR, 'chat/index.html');
  } else if (pathname.startsWith('/v1/admin/dashboard/') || pathname.startsWith('/chat/')) {
    // Asset paths — strip the SPA prefix to find files in dist/renderer/admin/ or chat/
    const prefix = pathname.startsWith('/v1/admin/dashboard') ? '/v1/admin/dashboard' : '/chat';
    const relativePath = pathname.slice(prefix.length + 1);
    filePath = join(DIST_DIR, relativePath);
  } else {
    return false;
  }

  // Path traversal protection
  const resolved = resolve(filePath);
  if (!resolved.startsWith(DIST_DIR)) {
    if (res.headersSent) return true;
    res.writeHead(403);
    res.end('Forbidden');
    return true;
  }

  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    return false;
  }

  const ext = extname(resolved);
  const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
  const isProduction = process.env['NODE_ENV'] === 'production';

  const headers: Record<string, string> = {
    'Content-Type': mimeType,
    'Cache-Control': isProduction ? 'public, max-age=31536000, immutable' : 'no-cache',
  };

  // Add CSP header for HTML files
  if (ext === '.html') {
    const nonce = generateNonce();
    headers['Content-Security-Policy'] = buildCSPHeader(nonce);
  }

  if (res.headersSent) return true;
  res.writeHead(200, headers);
  createReadStream(resolved).pipe(res);
  return true;
}
