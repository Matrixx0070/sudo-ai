/**
 * @file notebooklm/probe-route.ts
 * @description E2→E4 wiring. `F40/F50/F58.probe-answers.<setId>.md` returns are
 * the external reader's pasted answers. Instead of landing in memory, they route
 * to the E4 comparator: load the matching self run, judge the pairs with the
 * pinned INDEPENDENT judge (G-JUDGE), and publish a comparison report to
 * notebooklm/probes. The comparator holds for human review when no independent
 * judge exists. Content arriving here has ALREADY passed E2 quarantine.
 *
 * The judge brain is injected (setProbeJudge) exactly like the gdrive inspector,
 * so this module stays off the hot path and free of provider wiring.
 */

import { createLogger } from '../shared/logger.js';
import { registerReturnRoute } from './returns.js';
import {
  parseExternalAnswers,
  compareProbe,
  renderComparisonReport,
  type JudgeFn,
  type ProbeSet,
} from './probe.js';
import { loadSelfRun } from './probe-store.js';
import { HEADER_SENTENCE } from './export-lane.js';

const log = createLogger('notebooklm:probe-route');

/** Injected judge — must resolve to the pinned independent judge route. */
let judgeFn: JudgeFn | null = null;
export function setProbeJudge(fn: JudgeFn): void {
  judgeFn = fn;
}

/** Probe sets known to the route, keyed by set id (registered by the export job). */
const KNOWN_SETS = new Map<string, ProbeSet>();
export function registerProbeSet(set: ProbeSet): void {
  KNOWN_SETS.set(set.id, set);
}
export function knownProbeSet(id: string): ProbeSet | undefined {
  return KNOWN_SETS.get(id);
}

const PROBE_FEATURES = ['F40', 'F50', 'F58'];

let registered = false;
export function registerProbeRoutes(): void {
  if (registered) return;
  registered = true;
  for (const feature of PROBE_FEATURES) {
    registerReturnRoute(`${feature}:probe-answers`, async ({ parsed, content, deps }) => {
      const setId = parsed.date; // third filename segment carries the set id
      const set = KNOWN_SETS.get(setId);
      if (!set) {
        log.warn({ setId }, 'probe-answers for unknown set — cannot compare');
        return 'probe-unknown-set';
      }
      const selfRun = loadSelfRun(setId);
      if (!selfRun) {
        log.warn({ setId }, 'no self run recorded — cannot compare');
        return 'probe-no-self-run';
      }
      if (!judgeFn) {
        log.warn('no judge injected — holding probe for human review');
        return 'probe-no-judge';
      }
      const external = parseExternalAnswers(content, set.questions.map((q) => q.qid));
      const cmp = await compareProbe({ set, selfRun, externalAnswers: external, judge: judgeFn });
      const report = renderComparisonReport(set, cmp);
      const folder = deps.folders['notebooklm/probes'];
      if (folder) {
        const body = `> ${HEADER_SENTENCE}\n\n${report}`;
        await deps.client.filesCreate(
          { name: `comparison-${setId}.md`, parents: [folder], mimeType: 'text/markdown' },
          { mimeType: 'text/markdown', body },
        );
      }
      const label = cmp.held ? 'probe-held-for-human' : `probe-compared:${cmp.summary.divergent}div`;
      log.info({ setId, label }, 'E4 comparison published');
      return label;
    });
  }
}
