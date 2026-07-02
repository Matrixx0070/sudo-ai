/**
 * Regression test for P0 #1 (SSRF tool-fetch routing).
 *
 * meta.tool-creator generates API-tool source that performs outbound HTTP.
 * That generated code must call the SSRF-guarded `toolFetch` AND import it,
 * or the emitted tool throws `ReferenceError: toolFetch is not defined` at
 * load time. A verifier caught exactly this gap during the routing slice.
 */

import { describe, it, expect } from 'vitest';
import { generateApiToolCode } from '../../src/core/tools/builtin/meta/tool-creator.js';

describe('tool-creator: generated API-tool code (SSRF guard)', () => {
  const code = generateApiToolCode(
    'my-api-tool',
    'Calls an example API.',
    'https://api.example.com',
    'POST',
    { Authorization: '$MY_API_KEY' },
    '',
  );

  it('calls the guarded toolFetch, not the raw global fetch', () => {
    expect(code).toContain('await toolFetch(');
    // No bare `fetch(` invocation should survive in the generated body.
    expect(code).not.toMatch(/[^A-Za-z]fetch\(/);
  });

  it('imports toolFetch from the security module (matches the custom/ dir depth)', () => {
    expect(code).toContain(
      "import { toolFetch } from '../../../security/guarded-fetch.js';",
    );
  });
});
