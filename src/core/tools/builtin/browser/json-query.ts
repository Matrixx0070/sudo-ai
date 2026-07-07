/**
 * @file json-query.ts
 * @description A small, SAFE (no eval) jq-style query evaluator for reducing a
 * large fetched JSON body to just the piece the caller needs — so the agent
 * never has to reason over a 300KB blob (which truncates and invites
 * confabulation). Covers the common "find/pick in a list" cases; not full jq.
 *
 * Pipe stages, separated by `|`:
 *   .a.b[0].c            navigate object keys and array indices
 *   select(.k)           keep array elements where element.k is truthy
 *   select(.k == "v")    keep elements where element.k equals a string/number/bool
 *   select(.k != v)      keep elements where element.k does NOT equal the value
 *   map(.k)              project element.k from each array element
 *   first | last         the first / last element of an array
 *   length               count (array length, object key count, or string length)
 *   keys                 sorted key names of an object
 *
 * Example (the Node.js LTS case): `select(.lts) | first | .version`
 */

export class JsonQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonQueryError';
  }
}

type Json = unknown;

/** Parse a literal used in select equality: "quoted" | number | true | false | null. */
function parseLiteral(raw: string): Json {
  const t = raw.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t; // bareword → compared as string
}

/** Navigate a dot/bracket path like `.a.b[0].c` (leading dot optional) into `value`. */
function applyPath(value: Json, path: string): Json {
  // Tokens: .ident  or  [index]  or  ["key"]
  const tokenRe = /\.([A-Za-z_$][\w$]*)|\[(\d+)\]|\["([^"]*)"\]|\['([^']*)'\]/g;
  let cursor = value;
  let consumed = 0;
  let m: RegExpExecArray | null;
  const normalized = path.startsWith('.') || path.startsWith('[') ? path : `.${path}`;
  tokenRe.lastIndex = 0;
  while ((m = tokenRe.exec(normalized)) !== null) {
    if (m.index !== consumed) break; // gap → malformed
    consumed = tokenRe.lastIndex;
    if (cursor == null) return undefined;
    if (m[1] !== undefined) {
      cursor = (cursor as Record<string, Json>)[m[1]];
    } else if (m[2] !== undefined) {
      cursor = Array.isArray(cursor) ? cursor[Number(m[2])] : undefined;
    } else {
      const key = m[3] ?? m[4] ?? '';
      cursor = (cursor as Record<string, Json>)[key];
    }
  }
  if (consumed !== normalized.length) {
    throw new JsonQueryError(`invalid path segment near "${normalized.slice(consumed)}"`);
  }
  return cursor;
}

function requireArray(value: Json, stage: string): Json[] {
  if (!Array.isArray(value)) {
    throw new JsonQueryError(`${stage} expects an array but got ${value === null ? 'null' : typeof value}`);
  }
  return value;
}

function applyStage(value: Json, stage: string): Json {
  const s = stage.trim();
  if (s === '') return value;

  if (s === 'first') return requireArray(value, 'first')[0];
  if (s === 'last') { const a = requireArray(value, 'last'); return a[a.length - 1]; }
  if (s === 'length') {
    if (Array.isArray(value) || typeof value === 'string') return value.length;
    if (value && typeof value === 'object') return Object.keys(value).length;
    throw new JsonQueryError('length expects an array, string, or object');
  }
  if (s === 'keys') {
    if (value && typeof value === 'object' && !Array.isArray(value)) return Object.keys(value).sort();
    throw new JsonQueryError('keys expects an object');
  }

  const selectMatch = s.match(/^select\(\s*(.+?)\s*\)$/);
  if (selectMatch) {
    const expr = selectMatch[1];
    const arr = requireArray(value, 'select');
    const eq = expr.match(/^(\.[\w$.[\]"']+)\s*(==|!=)\s*(.+)$/);
    if (eq) {
      const [, keyPath, op, litRaw] = eq;
      const lit = parseLiteral(litRaw);
      return arr.filter((el) => {
        const got = applyPath(el, keyPath);
        const equal = got === lit;
        return op === '==' ? equal : !equal;
      });
    }
    // truthy form: select(.k)
    return arr.filter((el) => Boolean(applyPath(el, expr)));
  }

  const mapMatch = s.match(/^map\(\s*(\.[\w$.[\]"']*)\s*\)$/);
  if (mapMatch) {
    const arr = requireArray(value, 'map');
    return arr.map((el) => applyPath(el, mapMatch[1]));
  }

  if (s.startsWith('.') || s.startsWith('[')) {
    return applyPath(value, s);
  }

  throw new JsonQueryError(`unknown query stage: "${s}"`);
}

/**
 * Evaluate a pipe query against parsed JSON. Throws JsonQueryError on a
 * malformed query or a type mismatch (e.g. select on a non-array). Pure.
 */
export function evaluateJsonQuery(data: Json, query: string): Json {
  const stages = query.split('|').map((p) => p.trim()).filter((p) => p !== '');
  if (stages.length === 0) throw new JsonQueryError('empty query');
  let cursor: Json = data;
  for (const stage of stages) {
    cursor = applyStage(cursor, stage);
  }
  return cursor;
}
