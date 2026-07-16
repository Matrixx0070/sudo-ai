/**
 * @file email-imap-worker.ts
 * @description Child-process IMAP RECEIVE worker.
 *
 * WHY A SEPARATE PROCESS: in the heavy main daemon, imapflow's streamed socket
 * reads starve — downloading a message body hangs forever (proven live: even a
 * single ~50-100KB fetchOne never completes, while a fresh standalone process
 * streams the same mailbox instantly; ruled out proxy/leak/throttle). Something
 * loaded in the daemon breaks imapflow's stream consumption. So IMAP receive runs
 * HERE, in a clean process (like the standalone scripts that always work), and
 * pumps each new message's RAW SOURCE to the parent (EmailAdapter) over IPC. The
 * parent does ALL business logic (allowlist / rule / quarantine / session /
 * dispatch) — this worker is a dumb, isolated IMAP fetch pump.
 *
 * Owns: connect, poll (search → fetchOne per message), uid baseline
 * (load/pin/advance/persist), mark \Seen. Reconnects on any error (fresh process
 * → no zombie). Spawned via fork(--import tsx) from email.ts.
 *
 * IPC to parent: { type:'mail', uid, source(base64) } per new message;
 * { type:'log', level, msg, extra } for logging via the daemon's logger.
 */
import { ImapFlow } from 'imapflow';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dataPath } from '../shared/paths.js';

const HOST = process.env['EMAIL_IMAP_HOST'] ?? 'imap.gmail.com';
const PORT = parseInt(process.env['EMAIL_IMAP_PORT'] ?? '993', 10);
const USER = process.env['EMAIL_IMAP_USER'] ?? '';
const PASS = process.env['EMAIL_IMAP_PASS'] ?? '';
const INTERVAL = Math.max(3000, Number(process.env['EMAIL_POLL_INTERVAL_MS'] ?? '15000'));
const BASELINE_FILE = dataPath('email', '_uid-baseline.json');

type LogLevel = 'info' | 'warn' | 'error' | 'debug';
function wlog(level: LogLevel, msg: string, extra?: unknown): void {
  try { process.send?.({ type: 'log', level, msg, extra: extra === undefined ? undefined : String(extra) }); } catch { /* parent gone */ }
}

function loadBaseline(): number | null {
  try {
    if (!existsSync(BASELINE_FILE)) return null;
    const o = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as Record<string, number>;
    return typeof o[USER] === 'number' && o[USER] > 0 ? o[USER] : null;
  } catch { return null; }
}
function saveBaseline(uid: number): void {
  try {
    const dir = dataPath('email');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    let o: Record<string, number> = {};
    if (existsSync(BASELINE_FILE)) { try { o = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as Record<string, number>; } catch { /* fresh */ } }
    o[USER] = uid;
    writeFileSync(BASELINE_FILE, JSON.stringify(o), { mode: 0o600 });
  } catch (e) { wlog('warn', 'baseline persist failed', e); }
}

let baseline = 1;
let pinned = false;
let stopping = false;
let imap: ImapFlow | null = null;

async function ensure(): Promise<ImapFlow> {
  if (imap?.usable) return imap;
  if (imap) { try { imap.close(); } catch { /* gone */ } imap = null; }
  const c = new ImapFlow({
    host: HOST, port: PORT, secure: PORT === 993, tls: { rejectUnauthorized: true },
    auth: { user: USER, pass: PASS }, logger: false, disableAutoIdle: true,
  });
  c.on('error', (e: Error) => wlog('warn', 'imap connection error', e));
  await c.connect();
  imap = c;
  return c;
}

async function poll(): Promise<void> {
  if (stopping) return;
  const c = await ensure();
  const box = await c.mailboxOpen('INBOX');
  if (!pinned) {
    const uidNext = typeof (box as { uidNext?: unknown }).uidNext === 'number' ? (box as { uidNext: number }).uidNext : null;
    let b = loadBaseline();
    if (b === null) { b = uidNext ?? 1; saveBaseline(b); }
    baseline = b; pinned = true;
    wlog('info', `baseline pinned at ${baseline} (uidNext=${uidNext})`);
  }
  const found = (await c.search({ seen: false, uid: `${baseline}:*` }, { uid: true })) || [];
  const uids = (found as number[]).filter((u) => u >= baseline).sort((a, b) => a - b);
  for (const uid of uids) {
    const m = await c.fetchOne(String(uid), { source: true, uid: true }, { uid: true });
    if (!m || !m.source) continue;
    try { process.send?.({ type: 'mail', uid, source: (m.source as Buffer).toString('base64') }); } catch { /* parent gone */ }
    try { await c.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }); } catch (e) { wlog('warn', `mark-seen failed uid ${uid}`, e); }
    if (uid + 1 > baseline) { baseline = uid + 1; saveBaseline(baseline); }
  }
}

async function loop(): Promise<void> {
  while (!stopping) {
    try { await poll(); }
    catch (e) { wlog('warn', 'poll failed — dropping connection, retry next tick', e); if (imap) { try { imap.close(); } catch { /* gone */ } imap = null; } }
    await new Promise((r) => setTimeout(r, INTERVAL));
  }
}

function shutdown(): void { stopping = true; if (imap) { try { imap.close(); } catch { /* gone */ } } process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('message', (m: unknown) => { if (m && typeof m === 'object' && (m as { type?: string }).type === 'stop') shutdown(); });

if (!USER || !PASS) { wlog('error', 'no IMAP credentials — worker exiting'); process.exit(1); }
wlog('info', `IMAP receive worker started (host=${HOST} port=${PORT} interval=${INTERVAL}ms)`);
void loop();
