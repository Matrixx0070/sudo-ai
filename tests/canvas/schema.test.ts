/**
 * A2UI component schema validator (Spec 2). The security guarantee is that the
 * schema is CLOSED: unknown types and unknown fields are rejected, so no
 * markup/handler can be smuggled to the client (no XSS surface).
 */
import { describe, it, expect } from 'vitest';
import { validateCanvasPayload, CANVAS_SCHEMA_VERSION } from '../../src/core/canvas/schema.js';

describe('validateCanvasPayload — happy path', () => {
  it('accepts a chart + form in one payload and stamps the version', () => {
    const r = validateCanvasPayload({
      title: 'Dashboard',
      components: [
        { type: 'metric', label: 'Revenue', value: '$4.6M', delta: '+15%', trend: 'up' },
        { type: 'chart', chartType: 'bar', title: 'By region', series: [{ label: 'NA', value: 42 }, { label: 'EU', value: 30 }] },
        { type: 'form', title: 'Feedback', submitActionId: 'submit_fb', fields: [
          { name: 'rating', label: 'Rating', kind: 'select', options: ['1', '2', '3'], required: true },
          { name: 'note', label: 'Note', kind: 'textarea' },
        ] },
        { type: 'button', label: 'Refresh', actionId: 'refresh', style: 'primary' },
        { type: 'table', columns: ['a', 'b'], rows: [['1', '2'], ['3', '4']] },
        { type: 'progress', label: 'Upload', value: 60 },
        { type: 'list', ordered: true, items: ['one', 'two'] },
        { type: 'text', text: 'hello', variant: 'heading' },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.payload!.version).toBe(CANVAS_SCHEMA_VERSION);
    expect(r.payload!.components).toHaveLength(8);
  });
});

describe('validateCanvasPayload — rejects (closed schema / XSS-safe)', () => {
  it('rejects an unknown component type', () => {
    const r = validateCanvasPayload({ components: [{ type: 'iframe', src: 'x' }] });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/unknown\/missing type/);
  });

  it('rejects a smuggled disallowed field (e.g. onclick / html)', () => {
    const r = validateCanvasPayload({ components: [{ type: 'text', text: 'hi', onclick: 'alert(1)' }] });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/disallowed field "onclick"/);
  });

  it('rejects a smuggled html field on a button', () => {
    const r = validateCanvasPayload({ components: [{ type: 'button', label: 'x', actionId: 'a', html: '<img onerror=alert(1)>' }] });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/disallowed field "html"/);
  });

  it('rejects bad shapes per type', () => {
    expect(validateCanvasPayload({ components: [{ type: 'progress', value: 500 }] }).ok).toBe(false);
    expect(validateCanvasPayload({ components: [{ type: 'chart', chartType: 'donut', series: [] }] }).ok).toBe(false);
    expect(validateCanvasPayload({ components: [{ type: 'form', submitActionId: 's', fields: [] }] }).ok).toBe(false);
    expect(validateCanvasPayload({ components: [{ type: 'table', columns: ['a'], rows: [[1, 2]] }] }).ok).toBe(false);
  });

  it('rejects empty / oversized / malformed payloads', () => {
    expect(validateCanvasPayload({ components: [] }).ok).toBe(false);
    expect(validateCanvasPayload({ components: 'nope' }).ok).toBe(false);
    expect(validateCanvasPayload(null).ok).toBe(false);
    expect(validateCanvasPayload({ components: Array.from({ length: 51 }, () => ({ type: 'text', text: 'x' })) }).ok).toBe(false);
  });

  it('is all-or-nothing (one bad component fails the whole payload)', () => {
    const r = validateCanvasPayload({ components: [{ type: 'text', text: 'ok' }, { type: 'evil' }] });
    expect(r.ok).toBe(false);
    expect(r.payload).toBeUndefined();
  });
});
