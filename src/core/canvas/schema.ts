/**
 * @file schema.ts
 * @description Closed component schema for Generative UI / A2UI (Spec 2). The
 * agent emits a component TREE; the client renders it natively. Security rests
 * on this being a CLOSED set validated server-side: unknown component types AND
 * unknown fields are rejected, and every string is plain text the client MUST
 * render as textContent (never innerHTML) — so there is no HTML/script passthrough
 * and thus no XSS surface, by construction.
 *
 * Versioned: the client checks `version` and refuses a payload it can't render.
 */

export const CANVAS_SCHEMA_VERSION = 1;

/** The closed set of renderable component types. Adding one is a deliberate, versioned change. */
export const CANVAS_COMPONENT_TYPES = [
  'text', 'metric', 'chart', 'table', 'form', 'button', 'progress', 'list',
] as const;
export type CanvasComponentType = (typeof CANVAS_COMPONENT_TYPES)[number];

// --- Leaf/field shapes (all strings are PLAIN TEXT — no markup) ---------------

export interface TextComponent { type: 'text'; text: string; variant?: 'body' | 'heading' | 'caption' }
export interface MetricComponent { type: 'metric'; label: string; value: string; delta?: string; trend?: 'up' | 'down' | 'flat' }
export interface ChartComponent {
  type: 'chart';
  chartType: 'bar' | 'line' | 'pie';
  title?: string;
  series: Array<{ label: string; value: number }>;
}
export interface TableComponent { type: 'table'; columns: string[]; rows: string[][] }
export interface ProgressComponent { type: 'progress'; label?: string; value: number /* 0..100 */ }
export interface ListComponent { type: 'list'; ordered?: boolean; items: string[] }
/** A button emits a typed action back to the agent (no URLs/JS — just an actionId + optional payload). */
export interface ButtonComponent { type: 'button'; label: string; actionId: string; style?: 'primary' | 'secondary' | 'danger' }
/** A form: a set of typed fields + a submit actionId. Submitting posts {actionId, values} back. */
export interface FormField {
  name: string;
  label: string;
  kind: 'text' | 'number' | 'select' | 'checkbox' | 'textarea';
  required?: boolean;
  placeholder?: string;
  options?: string[]; // for select
}
export interface FormComponent { type: 'form'; title?: string; fields: FormField[]; submitActionId: string; submitLabel?: string }

export type CanvasComponent =
  | TextComponent | MetricComponent | ChartComponent | TableComponent
  | ProgressComponent | ListComponent | ButtonComponent | FormComponent;

/** A full render payload for one session/target. */
export interface CanvasPayload {
  version: number;
  /** Optional title for the panel. */
  title?: string;
  components: CanvasComponent[];
}

// --- Limits (defense against oversized/abusive payloads) ----------------------

const MAX_COMPONENTS = 50;
const MAX_STR = 2000;
const MAX_ARRAY = 200;

