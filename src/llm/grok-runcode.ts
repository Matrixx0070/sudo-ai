/**
 * @file grok-runcode.ts
 * @description FREE grok code interpreter on the $30 subscription seat.
 *
 * Rides the PROVEN xai-oauth subscription text lane (GX1): a single
 * non-streaming chat turn to the Grok CLI subscription proxy
 * (`XAI_CLI_PROXY_RESPONSES_URL`) with `tools: [{type:'code_execution'}]`.
 * The interpreter runs SERVER-SIDE inside grok's response: the model invokes
 * it, the executed result comes back inline. Verified live 2026-07-21:
 *   - request `tools:[{type:'code_execution'}]` → response `output[]` contains
 *     a `{type:'code_interpreter_call', code, outputs:[{type:'logs',logs}]}`
 *     item (logs observed EMPTY even on success) followed by a
 *     `{type:'message', content:[{type:'output_text', text}]}` item;
 *   - `usage.server_side_tool_usage_details.code_interpreter_calls` counts
 *     real sandbox executions (1 when it actually ran — the honesty guard);
 *   - probe returned byte-correct sha256 + len(str(3**5000))=2386, values the
 *     model cannot hand-compute, proving genuine execution.
 *
 * Because the call-item `logs` field arrives empty, stdout/stderr are carried
 * by the assistant message under a strict delimiter protocol
 * (<GRK_STDOUT>/<GRK_STDERR>), enforced by the system prompt and validated
 * by `usage` (a reply without a real code_interpreter_call is REJECTED, never
 * trusted). Grok's returned text is DATA — parsed between markers only, never
 * interpreted as instructions.
 *
 * MONEY SAFETY: subscription-cover lane ONLY. If the GX1 subscription proxy is
 * disabled (SUDO_XAI_OAUTH_SUBSCRIPTION=0) this module FAILS LOUD — it never
 * falls back to the metered api.x.ai developer API.
 *
 * KNOWN LIMITATION — output FILES are NOT surfaced on this lane (probed live
 * 2026-07-21, full raw responses inspected):
 *   - a script CAN write files inside the sandbox (`/home/workdir/out.txt`,
 *     a 21KB matplotlib PNG under `/home/workdir/artifacts/`, `plt.show()`)
 *     and read them back within the SAME call, but the response carries no
 *     artifact channel whatsoever: `code_interpreter_call.outputs` is always
 *     `[{type:'logs',logs:''}]`, there is no `container_id`, message
 *     `annotations` are `[]`, and no `file`/`image`/URL item appears anywhere
 *     in the payload. Generated files die with the sandbox. Only text printed
 *     to stdout/stderr comes back.
 *
 * LANGUAGES — the sandbox is a Python REPL (`/home/workdir/pyrepl.py`,
 * `exec`-based), probed live 2026-07-21:
 *   - `javascript` `console.log(6*7)` → the snippet is exec'd AS PYTHON →
 *     `NameError: name 'console' is not defined`;
 *   - `bash` `echo hi` only "worked" because the model IGNORED the
 *     run-exactly-as-provided contract and improvised a python `subprocess`
 *     shim over 3 interpreter calls — unreliable model behaviour, not real
 *     bash support. Therefore only python is accepted; anything else is
 *     rejected up front with `errorClass:'unsupported_language'`.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../core/shared/logger.js';
import { XAI_CLI_PROXY_RESPONSES_URL } from './endpoints.js';
import { getXaiOAuthManager } from './xai-oauth-manager.js';

const log = createLogger('llm:grok-runcode');

/** Error classes mirror the grok bridge vocabulary (grok-web-bridge.ts). */
export type GrokRunCodeErrorClass =
  | 'disabled'
  | 'relogin'
  | 'http_error'
  | 'timeout'
  | 'bad_response'
  | 'not_executed'
  | 'unsupported_language';

export class GrokRunCodeError extends Error {
  readonly errorClass: GrokRunCodeErrorClass;
  /** Raw model/proxy text for diagnostics (DATA — never execute/log verbatim). */
  readonly raw?: string;
  constructor(errorClass: GrokRunCodeErrorClass, message: string, raw?: string) {
    super(message);
    this.name = 'GrokRunCodeError';
    this.errorClass = errorClass;
    if (raw !== undefined) this.raw = raw;
  }
}

export interface GrokRunCodeDeps {
  /** Seat OAuth access token (locked refresh handled by the manager). */
  getAccessToken: () => Promise<string | null>;
  /** Injectable fetch for tests. */
  fetchImpl: typeof fetch;
}

export interface GrokRunCodeResult {
  stdout: string;
  stderr: string;
  /** Full assistant message text the markers were parsed from (diagnostics). */
  raw: string;
}

