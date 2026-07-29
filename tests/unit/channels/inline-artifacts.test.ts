/**
 * TX4 — inline-artifacts pure decision logic tests.
 */
import { describe, expect, it } from 'vitest';
import {
  buildArtifactCaption,
  hasFoldableData,
  MAX_INLINE_ARTIFACTS,
  MAX_INLINE_ARTIFACT_BYTES,
  planInlineArtifacts,
  titleFromFilename,
  type ArtifactCandidate,
} from '../../../src/core/channels/inline-artifacts.js';

const img = (path: string, bytes = 1024, filename?: string): ArtifactCandidate => ({
  path,
  type: 'image',
  filename: filename ?? path.split('/').pop(),
  bytes,
});

describe('titleFromFilename', () => {
  it('prettifies stems and strips timestamps/hashes', () => {
    expect(titleFromFilename('revenue-by-quarter-2026-07-29.png')).toBe('revenue by quarter');
    expect(titleFromFilename('chart_output-a1b2c3d4e5.png')).toBe('chart output');
    expect(titleFromFilename('/tmp/deep/sales_summary.pdf')).toBe('sales summary');
  });

  it('never returns empty', () => {
    expect(titleFromFilename('2026-07-29.png').length).toBeGreaterThan(0);
  });
});

describe('buildArtifactCaption', () => {
  it('prefers a reply line mentioning the filename stem', () => {
    const reply = 'Here you go.\nThe chart **quarterly-revenue.png** shows Q3 leading.\nMore text.';
    const cap = buildArtifactCaption(img('/tmp/quarterly-revenue.png'), reply);
    expect(cap).toContain('quarterly-revenue.png');
    expect(cap).not.toContain('**'); // md stripped
  });

  it('falls back to the first markdown heading', () => {
    const cap = buildArtifactCaption(img('/tmp/x1.png'), '## Revenue Analysis\n\nDetails follow.');
    expect(cap).toBe('Revenue Analysis');
  });

  it('falls back to the prettified filename when reply gives no context', () => {
    expect(buildArtifactCaption(img('/tmp/user_growth_chart.png'), 'done')).toBe('user growth chart');
  });

  it('caps caption length under Telegram limits', () => {
    const longLine = `about big-table.png ${'x'.repeat(3000)}`;
    const cap = buildArtifactCaption(img('/tmp/big-table.png'), `# ${longLine}`);
    expect(cap.length).toBeLessThanOrEqual(1024);
  });
});

describe('hasFoldableData', () => {
  const pad = 'prose '.repeat(150); // pushes body past the 720-char gate
  it('detects markdown tables in long bodies', () => {
    const table = '| a | b |\n|---|---|\n| 1 | 2 |\n';
    expect(hasFoldableData(`${pad}\n${table}`)).toBe(true);
  });

  it('detects large fenced blocks', () => {
    const fence = '```json\n' + '{"row": 1}\n'.repeat(60) + '```';
    expect(hasFoldableData(`${pad}\n${fence}`)).toBe(true);
  });

  it('ignores short bodies (collapse would not engage)', () => {
    expect(hasFoldableData('| a | b |\n|---|---|\n| 1 | 2 |')).toBe(false);
  });

  it('ignores long prose without data blocks or with tiny fences', () => {
    expect(hasFoldableData(pad)).toBe(false);
    expect(hasFoldableData(`${pad}\n\`\`\`\nok\n\`\`\``)).toBe(false);
  });
});

describe('planInlineArtifacts', () => {
  it('captions eligible artifacts and preserves order', () => {
    const plan = planInlineArtifacts([img('/tmp/a.png'), img('/tmp/b.png')], 'done');
    expect([...plan.captions.keys()]).toEqual(['/tmp/a.png', '/tmp/b.png']);
  });

  it('caps at MAX_INLINE_ARTIFACTS per turn', () => {
    const atts = Array.from({ length: 6 }, (_, i) => img(`/tmp/${i}.png`));
    const plan = planInlineArtifacts(atts, 'done');
    expect(plan.captions.size).toBe(MAX_INLINE_ARTIFACTS);
    expect(plan.captions.has('/tmp/0.png')).toBe(true);
    expect(plan.captions.has('/tmp/3.png')).toBe(false);
  });

  it('skips oversized and size-unknown artifacts (they still ship plain)', () => {
    const plan = planInlineArtifacts(
      [
        img('/tmp/huge.png', MAX_INLINE_ARTIFACT_BYTES + 1),
        { path: '/tmp/nosize.png', type: 'image' },
        img('/tmp/ok.png'),
      ],
      'done',
    );
    expect([...plan.captions.keys()]).toEqual(['/tmp/ok.png']);
  });

  it('deduplicates repeated paths', () => {
    const plan = planInlineArtifacts([img('/tmp/a.png'), img('/tmp/a.png')], 'done');
    expect(plan.captions.size).toBe(1);
  });

  it('folds data only when at least one artifact is selected AND reply has data', () => {
    const pad = 'prose '.repeat(150);
    const table = `${pad}\n| a | b |\n|---|---|\n| 1 | 2 |\n`;
    expect(planInlineArtifacts([img('/tmp/a.png')], table).foldData).toBe(true);
    expect(planInlineArtifacts([], table).foldData).toBe(false);
    expect(planInlineArtifacts([img('/tmp/a.png')], 'short').foldData).toBe(false);
  });

  it('returns an empty plan for no attachments', () => {
    const plan = planInlineArtifacts([], 'anything');
    expect(plan.captions.size).toBe(0);
    expect(plan.foldData).toBe(false);
  });
});