export interface ValidationResult {
  ok: boolean;
  payload?: CanvasPayload;
  errors: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function str(v: unknown): v is string { return typeof v === 'string' && v.length <= MAX_STR; }
function strArr(v: unknown): v is string[] {
  return Array.isArray(v) && v.length <= MAX_ARRAY && v.every((x) => str(x));
}

/**
 * Allowed field names per component type. A component with ANY key outside its
 * allowlist is rejected — this is what makes the schema truly closed (no way to
 * smuggle an `onclick`/`href`/`dangerouslySetInnerHTML`-style field through).
 */
const ALLOWED_FIELDS: Record<CanvasComponentType, ReadonlySet<string>> = {
  text: new Set(['type', 'text', 'variant']),
  metric: new Set(['type', 'label', 'value', 'delta', 'trend']),
  chart: new Set(['type', 'chartType', 'title', 'series']),
  table: new Set(['type', 'columns', 'rows']),
  form: new Set(['type', 'title', 'fields', 'submitActionId', 'submitLabel']),
  button: new Set(['type', 'label', 'actionId', 'style']),
  progress: new Set(['type', 'label', 'value']),
  list: new Set(['type', 'ordered', 'items']),
};

const FIELD_KINDS = new Set(['text', 'number', 'select', 'checkbox', 'textarea']);

function validateComponent(c: unknown, i: number, errors: string[]): CanvasComponent | null {
  if (!isPlainObject(c)) { errors.push(`component[${i}] not an object`); return null; }
  const type = c['type'];
  if (typeof type !== 'string' || !(CANVAS_COMPONENT_TYPES as readonly string[]).includes(type)) {
    errors.push(`component[${i}] unknown/missing type "${String(type)}"`);
    return null;
  }
  const t = type as CanvasComponentType;
  // Closed: reject any field not in the allowlist for this type.
  for (const k of Object.keys(c)) {
    if (!ALLOWED_FIELDS[t].has(k)) { errors.push(`component[${i}] (${t}) has disallowed field "${k}"`); return null; }
  }
  const bad = (m: string) => { errors.push(`component[${i}] (${t}): ${m}`); return null; };

  switch (t) {
    case 'text':
      if (!str(c['text'])) return bad('text required (string)');
      if (c['variant'] !== undefined && !['body', 'heading', 'caption'].includes(c['variant'] as string)) return bad('bad variant');
      return c as unknown as TextComponent;
    case 'metric':
      if (!str(c['label']) || !str(c['value'])) return bad('label+value required');
      if (c['delta'] !== undefined && !str(c['delta'])) return bad('bad delta');
      if (c['trend'] !== undefined && !['up', 'down', 'flat'].includes(c['trend'] as string)) return bad('bad trend');
      return c as unknown as MetricComponent;
    case 'chart': {
      if (!['bar', 'line', 'pie'].includes(c['chartType'] as string)) return bad('bad chartType');
      if (c['title'] !== undefined && !str(c['title'])) return bad('bad title');
      const s = c['series'];
      if (!Array.isArray(s) || s.length > MAX_ARRAY || !s.every((p) => isPlainObject(p) && str(p['label']) && typeof p['value'] === 'number' && Number.isFinite(p['value']) && Object.keys(p).every((k) => k === 'label' || k === 'value'))) return bad('bad series');
      return c as unknown as ChartComponent;
    }
    case 'table': {
      if (!strArr(c['columns'])) return bad('bad columns');
      const rows = c['rows'];
      if (!Array.isArray(rows) || rows.length > MAX_ARRAY || !rows.every((r) => strArr(r))) return bad('bad rows');
      return c as unknown as TableComponent;
    }
    case 'progress':
      if (typeof c['value'] !== 'number' || !Number.isFinite(c['value']) || (c['value'] as number) < 0 || (c['value'] as number) > 100) return bad('value must be 0..100');
      if (c['label'] !== undefined && !str(c['label'])) return bad('bad label');
      return c as unknown as ProgressComponent;
    case 'list':
      if (!strArr(c['items'])) return bad('bad items');
      if (c['ordered'] !== undefined && typeof c['ordered'] !== 'boolean') return bad('bad ordered');
      return c as unknown as ListComponent;
    case 'button':
      if (!str(c['label']) || !str(c['actionId'])) return bad('label+actionId required');
      if (c['style'] !== undefined && !['primary', 'secondary', 'danger'].includes(c['style'] as string)) return bad('bad style');
      return c as unknown as ButtonComponent;
    case 'form': {
      if (!str(c['submitActionId'])) return bad('submitActionId required');
      if (c['title'] !== undefined && !str(c['title'])) return bad('bad title');
      if (c['submitLabel'] !== undefined && !str(c['submitLabel'])) return bad('bad submitLabel');
      const fields = c['fields'];
      if (!Array.isArray(fields) || fields.length === 0 || fields.length > MAX_ARRAY) return bad('fields required');
      for (const f of fields) {
        if (!isPlainObject(f)) return bad('bad field');
        for (const k of Object.keys(f)) if (!['name', 'label', 'kind', 'required', 'placeholder', 'options'].includes(k)) return bad(`field disallowed key ${k}`);
        if (!str(f['name']) || !str(f['label']) || !FIELD_KINDS.has(f['kind'] as string)) return bad('bad field shape');
        if (f['options'] !== undefined && !strArr(f['options'])) return bad('bad field options');
        if (f['required'] !== undefined && typeof f['required'] !== 'boolean') return bad('bad field required');
        if (f['placeholder'] !== undefined && !str(f['placeholder'])) return bad('bad field placeholder');
      }
      return c as unknown as FormComponent;
    }
  }
}

/**
 * Validate a raw render payload. Returns ok:false with reasons on any violation
 * (unknown type, disallowed field, oversized, bad shape) — never throws, never
 * partially accepts. A valid result is safe to render with textContent only.
 */
export function validateCanvasPayload(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isPlainObject(input)) return { ok: false, errors: ['payload not an object'] };
  const comps = input['components'];
  if (!Array.isArray(comps)) return { ok: false, errors: ['components must be an array'] };
  if (comps.length === 0) return { ok: false, errors: ['components empty'] };
  if (comps.length > MAX_COMPONENTS) return { ok: false, errors: [`too many components (>${MAX_COMPONENTS})`] };
  if (input['title'] !== undefined && !str(input['title'])) return { ok: false, errors: ['bad title'] };

  const out: CanvasComponent[] = [];
  comps.forEach((c, i) => { const v = validateComponent(c, i, errors); if (v) out.push(v); });
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    payload: { version: CANVAS_SCHEMA_VERSION, ...(str(input['title']) ? { title: input['title'] } : {}), components: out },
    errors: [],
  };
}