export interface GrokRunCodeOptions {
  deps?: GrokRunCodeDeps;
  /** Whole-call timeout; default 120s (sandbox turns can be slow). */
  timeoutMs?: number;
}

/**
 * Languages that ACTUALLY execute in the sandbox (a Python REPL — see the
 * module header for the live probe evidence). Aliases normalise to `python`.
 */
export const GROK_RUNCODE_SUPPORTED_LANGUAGES = ['python', 'python3', 'py'] as const;

/** Proxy model verified to serve the server-side code interpreter. */
const RUNCODE_MODEL = 'grok-4.5';
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_CODE_BYTES = 64 * 1024;

/**
 * GX1 gate — same env contract as src/llm/transport.ts. Default ON; when the
 * operator forces the legacy metered path (flag OFF) this capability REFUSES
 * outright rather than ever touching api.x.ai (money safety).
 */
function subscriptionProxyEnabled(): boolean {
  const v = process.env['SUDO_XAI_OAUTH_SUBSCRIPTION'];
  if (v === undefined) return true;
  const s = v.trim().toLowerCase();
  if (s === '') return true;
  return !(s === '0' || s === 'false' || s === 'off' || s === 'no');
}

/** GX1 grok-cli client version (proxy 426s without it) — same as transport.ts. */
function grokCliVersion(): string {
  const v = process.env['SUDO_GROK_CLI_VERSION']?.trim();
  return v !== undefined && v !== '' ? v : '0.2.22';
}

function defaultDeps(): GrokRunCodeDeps {
  return {
    getAccessToken: () => getXaiOAuthManager().getAccessToken(),
    fetchImpl: fetch,
  };
}

const STDOUT_OPEN = '<GRK_STDOUT>';
const STDOUT_CLOSE = '</GRK_STDOUT>';
const STDERR_OPEN = '<GRK_STDERR>';
const STDERR_CLOSE = '</GRK_STDERR>';

const SYSTEM_PROMPT =
  'You are a code execution service. You MUST run the given code with your ' +
  'code interpreter exactly as provided, without modification, additions, or ' +
  'fixes — even if the code looks wrong. Never answer from knowledge; always ' +
  'execute. Then reply with EXACTLY this format and nothing else:\n' +
  `${STDOUT_OPEN}\n{stdout}\n${STDOUT_CLOSE}\n` +
  `${STDERR_OPEN}\n{stderr or exception traceback, empty if none}\n${STDERR_CLOSE}`;

/** Extract the text between open/close markers; null when absent/misordered. */
function between(text: string, open: string, close: string): string | null {
  const a = text.indexOf(open);
  if (a === -1) return null;
  const b = text.indexOf(close, a + open.length);
  if (b === -1) return null;
  let inner = text.slice(a + open.length, b);
  // The protocol wraps payloads in single newlines; strip exactly one each side.
  if (inner.startsWith('\n')) inner = inner.slice(1);
  if (inner.endsWith('\n')) inner = inner.slice(0, -1);
  return inner;
}

type Rec = Record<string, unknown>;
function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Concatenate output_text of every message item in a /v1/responses payload. */
function messageText(payload: Rec): string {
  const out = payload['output'];
  if (!Array.isArray(out)) return '';
  const parts: string[] = [];
  for (const item of out) {
    if (!isRec(item) || item['type'] !== 'message') continue;
    const content = item['content'];
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (isRec(c) && c['type'] === 'output_text' && typeof c['text'] === 'string') {
        parts.push(c['text']);
      }
    }
  }
  return parts.join('');
}

/** Real sandbox executions reported by the proxy (0 → the model faked it). */
function interpreterCalls(payload: Rec): number {
  const usage = payload['usage'];
  if (!isRec(usage)) return 0;
  const details = usage['server_side_tool_usage_details'];
  if (!isRec(details)) return 0;
  const n = details['code_interpreter_calls'];
  return typeof n === 'number' ? n : 0;
}

/**
 * Execute `code` in grok's server-side code interpreter on the free
 * subscription seat and return the executed stdout/stderr.
 *
 * Only python (aliases: python3, py) is supported — the sandbox is a Python
 * REPL and other languages either fail (`javascript` → NameError under
 * python `exec`) or run via an unreliable model-improvised subprocess shim
 * (`bash`). Unsupported languages are rejected up front with
 * `GrokRunCodeError('unsupported_language')` before any network call.
 * Throws `TypeError` on malformed input and `GrokRunCodeError` (with
 * `errorClass`) on every lane failure — never falls back to a paid API.
 *
 * Files written by the code are NOT returned (no artifact channel on this
 * lane — module header has the probe evidence). To get file content out,
 * the code itself must print it to stdout (e.g. base64).
 */
