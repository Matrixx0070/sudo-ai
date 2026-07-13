/**
 * @file email-rules.ts
 * @description Inbound email rule engine (Spec 5). Loads config/email-rules.json5
 * and matches a parsed message against from/to/subject/label filters (substring
 * or /regex/ literals, AND-combined). Non-matching mail is ignored when
 * defaultIgnore is true. First matching rule wins. Fail-safe: missing/bad config
 * → no rules → (with defaultIgnore) all mail ignored, so email triggering is
 * strictly opt-in.
 */

import { readFileSync, existsSync } from 'node:fs';
import JSON5 from 'json5';
import { projectPath } from '../shared/paths.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('channels:email-rules');

export interface EmailRule {
  name: string;
  from?: string;
  to?: string;
  subject?: string;
  label?: string;
  prompt?: string;
  autoReply: boolean;
  tools: string[];
}

export interface EmailRulesConfig {
  defaultIgnore: boolean;
  rules: EmailRule[];
}

/** Fields extracted from a parsed inbound message for matching. */
export interface EmailMatchInput {
  from: string;
  to: string[];
  subject: string;
  labels: string[];
}

const CONFIG_PATH = projectPath('config', 'email-rules.json5');

/** Parse a filter value into a matcher: `/re/flags` → regex, else substring (ci). */
function toMatcher(value: string): (s: string) => boolean {
  const m = /^\/(.*)\/([a-z]*)$/.exec(value.trim());
  if (m) {
    try {
      const re = new RegExp(m[1] ?? '', m[2] ?? '');
      return (s: string) => re.test(s);
    } catch {
      // fall through to substring on a bad regex
    }
  }
  const needle = value.toLowerCase();
  return (s: string) => s.toLowerCase().includes(needle);
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
}

function normalizeRule(raw: unknown): EmailRule | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const name = typeof o['name'] === 'string' && o['name'].trim() ? o['name'].trim() : null;
  if (!name) return null;
  return {
    name,
    ...(typeof o['from'] === 'string' ? { from: o['from'] } : {}),
    ...(typeof o['to'] === 'string' ? { to: o['to'] } : {}),
    ...(typeof o['subject'] === 'string' ? { subject: o['subject'] } : {}),
    ...(typeof o['label'] === 'string' ? { label: o['label'] } : {}),
    ...(typeof o['prompt'] === 'string' ? { prompt: o['prompt'] } : {}),
    autoReply: o['autoReply'] === true,
    tools: toStringArray(o['tools']),
  };
}

let _cache: EmailRulesConfig | null = null;

export function loadEmailRules(path: string = CONFIG_PATH, force = false): EmailRulesConfig {
  if (_cache && !force) return _cache;
  if (!existsSync(path)) {
    log.info({ path }, 'no email-rules.json5 — inbound email ignored (opt-in)');
    _cache = { defaultIgnore: true, rules: [] };
    return _cache;
  }
  try {
    const raw = JSON5.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    const rules = (Array.isArray(raw['rules']) ? raw['rules'] : []).map(normalizeRule).filter((r): r is EmailRule => r !== null);
    _cache = { defaultIgnore: raw['defaultIgnore'] !== false, rules };
    log.info({ rules: rules.map((r) => r.name), defaultIgnore: _cache.defaultIgnore }, 'email-rules.json5 loaded');
    return _cache;
  } catch (err) {
    log.error({ path, err: err instanceof Error ? err.message : String(err) }, 'email-rules.json5 parse failed — inbound email ignored');
    _cache = { defaultIgnore: true, rules: [] };
    return _cache;
  }
}

export function __resetEmailRulesForTests(): void { _cache = null; }

/** Does this rule match the message? All present filters must match (AND). */
function ruleMatches(rule: EmailRule, m: EmailMatchInput): boolean {
  if (rule.from && !toMatcher(rule.from)(m.from)) return false;
  if (rule.to && !m.to.some((addr) => toMatcher(rule.to as string)(addr))) return false;
  if (rule.subject && !toMatcher(rule.subject)(m.subject)) return false;
  if (rule.label && !m.labels.some((l) => toMatcher(rule.label as string)(l))) return false;
  // A rule with NO filters would match everything — treat as non-matching to
  // avoid an accidental catch-all.
  return Boolean(rule.from || rule.to || rule.subject || rule.label);
}

/** First matching rule, or null. */
export function matchEmailRule(m: EmailMatchInput, cfg: EmailRulesConfig = loadEmailRules()): EmailRule | null {
  for (const rule of cfg.rules) {
    if (ruleMatches(rule, m)) return rule;
  }
  return null;
}
