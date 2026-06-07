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

import { createReadStream, existsSync, statSync, readFileSync } from 'node:fs';
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
 * Build a strict, nonce-based CSP header for HTML pages. The per-request nonce
 * authorizes inline <script>/<style> tags (stamped into the served markup by
 * injectNonce); 'self' continues to cover external bundles and stylesheets.
 * No 'unsafe-inline' — inline content is permitted only via the matching nonce.
 * The nonce MUST be the first source token in script-src/style-src so a literal
 * `style-src 'nonce-…'` appears in the header.
 */
export function buildSpaCSPHeader(nonce: string): string {
  return [
    `default-src 'self'`,
    `script-src 'nonce-${nonce}' 'self'`,
    `style-src 'nonce-${nonce}' 'self'`,
    `img-src 'self' data: blob:`,
    `font-src 'self'`,
    `connect-src 'self' ws: wss: http://127.0.0.1:* ws://127.0.0.1:*`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `frame-ancestors 'none'`,
  ].join('; ');
}

/**
 * Stamp the CSP nonce onto inline <script>/<style> tags of an HTML document and
 * expose it via a <meta name="csp-nonce"> tag so runtime style/script injectors
 * (e.g. styled-components) can read it. Tags that already carry a nonce are left
 * untouched; external <script src>/<link rel=stylesheet> are covered by 'self'.
 */
function injectNonce(html: string, nonce: string): string {
  let out = html
    .replace(/<script(?![^>]*\bnonce=)/gi, `<script nonce="${nonce}"`)
    .replace(/<style(?![^>]*\bnonce=)/gi, `<style nonce="${nonce}"`);
  const meta = `<meta name="csp-nonce" content="${nonce}">`;
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, `<head$1>${meta}`);
  }
  return out;
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
    // Asset paths under each SPA — look in dist/renderer/admin/ or chat/
    const spaDir = pathname.startsWith('/v1/admin/dashboard') ? 'admin' : 'chat';
    const prefix = pathname.startsWith('/v1/admin/dashboard') ? '/v1/admin/dashboard' : '/chat';
    const relativePath = pathname.slice(prefix.length + 1);
    filePath = join(DIST_DIR, spaDir, relativePath);
  } else if (pathname.startsWith('/assets/')) {
    // Shared Vite build assets live in dist/renderer/assets/
    filePath = join(DIST_DIR, pathname);
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

  // HTML files: stamp a per-request CSP nonce into the document and serve the
  // rewritten markup. We can't stream raw bytes here because the inline tags are
  // rewritten to carry the nonce that the CSP header authorizes.
  if (ext === '.html') {
    const nonce = generateNonce();
    headers['Content-Security-Policy'] = buildSpaCSPHeader(nonce);
    if (res.headersSent) return true;
    const html = injectNonce(readFileSync(resolved, 'utf-8'), nonce);
    res.writeHead(200, headers);
    res.end(html);
    return true;
  }

  if (res.headersSent) return true;
  res.writeHead(200, headers);
  createReadStream(resolved).pipe(res);
  return true;
}
