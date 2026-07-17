/**
 * @file notebooklm/shapes-n1.ts
 * @description N1 broadcast shapes: F41 cockpit, F42 architecture explainer,
 * F52 research target. Registered into the shared registry via
 * registerN1Shapes(). F39 brain-radio (shapes.ts) gets real data wired in the
 * runtime ShapeContext. All obey the hard zone screen.
 */

import { screenRecords } from './zone-screen.js';
import { registerShape, type CompiledDoc, type ShapeSpec } from './shapes.js';

// F41 — zero-build cockpit: Configure-Chat string + live-fileId pointer card.
export const cockpitShape: ShapeSpec = {
  id: 'cockpit',
  featureIds: ['F41'],
  mode: 'rolling',
  folder: 'notebooklm/cockpit',
  cadence: 'weekly',
  async compile(ctx) {
    const docs = (await ctx.readSourceDocs?.()) ?? [];
    const body = [
      '## Configure Chat',
      'Paste this into the notebook\'s Configure/Customize prompt:',
      '```',
      'You are the inspection console for an autonomous agent; always cite which report and date; flag uncertainty explicitly.',
      '```',
      '',
      '## Add these Docs as sources',
      '(Live fileIds — add each to the "SUDO-AI Cockpit" notebook.)',
      ...(docs.length ? docs.map((d) => `- **${d.name}** — ${d.url ?? `id ${d.id}`}`) : ['- (no source Docs found yet)']),
    ].join('\n');
    return [{ name: 'chat-instruction', body }];
  },
};

// F42 — architecture explainer pack (repo docs → ≤8 Docs).
const ARCH_GROUPS: Array<{ name: string; files: string[] }> = [
  { name: 'roadmaps', files: ['docs/DRIVE_ROADMAP.md', 'docs/NOTEBOOKLM_ROADMAP.md'] },
  { name: 'status', files: ['docs/DRIVE_ROADMAP_STATUS.md', 'docs/NOTEBOOKLM_ROADMAP_STATUS.md'] },
  { name: 'setup', files: ['docs/gdrive-setup.md', 'docs/gdrive-apps-script.md'] },
  { name: 'rituals', files: ['docs/notebooklm-rituals.md'] },
];

export const architectureShape: ShapeSpec = {
  id: 'architecture',
  featureIds: ['F42'],
  mode: 'pack',
  folder: 'notebooklm/architecture',
  cadence: 'weekly',
  async compile(ctx) {
    const out: CompiledDoc[] = [];
    for (const grp of ARCH_GROUPS) {
      const contents = grp.files.map((f) => ctx.readFile?.(f)).filter((x): x is string => Boolean(x));
      if (!contents.length) continue;
      // Zone-2 screen every file (docs are public, but belt-and-braces).
      const { kept } = screenRecords(contents, (c) => c);
      if (kept.length) out.push({ name: `arch-${grp.name}`, body: kept.join('\n\n---\n\n') });
    }
    return out.slice(0, 8);
  },
};

// F52 — research target: the highest-ranked open question (G-F52RANK feeds it).
export const researchTargetShape: ShapeSpec = {
  id: 'research-target',
  featureIds: ['F52'],
  mode: 'rolling',
  folder: 'notebooklm/daily',
  cadence: 'nightly',
  async compile(ctx) {
    const questions = (await ctx.readOpenQuestions?.()) ?? [];
    const top = questions[0];
    const body = top
      ? [
          "## Tonight's research target",
          '(highest-ranked open question from the dream cycle)',
          '',
          `> ${top}`,
          '',
          'Run Deep Research on this in NotebookLM; save the briefing as',
          '`F52.research.<date>.md` into notebooklm/returns/ (→ external tier).',
        ].join('\n')
      : '## No open question tonight\n\nThe dream cycle produced no ranked open questions.';
    return [{ name: 'research-target', body }];
  },
};

let registered = false;
export function registerN1Shapes(): void {
  if (registered) return;
  registerShape(cockpitShape);
  registerShape(architectureShape);
  registerShape(researchTargetShape);
  registered = true;
}
