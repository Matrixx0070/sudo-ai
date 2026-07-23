/**
 * @file gemini-web-mint.test.ts
 * Deterministic unit tests for the pure gemini.google.com web-seat spine. No browser,
 * no network, no live cookies — fixtures mirror the reference protocol shapes.
 */
import { describe, it, expect } from 'vitest';
import {
  extractInitData,
  getNested,
  parseGeminiFrames,
  extractCandidates,
  buildStreamGenerateRequest,
  buildModelHeader,
  mintGeminiWebSession,
  GeminiAuthError,
  GEMINI_ENDPOINTS,
  type FetchLike,
} from '../../src/llm/gemini-web-mint.js';

// A minimal slice of the app HTML carrying the five init fields.
const APP_HTML = `window.WIZ_global_data = {"cfb2h":"boq_bard_20260723.01","SNlM0e":"AB_tok_XYZ123","FdrFJe":"-sid-42","TuX5cc":"en","qKIAYe":"push_9"};`;

describe('extractInitData', () => {
  it('scrapes SNlM0e/cfb2h/FdrFJe/TuX5cc/qKIAYe', () => {
    const d = extractInitData(APP_HTML);
    expect(d.accessToken).toBe('AB_tok_XYZ123');
    expect(d.buildLabel).toBe('boq_bard_20260723.01');
    expect(d.sessionId).toBe('-sid-42');
    expect(d.language).toBe('en');
    expect(d.pushId).toBe('push_9');
  });
  it('returns nulls when fields are absent', () => {
    const d = extractInitData('<html>no wiz data here</html>');
    expect(d.accessToken).toBeNull();
    expect(d.buildLabel).toBeNull();
  });
});

describe('getNested', () => {
  it('navigates arrays and returns fallback off-path', () => {
    const data = [null, ['CID', 'RID'], null, null, [['RCID', ['hi']]]];
    expect(getNested(data, [1, 0])).toBe('CID');
    expect(getNested(data, [4, 0, 1, 0])).toBe('hi');
    expect(getNested(data, [9, 9], 'def')).toBe('def');
  });
});

describe('parseGeminiFrames + extractCandidates', () => {
  // Build a valid length-prefixed frame the way the server frames streaming responses.
  function frameBody(innerObj: unknown): string {
    // A "part" whose [2] is the JSON string of the inner reply object.
    const part = [['wrb.fr', null, JSON.stringify(innerObj)]];
    const payload = JSON.stringify(part);
    return `)]}'\n${payload.length}\n${payload}\n`;
  }

  it('strips the response prefix and parses length-prefixed frames', () => {
    const inner = [null, ['CID', 'RID'], null, null, [['RCID', ['hello world']]]];
    const frames = parseGeminiFrames(frameBody(inner));
    expect(frames.length).toBe(1);
    // The flattened frame is the ["wrb.fr", null, "<inner json>"] part.
    expect(getNested(frames[0], [0])).toBe('wrb.fr');
  });

  it('extracts reply text + cid/rid/rcid from frames', () => {
    const inner = [null, ['CID', 'RID'], null, null, [['RCID', ['hello world']]]];
    const cands = extractCandidates(parseGeminiFrames(frameBody(inner)));
    expect(cands).toHaveLength(1);
    expect(cands[0]).toEqual({ cid: 'CID', rid: 'RID', rcid: 'RCID', text: 'hello world' });
  });

  it('falls back to whole-body JSON when unframed (array returned as-is, not flattened)', () => {
    const frames = parseGeminiFrames(JSON.stringify([['a'], ['b']]));
    expect(frames).toEqual([['a'], ['b']]);
  });
});

describe('buildStreamGenerateRequest', () => {
  it('builds the exact StreamGenerate shape deterministically', () => {
    const req = buildStreamGenerateRequest({
      prompt: 'hi there',
      accessToken: 'AB_tok_XYZ123',
      buildLabel: 'boq_x',
      sessionId: '-sid-42',
      language: 'en',
      reqId: 12345,
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    expect(req.url).toBe(GEMINI_ENDPOINTS.GENERATE);
    expect(req.params).toEqual({ hl: 'en', _reqid: '12345', rt: 'c', bl: 'boq_x', 'f.sid': '-sid-42' });
    expect(req.form.at).toBe('AB_tok_XYZ123');

    const outer = JSON.parse(req.form['f.req']);
    expect(outer[0]).toBeNull();
    const inner = JSON.parse(outer[1]);
    expect(inner).toHaveLength(69);
    expect(inner[0]).toEqual(['hi there', 0, null, null, null, null, 0]); // message_content
    expect(inner[1]).toEqual(['en']);
    expect(inner[7]).toBe(1); // streaming flag
    expect(inner[59]).toBe('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE'); // uppercased uuid
    expect(inner[68]).toBe(2);
    // uuid echoed in the request-id header
    expect(req.headers['x-goog-ext-525005358-jspb']).toBe('["AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",1]');
  });

  it('omits bl/f.sid params when not supplied', () => {
    const req = buildStreamGenerateRequest({ prompt: 'x', accessToken: 't', reqId: 1, uuid: 'u' });
    expect(req.params.bl).toBeUndefined();
    expect(req.params['f.sid']).toBeUndefined();
    expect(req.params._reqid).toBe('1');
  });
});

describe('buildModelHeader', () => {
  it('emits the model-selection header for a known model', () => {
    const h = buildModelHeader('gemini-3-flash');
    expect(h['x-goog-ext-525001261-jspb']).toContain('"fbb127bbb056c959"');
  });
});

describe('mintGeminiWebSession', () => {
  it('mints a session from cookies via injected fetch', async () => {
    const fetchImpl: FetchLike = async (url, init) => {
      expect(url).toBe(GEMINI_ENDPOINTS.INIT);
      expect(init?.headers?.Cookie).toContain('__Secure-1PSID=');
      return { status: 200, text: async () => APP_HTML };
    };
    const s = await mintGeminiWebSession('__Secure-1PSID=abc; __Secure-1PSIDTS=def', fetchImpl);
    expect(s.accessToken).toBe('AB_tok_XYZ123');
    expect(s.buildLabel).toBe('boq_bard_20260723.01');
    expect(s.cookieHeader).toContain('__Secure-1PSID=');
  });

  it('throws GeminiAuthError on non-200', async () => {
    const fetchImpl: FetchLike = async () => ({ status: 401, text: async () => '' });
    await expect(mintGeminiWebSession('c=1', fetchImpl)).rejects.toBeInstanceOf(GeminiAuthError);
  });

  it('throws GeminiAuthError when no SNlM0e present', async () => {
    const fetchImpl: FetchLike = async () => ({ status: 200, text: async () => '<html>logged out</html>' });
    await expect(mintGeminiWebSession('c=1', fetchImpl)).rejects.toBeInstanceOf(GeminiAuthError);
  });
});
