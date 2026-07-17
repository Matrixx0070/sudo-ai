/**
 * @file notebooklm/routes-n1.ts
 * @description N1 special return routes. F43 postmortems become dead-end
 * candidates (F33) instead of plain memories. F51/F52/F67 external-tier
 * forcing is handled by the runtime's forcedTier map, not a route. Content
 * arriving here has ALREADY passed quarantine (E2 guarantee).
 */

import { createLogger } from '../shared/logger.js';
import { registerReturnRoute } from './returns.js';

const log = createLogger('notebooklm:routes-n1');

let registered = false;
export function registerN1Routes(): void {
  if (registered) return;
  registered = true;

  // F43 — postmortem conclusions → dead-end candidate (F33).
  registerReturnRoute('F43', async ({ parsed, content }) => {
    const { draftDeadEnd } = await import('../gdrive/dead-ends.js');
    // Derive coarse pattern keys from the first line + any quoted tool names.
    const firstLine = content.split('\n').find((l) => l.trim()) ?? 'incident postmortem';
    const toolHits = [...content.matchAll(/\b([a-z]+\.[a-z-]+)\b/g)].map((m) => m[1]!).slice(0, 5);
    draftDeadEnd({
      summary: firstLine.slice(0, 300),
      patternKeys: toolHits.length ? toolHits : [parsed.type],
      context: `NotebookLM postmortem of incident ${parsed.date}`,
      cause: 'incident postmortem (F43)',
      evidenceRef: parsed.raw,
    });
    log.info({ file: parsed.raw, patternKeys: toolHits.length }, 'F43 postmortem → dead-end candidate');
    return 'dead-end-candidate';
  });

  // F54 — informed-approval attestation → validate token, grant/hold the gate.
  // Never lands in memory; the harness-enforced gate state lives on disk.
  // parsed.date carries the approval id (third filename segment).
  registerReturnRoute('F54:attestation', async ({ parsed, content }) => {
    const { recordAttestation } = await import('./informed-approval.js');
    const r = recordAttestation(parsed.date, content);
    log.info({ id: parsed.date, granted: r.granted, reason: r.reason }, 'F54 attestation processed');
    return r.granted ? 'approval-granted' : 'approval-held';
  });

  // F59 — reception transcript (already E2-quarantined) → reception report Doc
  // (zone-2 self-knowledge) + the derived analysis stored at EXTERNAL tier.
  registerReturnRoute('F59:reception', async ({ parsed, content, deps }) => {
    const { analyzeReception, renderReceptionReport } = await import('./reception.js');
    const { assertZone2 } = await import('./zone-screen.js');
    const { HEADER_SENTENCE } = await import('./export-lane.js');
    const report = analyzeReception(content);
    const body = `> ${HEADER_SENTENCE}\n\n${renderReceptionReport(parsed.date, report)}`;
    assertZone2(body); // the transcript is about zone-2 broadcasts; fail-closed anyway.
    const folder = deps.folders['notebooklm/reception'];
    if (folder) {
      await deps.client.filesCreate(
        { name: `reception-${parsed.date}.md`, parents: [folder], mimeType: 'text/markdown' },
        { mimeType: 'text/markdown', body },
      );
    }
    // Derived analysis → external tier (never over-trust text descended from
    // untrusted external audio). Quarantine already ran in the E2 sweep.
    await deps.structured.saveMemory({
      type: 'reference',
      id: `nlm-F59-reception-${parsed.date}`,
      name: `Reception report ${parsed.date}`,
      description: `reception · tier external · net sentiment ${report.sentiment.net}`,
      content: JSON.stringify({ featureId: 'F59', returnType: 'reception', trustTier: 'external', date: parsed.date, sentiment: report.sentiment, themes: report.themes.map((t) => t.theme) }),
    } as never);
    log.info({ date: parsed.date, net: report.sentiment.net, confusions: report.confusions.length }, 'F59 reception analysed');
    return 'reception-analyzed';
  });

  // F64 — successor ACK: validate the token bound to the sealed successor pack.
  // Never lands in memory; advances the harness-enforced succession gate.
  registerReturnRoute('F64:ack', async ({ content }) => {
    const { recordSuccessionAck } = await import('./succession.js');
    const r = recordSuccessionAck(content);
    log.info({ accepted: r.accepted, reason: r.reason }, 'F64 succession ack processed');
    return r.accepted ? 'succession-acked' : 'succession-ack-rejected';
  });
}

/** Feature ids whose returns are FORCED to external tier (no elevation). */
export const N1_FORCED_EXTERNAL: Record<string, 'external'> = {
  F51: 'external', // video briefs originate from third-party video
  F52: 'external', // deep-research briefs
  F67: 'external', // embassy (N4; set here so the map is complete)
};