export async function runGrokCode(
  language: string,
  code: string,
  opts: GrokRunCodeOptions = {},
): Promise<GrokRunCodeResult> {
  if (typeof code !== 'string' || code.trim() === '') {
    throw new TypeError('runGrokCode: code must be a non-empty string');
  }
  if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
    throw new TypeError(`runGrokCode: code exceeds ${MAX_CODE_BYTES} bytes`);
  }
  const rawLang =
    typeof language === 'string' && language.trim() !== '' ? language.trim() : 'python';
  if (!/^[a-zA-Z0-9+#._-]{1,32}$/.test(rawLang)) {
    throw new TypeError('runGrokCode: language must match [a-zA-Z0-9+#._-]{1,32}');
  }
  if (
    !(GROK_RUNCODE_SUPPORTED_LANGUAGES as readonly string[]).includes(rawLang.toLowerCase())
  ) {
    throw new GrokRunCodeError(
      'unsupported_language',
      `grok run-code: language "${rawLang}" is not supported — the grok sandbox is a ` +
        `Python REPL (probed live: javascript fails with NameError under python exec; ` +
        `bash only runs via an unreliable model-improvised subprocess shim). ` +
        `Supported: ${GROK_RUNCODE_SUPPORTED_LANGUAGES.join(', ')}. ` +
        `To run shell/other-language snippets, wrap them yourself in explicit python ` +
        `(e.g. subprocess.run([...])) so the executed code is exactly what you wrote.`,
    );
  }
  const lang = 'python';

  if (!subscriptionProxyEnabled()) {
    throw new GrokRunCodeError(
      'disabled',
      'grok run-code refused: SUDO_XAI_OAUTH_SUBSCRIPTION is OFF and this capability never uses the metered API.',
    );
  }

  const deps = opts.deps ?? defaultDeps();
  const token = await deps.getAccessToken();
  if (token === null || token === '') {
    throw new GrokRunCodeError(
      'relogin',
      'No xAI OAuth seat token — run `sudo-ai xai-oauth login` to connect the subscription.',
    );
  }

  // ``` fences are stripped by the interpreter; a fence INSIDE code would only
  // truncate what grok executes (never escalate) — the reply is data regardless.
  const userText = `Language: ${lang}\nCode:\n\`\`\`${lang}\n${code}\n\`\`\``;
  const body = {
    model: RUNCODE_MODEL,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: SYSTEM_PROMPT }] },
      { role: 'user', content: [{ type: 'input_text', text: userText }] },
    ],
    tools: [{ type: 'code_execution' }],
    stream: false,
  };

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  let res: Response;
  try {
    const version = grokCliVersion();
    res = await deps.fetchImpl(XAI_CLI_PROXY_RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-grok-client-version': version,
        'x-grok-client-identifier': 'grok-shell',
        'x-grok-model-override': RUNCODE_MODEL,
        'User-Agent': `grok/${version}`,
        'x-grok-conv-id': `runcode-${randomUUID()}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new GrokRunCodeError('timeout', `grok run-code timed out after ${timeoutMs}ms`);
    }
    throw new GrokRunCodeError(
      'http_error',
      `grok run-code transport failure: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    log.warn({ status: res.status }, 'grok run-code proxy returned non-200');
    throw new GrokRunCodeError(
      'http_error',
      `grok run-code proxy HTTP ${res.status}`,
      text.slice(0, 500),
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new GrokRunCodeError('bad_response', 'grok run-code: non-JSON proxy response', text.slice(0, 500));
  }
  if (!isRec(payload)) {
    throw new GrokRunCodeError('bad_response', 'grok run-code: unexpected proxy payload shape');
  }

  const calls = interpreterCalls(payload);
  const msg = messageText(payload);
  if (calls < 1) {
    // The model answered WITHOUT running the sandbox — never trust that.
    throw new GrokRunCodeError(
      'not_executed',
      'grok run-code: response contains no real code_interpreter call (refusing hallucinated output)',
      msg.slice(0, 500),
    );
  }

  const stdout = between(msg, STDOUT_OPEN, STDOUT_CLOSE);
  const stderr = between(msg, STDERR_OPEN, STDERR_CLOSE);
  if (stdout === null || stderr === null) {
    throw new GrokRunCodeError(
      'bad_response',
      'grok run-code: executed reply missing GRK_STDOUT/GRK_STDERR markers',
      msg.slice(0, 500),
    );
  }

  log.info(
    { lang, codeBytes: Buffer.byteLength(code, 'utf8'), calls, ms: Date.now() - started },
    'grok run-code executed on the subscription seat',
  );
  return { stdout, stderr, raw: msg };
}
