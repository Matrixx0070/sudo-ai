/**
 * @file notebooklm/shapes.ts
 * @description The shape registry (E1). A shape declares how a slice of the
 * brain is compiled into NotebookLM-ready Doc(s). The export-lane engine
 * (export-lane.ts) runs a shape's `compile`, applies the hard zone screen, and
 * writes rolling Docs / packs. N0 ships the registry + one demo shape (F39
 * skeleton); N1+ register the real shapes.
 */

import { screenRecords } from './zone-screen.js';

/** Injected readers so shapes are testable without a live brain/memory. */
export interface ShapeContext {
  now: () => Date;
  /** Last N daily-report bodies (F3), newest first. */
  readReports?: (n: number) => Promise<string[]>;
  /** Current open-questions (F12 agenda). */
  readOpenQuestions?: () => Promise<string[]>;
  /** Notable recent audit lines. */
  readAuditNotes?: (n: number) => Promise<string[]>;
  /** Memory chunk reader for corpus shapes. */
  readChunks?: (query: string, limit: number) => Promise<Array<{ text: string; path: string }>>;
  /** Repo/text file reader for architecture shapes. */
  readFile?: (path: string) => string | null;
  /** Live source Docs to point a notebook at (F41 cockpit pointer card). */
  readSourceDocs?: () => Promise<Array<{ name: string; id: string; url?: string }>>;
  /** Past-self fork catalog (F60 forks museum). */
  readForks?: () => Promise<Array<{ name: string; brainId: string; counter: number; createdAt: string; policyNote: string; entryCount: number }>>;
}

export interface CompiledDoc {
  /** Doc name within the shape's folder (no extension). */
  name: string;
  /** Markdown body WITHOUT the standard header (engine prepends it). */
  body: string;
}

export type ShapeMode = 'rolling' | 'pack';

export interface ShapeSpec {
  id: string;
  featureIds: string[];
  mode: ShapeMode;
  /** notebooklm folder key (e.g. 'notebooklm/daily'). */
  folder: string;
  /** Rolling: chars before rolling to -part2. Pack: max chars per Doc. */
  sizeBudgetChars?: number;
  /** Human-readable cadence label (for the ritual manifest). */
  cadence: string;
  /** Compile sources → Doc(s). MUST screen its own records via screenRecords. */
  compile: (ctx: ShapeContext) => Promise<CompiledDoc[]>;
}

// ---------------------------------------------------------------------------
// Demo shape — F39 Brain Radio skeleton (real data wiring lands in N1)
// ---------------------------------------------------------------------------

export const brainRadioShape: ShapeSpec = {
  id: 'brain-radio',
  featureIds: ['F39'],
  mode: 'rolling',
  folder: 'notebooklm/daily',
  cadence: 'nightly',
  async compile(ctx) {
    const reports = (await ctx.readReports?.(14)) ?? [];
    const questions = (await ctx.readOpenQuestions?.()) ?? [];
    const audit = (await ctx.readAuditNotes?.(20)) ?? [];

    // Screen every source fragment to zone-2 before it can be assembled.
    const reportScreen = screenRecords(reports, (r) => r);
    const questionScreen = screenRecords(questions, (q) => q);
    const auditScreen = screenRecords(audit, (a) => a);

    const parts: string[] = [
      '## Last 14 self-reports (condensed)',
      ...reportScreen.kept.map((r) => `- ${r.split('\n')[0] ?? ''}`),
      '',
      '## Current open questions',
      ...(questionScreen.kept.length ? questionScreen.kept.map((q) => `- ${q}`) : ['- (none)']),
      '',
      '## Notable audit events',
      ...(auditScreen.kept.length ? auditScreen.kept.map((a) => `- ${a}`) : ['- (none)']),
    ];
    const droppedTotal = reportScreen.dropped.length + questionScreen.dropped.length + auditScreen.dropped.length;
    if (droppedTotal > 0) parts.push('', `_(${droppedTotal} source fragment(s) withheld by the zone screen.)_`);

    return [{ name: 'brain-radio', body: parts.join('\n') }];
  },
};

/** Registry — N1+ push more shapes here (or register via registerShape). */
const REGISTRY = new Map<string, ShapeSpec>([[brainRadioShape.id, brainRadioShape]]);

export function registerShape(shape: ShapeSpec): void {
  REGISTRY.set(shape.id, shape);
}

export function getShape(id: string): ShapeSpec | undefined {
  return REGISTRY.get(id);
}

export function allShapes(): ShapeSpec[] {
  return [...REGISTRY.values()];
}
