/**
 * @file json-repair.ts
 * @description Best-effort repair of malformed JSON emitted by weaker LLMs in
 * the text/JSON tool-call fallback path. Frontier models emit native tool calls
 * and never reach this code; smaller models (kimi/glm/ollama/local) routinely
 * emit *almost*-valid JSON — markdown fences, trailing commas, single quotes,
 * Python literals, unquoted keys, or a truncated tail. Today such a block is
 * silently dropped (brain.ts), which strands the model: its call vanishes, it
 * assumes nothing happened, and it retries into a loop.
 *
 * Design contract: a repair is only ever accepted if the result actually
 * parses. {@link repairJson} returns a string that is guaranteed to satisfy
 * `JSON.parse`, or `null` — it never returns a "maybe" string. Each transform
 * is a candidate that is validated by parsing before being trusted, so a risky
 * rewrite (e.g. single→double quotes) can never corrupt an otherwise-fine call.
 *
 * Pure module, no imports — safe to use from anywhere (brain, tools, tests).
 */

/** Strip a leading/trailing markdown code fence (```json … ``` or ``` … ```). */
function stripFences(s: string): string {
  // Opening fence with optional language tag, then a closing fence.
  const fenced = /^\s*```[a-zA-Z0-9]*\s*\n?([\s\S]*?)\n?\s*```\s*$/.exec(s);
  if (fenced && fenced[1] !== undefined) return fenced[1].trim();
  // A stray leading fence with no close (truncated) — drop the fence marker.
  return s.replace(/^\s*```[a-zA-Z0-9]*\s*\n?/, '').replace(/\n?\s*```\s*$/, '').trim();
}

/**
 * Extract the first balanced JSON object/array from a string that may have
 * prose around it ("Sure, here you go: { … }"). String-aware so braces inside
 * string literals don't throw off the depth count. Returns null when no
 * balanced value is found.
 */
function extractFirstJson(s: string): string | null {
  const start = s.search(/[{[]/);
  if (start === -1) return null;
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null; // unterminated — handled by closeUnterminated()
}

/** Normalize smart quotes to straight quotes. */
function normalizeQuotes(s: string): string {
  return s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
}

/** Map Python/JS literals to JSON: True→true, False→false, None/undefined→null. */
function pythonLiterals(s: string): string {
  return s
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false')
    .replace(/\bNone\b/g, 'null')
    .replace(/\bundefined\b/g, 'null');
}

/** Remove trailing commas before a closing } or ]. */
function removeTrailingCommas(s: string): string {
  return s.replace(/,(\s*[}\]])/g, '$1');
}

/** Quote bare identifier keys: {key: …} → {"key": …}. Skips already-quoted. */
function quoteUnquotedKeys(s: string): string {
  return s.replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)(\s*:)/g, '$1"$2"$3');
}

/**
 * Convert single-quoted strings to double-quoted. Conservative: only flips
 * quotes that wrap a value/key with no embedded double-quote, leaving
 * apostrophes inside double-quoted strings untouched. Validated by parse, so a
 * wrong flip is simply discarded.
 */
function singleToDouble(s: string): string {
  return s.replace(/'([^'"\\]*)'/g, '"$1"');
}

/**
 * Close an unterminated tail: balance open strings, then open brackets/braces
 * in the correct nesting order. String-aware.
 */
function closeUnterminated(s: string): string {
  const stack: string[] = [];
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let out = s;
  if (inStr) out += '"';
  // Drop a dangling trailing comma/colon before closing.
  out = out.replace(/[,:]\s*$/, '');
  while (stack.length) out += stack.pop();
  return out;
}

/**
 * Attempt to repair a malformed JSON string. Returns a string guaranteed to
 * parse, or null if no transform sequence yields valid JSON.
 *
 * Strategy: build a set of progressively-transformed candidates and return the
 * first that `JSON.parse` accepts. Because acceptance is gated by parsing, no
 * candidate can corrupt the result — a bad transform just fails to parse and is
 * skipped.
 */
export function repairJson(raw: string): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;

  const candidates: string[] = [];
  const push = (c: string | null | undefined): void => {
    if (c && typeof c === 'string') candidates.push(c);
  };

  const defenced = stripFences(raw.trim());
  const bases = [defenced, extractFirstJson(defenced)].filter((b): b is string => !!b);

  for (const base of bases) {
    push(base);
    // Apply transforms cumulatively; push each stage as its own candidate so a
    // single needed fix is found without requiring all later (riskier) ones.
    let t = normalizeQuotes(base);
    push(t);
    t = pythonLiterals(t);
    push(t);
    t = removeTrailingCommas(t);
    push(t);
    t = quoteUnquotedKeys(t);
    push(t);
    t = singleToDouble(t);
    push(t);
    t = removeTrailingCommas(t); // singleToDouble may expose new trailing commas
    push(t);
    t = closeUnterminated(t);
    push(t);
  }

  for (const c of candidates) {
    try {
      JSON.parse(c);
      return c;
    } catch {
      // not this one — keep trying
    }
  }
  return null;
}

/** Result of {@link tryParseJson}: the parsed value plus whether repair ran. */
export interface ParsedJson<T> {
  value: T;
  /** true when the raw string failed JSON.parse and a repair was applied. */
  repaired: boolean;
}

/**
 * Parse JSON, repairing first only if a clean parse fails. Returns null when
 * the input is unparseable even after repair.
 *
 * @param raw - the candidate JSON string from the model.
 * @param enableRepair - when false, behaves like a plain JSON.parse (no repair).
 */
export function tryParseJson<T = unknown>(raw: string, enableRepair = true): ParsedJson<T> | null {
  try {
    return { value: JSON.parse(raw) as T, repaired: false };
  } catch {
    if (!enableRepair) return null;
  }
  const fixed = repairJson(raw);
  if (fixed === null) return null;
  try {
    return { value: JSON.parse(fixed) as T, repaired: true };
  } catch {
    return null;
  }
}

/** Read the kill-switch: repair is on by default, SUDO_JSON_REPAIR=0 disables it. */
export function isJsonRepairEnabled(): boolean {
  return process.env['SUDO_JSON_REPAIR'] !== '0';
}
