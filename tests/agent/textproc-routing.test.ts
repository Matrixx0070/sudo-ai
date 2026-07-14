/**
 * textproc router reachability (Spec 10 / PR-6, acceptance A5).
 *
 * Locks the 6 natural-language probes to the textproc category — the
 * "registered ≠ reachable" regression guard (#641/#678/#743 class). If a
 * future keyword edit drops one of these, CI fails here, not in production.
 */

import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/core/tools/registry.js';
import { registerTextprocTools } from '../../src/core/tools/builtin/textproc/index.js';
import { ToolRouter } from '../../src/core/agent/tool-router.js';

const PROBES = [
  'pull the rows where status=500 from this csv',
  'replace foo with bar across the src files',
  'how many unique IPs are in this log file',
  'give me lines 100000 to 100050 of that file',
  'convert this yaml config to json',
  'diff these two files nicely',
];

describe('textproc routing reachability (A5)', () => {
  it('routes all 6 natural-language probes to at least one textproc tool', async () => {
    const reg = new ToolRegistry();
    await registerTextprocTools(reg);
    reg.register({
      name: 'system.exec', description: 'run shell', category: 'system',
      parameters: {}, async execute() { return { success: true, output: '' }; },
    });
    const router = new ToolRouter(reg);

    const misses: string[] = [];
    for (const p of PROBES) {
      const names = router.route(p).map((s) => s.function.name);
      if (!names.some((n) => n.startsWith('textproc.'))) misses.push(p);
    }
    expect(misses, `these probes did not route textproc: ${misses.join(' | ')}`).toEqual([]);
  });
});
