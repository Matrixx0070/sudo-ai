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

/** Read a Doc's text — Google Docs export, falling back to raw download. */
async function readDocText(client: import('../gdrive/client.js').DriveClient, id: string): Promise<string> {
  try {
    return await client.filesExport(id, 'text/plain');
  } catch {
    return client.filesDownload(id);
  }
}

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

  // F67 — embassy inbound: foreign distillate. Held if it trips our watermark
  // canary (our own text bounced back → F19) or is a near-verbatim echo of what
  // we published; otherwise stored EXTERNAL-tier only. Already E2-quarantined.
  registerReturnRoute('F67', async ({ parsed, content, deps }) => {
    const { loadCanaryConfig, checkCanaryPayload, tripCanary } = await import('../gdrive/canary.js');
    const hit = checkCanaryPayload(content, loadCanaryConfig());
    if (hit) {
      tripCanary(deps.audit, hit, `embassy inbound ${parsed.raw}`);
      log.warn({ file: parsed.raw, label: hit.label }, 'F67 embassy inbound tripped a watermark canary — HELD');
      return 'embassy-canary-tripped';
    }
    const outFolder = deps.folders['notebooklm/embassy/outbound'];
    if (outFolder) {
      try {
        const { verbatimHeuristic } = await import('./embassy.js');
        const own: Array<{ name: string; body: string }> = [];
        for (const f of await deps.client.listChildren(outFolder)) {
          try { own.push({ name: f.name, body: await readDocText(deps.client, f.id) }); } catch { /* skip */ }
        }
        const v = verbatimHeuristic(content, own);
        if (v.isEcho) {
          log.warn({ file: parsed.raw, ratio: v.ratio, matched: v.matched }, 'F67 embassy inbound is a verbatim echo — HELD');
          return 'embassy-verbatim-held';
        }
      } catch { /* heuristic best-effort */ }
    }
    // Novel foreign distillate → external tier (F67 is forced-external anyway).
    for (const piece of content.slice(0, 8000).match(/[\s\S]{1,1500}/g) ?? []) {
      deps.chunks.storeChunk(piece, `nlm/F67/${parsed.type}`, 'learning', { role: 'user' });
    }
    await deps.structured.saveMemory({
      type: 'reference',
      id: `nlm-F67-${parsed.type}-${parsed.date}`,
      name: `Embassy distillate ${parsed.date}`,
      description: `embassy · tier external · returned ${parsed.date}`,
      content: JSON.stringify({ featureId: 'F67', returnType: parsed.type, trustTier: 'external', date: parsed.date }),
    } as never);
    log.info({ file: parsed.raw }, 'F67 embassy inbound stored (external tier)');
    return 'embassy-external';
  });

  // F60 — conversation with a past self: NotebookLM chats the forks museum;
  // the reflection returns here (already E2-quarantined) and is stored at
  // EXTERNAL tier (a past self's voice reconstructed by an external model —
  // never over-trusted, never executed as instructions).
  registerReturnRoute('F60:dialogue', async ({ parsed, content, deps }) => {
    for (const piece of content.slice(0, 8000).match(/[\s\S]{1,1500}/g) ?? []) {
      deps.chunks.storeChunk(piece, `nlm/F60/dialogue`, 'learning', { role: 'user' });
    }
    await deps.structured.saveMemory({
      type: 'reference',
      id: `nlm-F60-dialogue-${parsed.date}`,
      name: `Conversation with a past self ${parsed.date}`,
      description: `past-self dialogue · tier external · returned ${parsed.date}`,
      content: JSON.stringify({ featureId: 'F60', returnType: 'dialogue', trustTier: 'external', date: parsed.date }),
    } as never);
    log.info({ date: parsed.date }, 'F60 past-self dialogue ingested (external tier)');
    return 'past-self-dialogue';
  });

  // F65 — fork interview verdict: validate the packet-bound token + PASS/FAIL.
  // Never lands in memory; opens/holds the harness-enforced adoption gate.
  // parsed.date carries the fork name (third filename segment).
  registerReturnRoute('F65:interview', async ({ parsed, content }) => {
    const { recordForkInterview } = await import('./fork-interview.js');
    const r = recordForkInterview(parsed.date, content);
    log.info({ fork: parsed.date, phase: r.phase, reason: r.reason }, 'F65 interview verdict processed');
    return r.decided ? `interview-${r.phase}` : 'interview-pending';
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
