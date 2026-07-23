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
  extractMedia,
  extractDeepResearchPlan,
  extractDeepResearchPlanFromFrames,
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

describe('extractMedia', () => {
  // Build a candidate carrying a generated image, a generated video, and audio at the
  // exact reference indices, then frame it like the server does.
  function mediaFrameBody(): string {
    const genImg: unknown[] = [];
    genImg[0] = []; (genImg[0] as unknown[])[3] = [];
    ((genImg[0] as unknown[])[3] as unknown[])[2] = 'a red circle'; // alt
    ((genImg[0] as unknown[])[3] as unknown[])[3] = 'http://img/red.png'; // url
    genImg[1] = ['IMG1']; // imageId at [1][0]

    const vinfo: unknown[] = [];
    vinfo[0] = []; (vinfo[0] as unknown[])[7] = ['http://vid/thumb.jpg', 'http://vid/clip.mp4'];

    const md: unknown[] = [];
    md[0] = []; (md[0] as unknown[])[1] = []; ((md[0] as unknown[])[1] as unknown[])[7] = ['mp3t', 'http://a/song.mp3'];
    md[1] = []; (md[1] as unknown[])[1] = []; ((md[1] as unknown[])[1] as unknown[])[7] = ['mp4t', 'http://a/song.mp4'];

    const cand12: unknown[] = [];
    cand12[7] = [[genImg]]; // [12][7][0] = [genImg]
    cand12[59] = [[[vinfo]]]; // [12][59][0][0][0] = vinfo
    cand12[86] = md; // [12][86]

    const cand: unknown[] = ['RCID', ['here is your image']];
    cand[12] = cand12;

    const inner = [null, ['CID', 'RID'], null, null, [cand]];
    const part = [['wrb.fr', null, JSON.stringify(inner)]];
    const payload = JSON.stringify(part);
    return `)]}'\n${payload.length}\n${payload}\n`;
  }

  it('pulls generated image / video / audio at the reference indices', () => {
    const media = extractMedia(parseGeminiFrames(mediaFrameBody()));
    expect(media).toHaveLength(1);
    const m = media[0];
    expect(m.cid).toBe('CID');
    expect(m.rcid).toBe('RCID');
    expect(m.generatedImages).toEqual([{ url: 'http://img/red.png', alt: 'a red circle', imageId: 'IMG1' }]);
    expect(m.generatedVideos).toEqual([{ url: 'http://vid/clip.mp4', thumbnail: 'http://vid/thumb.jpg' }]);
    expect(m.generatedMedia).toEqual([
      { url: 'http://a/song.mp4', thumbnail: 'mp4t', mp3Url: 'http://a/song.mp3', mp3Thumbnail: 'mp3t' },
    ]);
  });

  it('returns nothing for a text-only candidate', () => {
    const inner = [null, ['CID', 'RID'], null, null, [['RCID', ['just text']]]];
    const part = [['wrb.fr', null, JSON.stringify(inner)]];
    const payload = JSON.stringify(part);
    const body = `)]}'\n${payload.length}\n${payload}\n`;
    expect(extractMedia(parseGeminiFrames(body))).toEqual([]);
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

describe('extractDeepResearchPlan', () => {
  function planCandidate(): unknown[] {
    const payload = [
      'History of the Printing Press', // [0] title
      [
        [null, 'Step 1', 'survey origins'], // [1][0] -> query at [1][0][2]
        [null, 'Step 2', 'trace spread'],
      ],
      'about 5 minutes', // [2] eta
      ['Start this research?'], // [3][0] confirmPrompt
      ['http://confirm.example'], // [4][0] confirmationUrl
      ['You can modify the plan'], // [5] modifyPrompt (first string)
    ];
    const cand: unknown[] = ['RCID', ['plan intro text']];
    cand[12] = { '56': payload, '70': 3 };
    cand[13] = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; // research id (uuid-shaped)
    return cand;
  }

  it('parses title/query/steps/eta/confirm/url/modify/rawState/researchId', () => {
    const plan = extractDeepResearchPlan(planCandidate());
    expect(plan).not.toBeNull();
    expect(plan!.title).toBe('History of the Printing Press');
    expect(plan!.query).toBe('survey origins');
    expect(plan!.steps).toEqual(['Step 1: survey origins', 'Step 2: trace spread']);
    expect(plan!.etaText).toBe('about 5 minutes');
    expect(plan!.confirmPrompt).toBe('Start this research?');
    expect(plan!.confirmationUrl).toBe('http://confirm.example');
    expect(plan!.modifyPrompt).toBe('You can modify the plan');
    expect(plan!.rawState).toBe(3);
    expect(plan!.researchId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it('returns null for a candidate with no plan block', () => {
    expect(extractDeepResearchPlan(['RCID', ['just a normal reply']])).toBeNull();
  });

  it('finds the plan across framed response', () => {
    const inner = [null, ['CID', 'RID'], null, null, [planCandidate()]];
    const part = [['wrb.fr', null, JSON.stringify(inner)]];
    const payload = JSON.stringify(part);
    const frames = parseGeminiFrames(`)]}'\n${payload.length}\n${payload}\n`);
    expect(extractDeepResearchPlanFromFrames(frames)?.title).toBe('History of the Printing Press');
  });
});

describe('buildStreamGenerateRequest deep research', () => {
  it('sets the DR inner fields when deepResearch is true', () => {
    const req = buildStreamGenerateRequest({
      prompt: 'research X',
      accessToken: 't',
      reqId: 1,
      uuid: 'u',
      deepResearch: true,
      drToken: 'TOK',
      drUuid: 'DRUUID',
    });
    const inner = JSON.parse(JSON.parse(req.form['f.req'])[1]);
    expect(inner[3]).toBe('!TOK');
    expect(inner[4]).toBe('DRUUID');
    expect(inner[49]).toBe(1);
    expect(inner[54]).toEqual([[[[[1]]]]]);
    expect(inner[55]).toEqual([[1]]);
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
