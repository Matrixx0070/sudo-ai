/**
 * @file prompt-report.ts
 * @description BO1 / scorecard-S9 — per-turn prompt accounting, modeled on
 * OpenClaw's `system-prompt-report.ts`.
 *
 * Given a fully-assembled system prompt string, produce a structured report
 * describing:
 *   - the stable (cacheable) prefix vs the dynamic (per-call) suffix, split at
 *     the {@link DYNAMIC_BOUNDARY_MARKER};
 *   - per-section `{ name, chars, sha256, region }` accounting.
 *
 * INVARIANT — NO RAW PROMPT TEXT: this module stores only character counts and
 * sha256 hashes. It never retains or returns the prompt content itself. That is
 * what makes it safe to persist to disk and surface on a telemetry tab for a
 * ~28k-token prompt.
 *
 * Pure and dependency-light on purpose: it operates on the assembled OUTPUT
 * string, so it can never change prompt content or agent behaviour
 * (observability-only). Persistence + churn detection live in
 * `prompt-report-store.ts`.
 */

import { createHash } from 'node:crypto';
import { DYNAMIC_BOUNDARY_MARKER, isPromptCacheEnabled } from './prompt-cache-discipline.js';

/** Which side of the cache boundary a section falls on. */
export type PromptRegion = 'stable' | 'dynamic';

/** Per-section accounting. Hash + size only — never the raw text. */
export interface PromptSectionReport {
  /** Section name — the `## Header` text, or a synthetic name for header-less content. */
  name: string;
  /** Character length of the section (including its header line). */
  chars: number;
  /** sha256 hex of the section content. */
  sha256: string;
  /** Stable (cacheable) prefix, or dynamic (per-call) suffix. */
  region: PromptRegion;
}

/** Full per-turn prompt report. Hashes + counts only — no raw prompt text. */
export interface PromptReport {
  /** ISO-8601 timestamp of report generation. */
  ts: string;
  /** Total character length of the assembled prompt. */
  totalChars: number;
  /** sha256 hex of the entire assembled prompt. */
  fullSha256: string;
  /** Character length of the stable (cacheable) prefix (everything before the boundary marker). */
  stablePrefixChars: number;
  /** sha256 hex of the stable prefix — the byte-stability of this is what cache hits depend on. */
  stablePrefixSha256: string;
  /** Character length of the dynamic suffix (boundary marker onward). */
  dynamicSuffixChars: number;
  /** sha256 hex of the dynamic suffix. */
  dynamicSuffixSha256: string;
  /** Whether a boundary marker was found (cache-split is meaningful only when true). */
  hasBoundary: boolean;
  /** Whether SUDO_PROMPT_CACHE is enabled at report time (context for the split). */
  cacheEnabled: boolean;
  /** Per-section breakdown. */
  sections: PromptSectionReport[];
}

/** sha256 hex digest of a string. */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const HEADER_RE = /^## (.+)$/gm;

/**
 * Parse a chunk of prompt text into `## Header`-delimited sections.
 * Header-less leading content (SOUL/IDENTITY/USER above the boundary; the
 * boundary marker + timestamp preamble below it) becomes a single synthetic
 * section named `preambleName`.
 *
 * @param text - The prompt chunk (already sliced to one region).
 * @param region - Region tag applied to every produced section.
 * @param preambleName - Name for header-less leading content.
 */
export function parseSections(
  text: string,
  region: PromptRegion,
  preambleName: string,
): PromptSectionReport[] {
  const out: PromptSectionReport[] = [];
  if (!text) return out;

  // Collect header positions.
  const headers: Array<{ index: number; name: string }> = [];
  HEADER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HEADER_RE.exec(text)) !== null) {
    headers.push({ index: m.index, name: m[1]!.trim() });
  }

  const push = (name: string, content: string): void => {
    if (content.trim().length === 0) return;
    out.push({ name, chars: content.length, sha256: sha256(content), region });
  };

  if (headers.length === 0) {
    push(preambleName, text);
    return out;
  }

  // Header-less preamble before the first header.
  push(preambleName, text.slice(0, headers[0]!.index));

  for (let i = 0; i < headers.length; i++) {
    const start = headers[i]!.index;
    const end = i + 1 < headers.length ? headers[i + 1]!.index : text.length;
    push(headers[i]!.name, text.slice(start, end));
  }
  return out;
}

/**
 * Build the per-turn prompt report from a fully-assembled system prompt.
 *
 * The stable/dynamic split is exact: the prompt is sliced at the FIRST
 * {@link DYNAMIC_BOUNDARY_MARKER}. When no marker is present (marker-less prompts
 * or a bug), the whole prompt is treated as stable and `hasBoundary` is false.
 *
 * @param prompt - Assembled system prompt string.
 * @returns A {@link PromptReport} carrying only counts + hashes.
 */
export function buildPromptReport(prompt: string): PromptReport {
  const full = prompt ?? '';
  const idx = full.indexOf(DYNAMIC_BOUNDARY_MARKER);
  const hasBoundary = idx >= 0;

  const stablePrefix = hasBoundary ? full.slice(0, idx) : full;
  const dynamicSuffix = hasBoundary ? full.slice(idx) : '';

  const sections = [
    ...parseSections(stablePrefix, 'stable', 'Preamble (SOUL/IDENTITY/USER)'),
    ...parseSections(dynamicSuffix, 'dynamic', 'Dynamic Boundary'),
  ];

  return {
    ts: new Date().toISOString(),
    totalChars: full.length,
    fullSha256: sha256(full),
    stablePrefixChars: stablePrefix.length,
    stablePrefixSha256: sha256(stablePrefix),
    dynamicSuffixChars: dynamicSuffix.length,
    dynamicSuffixSha256: sha256(dynamicSuffix),
    hasBoundary,
    cacheEnabled: isPromptCacheEnabled(),
    sections,
  };
}

/**
 * Churn diagnostic (BO2 will consume this): the cacheable stable prefix should
 * be byte-stable turn-over-turn for cache hits. Returns true when the new
 * stable-prefix hash differs from the previous one for the same session/route.
 * A `null`/empty previous hash (first turn) is NOT churn.
 */
export function detectPrefixChurn(
  previousStableSha256: string | null | undefined,
  nextStableSha256: string,
): boolean {
  if (!previousStableSha256) return false;
  return previousStableSha256 !== nextStableSha256;
}
