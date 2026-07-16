/**
 * @file gdrive/auth.ts
 * @description Auth client construction for both supported modes.
 *
 * Default: service account (headless, no consent-screen token expiry). The
 * key JSON lives OUTSIDE the repo at GOOGLE_APPLICATION_CREDENTIALS; it is
 * never read into logs or synced anywhere (prime directive: no secrets in
 * git/Drive). Tradeoffs are documented in docs/gdrive-setup.md.
 *
 * Alternate: OAuth loopback (never the deprecated oob flow). A minimal
 * loopback exchange is provided for portability; note that a consent screen
 * left in "Testing" expires refresh tokens after 7 days.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createServer } from 'node:http';
import { google } from 'googleapis';

// googleapis-common is not a direct dependency; derive the client type from
// the googleapis surface itself.
type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;
import type { GdriveConfig } from './types.js';
import { GdriveConfigError } from './config.js';

export const GDRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
];

type AuthClient = Parameters<typeof google.drive>[0] extends { auth?: infer A } ? A : never;

/** Build the auth client for the configured mode. */
export function createAuthClient(config: GdriveConfig): AuthClient {
  if (config.authMode === 'service_account') {
    return new google.auth.GoogleAuth({
      keyFile: config.credentialsPath,
      scopes: GDRIVE_SCOPES,
    }) as AuthClient;
  }
  return createOAuthClient(config) as AuthClient;
}

interface InstalledClientSecret {
  installed?: { client_id: string; client_secret: string };
  web?: { client_id: string; client_secret: string };
}

function readClientSecret(file: string): { clientId: string; clientSecret: string } {
  const parsed = JSON.parse(readFileSync(file, 'utf-8')) as InstalledClientSecret;
  const c = parsed.installed ?? parsed.web;
  if (!c?.client_id || !c.client_secret) {
    throw new GdriveConfigError(`OAuth client-secret file ${file} has no installed/web client`);
  }
  return { clientId: c.client_id, clientSecret: c.client_secret };
}

/** OAuth mode: client with tokens loaded from the token file (must exist). */
export function createOAuthClient(config: GdriveConfig): OAuth2Client {
  const { clientId, clientSecret } = readClientSecret(config.oauthClientFile!);
  const client = new google.auth.OAuth2(clientId, clientSecret, 'http://127.0.0.1');
  let tokens: Record<string, unknown>;
  try {
    tokens = JSON.parse(readFileSync(config.oauthTokenFile!, 'utf-8')) as Record<string, unknown>;
  } catch {
    throw new GdriveConfigError(
      `OAuth token file missing/unreadable: ${config.oauthTokenFile} — run the loopback flow ` +
        '(runOAuthLoopbackFlow) once on a machine with a browser',
    );
  }
  client.setCredentials(tokens);
  // Persist rotated refresh/access tokens so long-lived daemons survive.
  client.on('tokens', (t) => {
    try {
      const merged = { ...tokens, ...t };
      tokens = merged;
      writeFileSync(config.oauthTokenFile!, JSON.stringify(merged), { mode: 0o600 });
    } catch {
      /* best-effort persistence; next full flow re-creates the file */
    }
  });
  return client;
}

/**
 * One-time interactive loopback flow: starts a localhost listener on an
 * ephemeral port, prints the consent URL, exchanges the returned code, and
 * writes tokens to config.oauthTokenFile (0600). Returns the redirect URL the
 * user must authorize. Never uses the deprecated oob flow.
 */
export async function runOAuthLoopbackFlow(
  config: GdriveConfig,
  printUrl: (url: string) => void = (u) => console.log(`Authorize sudo-ai in your browser:\n${u}`),
  timeoutMs = 5 * 60 * 1000,
): Promise<void> {
  const { clientId, clientSecret } = readClientSecret(config.oauthClientFile!);
  // The token exchange must use the exact redirect_uri (including the
  // ephemeral port) that the consent URL carried, so the port-bound client is
  // captured alongside the code.
  const { code, client } = await new Promise<{ code: string; client: OAuth2Client }>(
    (resolve, reject) => {
      let boundClient: OAuth2Client | null = null;
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const c = url.searchParams.get('code');
        res.end(c ? 'sudo-ai authorized — you can close this tab.' : 'missing code');
        if (c && boundClient) {
          server.close();
          resolve({ code: c, client: boundClient });
        }
      });
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        boundClient = new google.auth.OAuth2(clientId, clientSecret, `http://127.0.0.1:${port}`);
        printUrl(
          boundClient.generateAuthUrl({
            access_type: 'offline',
            prompt: 'consent',
            scope: GDRIVE_SCOPES,
          }),
        );
      });
      const t = setTimeout(() => {
        server.close();
        reject(new GdriveConfigError('OAuth loopback flow timed out'));
      }, timeoutMs);
      (t as { unref?: () => void }).unref?.();
    },
  );
  const { tokens } = await client.getToken(code);
  mkdirSync(dirname(config.oauthTokenFile!), { recursive: true });
  writeFileSync(config.oauthTokenFile!, JSON.stringify(tokens), { mode: 0o600 });
}
