/**
 * @file inline-artifacts.ts
 * @description TX4 — pure decision logic for inline artifact delivery on chat
 * channels (flag `SUDO_TG_ARTIFACTS`, default OFF).
 *
 * What already exists (do not rebuild): the rich-output tools (data.chart,
 * media.diagram, media.mermaid, spreadsheet.*, document.*, …) RENDER their
 * artifacts to files, `extractFileAttachments` (agent loop) collects the
 * paths, and cli.ts delivers them via `telegram.sendMedia` before the text
 * reply. The real gaps this module closes:
 *
 *   1. Artifacts arrive caption-less — a bare image with no context.
 *      → {@link planInlineArtifacts} picks up to {@link MAX_INLINE_ARTIFACTS}
 *        deliverables (each ≤ {@link MAX_INLINE_ARTIFACT_BYTES}) and builds a
 *        caption for each from the reply text / filename.
 *   2. The underlying data (markdown tables, big fenced data blocks) is
 *      dumped as prose in the reply even though the rendered artifact already
 *      carries it. → {@link hasFoldableData} decides whether the reply should
 *      ship via the existing collapse machinery (`md-collapse` /
 *      `mdToTelegramHtmlCollapsed`) so the raw data folds behind "Read More".
 *
 * Pure module — no fs / telegram imports; callers supply byte sizes.
 * Callers must fail open to current behavior on any error.
 */

/** Max artifacts per turn that get the inline caption treatment. */
export const MAX_INLINE_ARTIFACTS = 3;

/** Per-artifact size cap for the inline treatment (bytes). */
export const MAX_INLINE_ARTIFACT_BYTES = 5 * 1024 * 1024;

/** Telegram caps media captions at 1024 chars; stay comfortably below. */
const CAPTION_MAX = 900;

/** Candidate artifact = one collected file attachment plus its on-disk size. */
export interface ArtifactCandidate {
  path: string;
  type: 'image' | 'video' | 'audio' | 'document';
  filename?: string | undefined;
  /** Size in bytes; unknown/unreadable (undefined) fails the size gate. */
  bytes?: number | undefined;
}

/** Delivery plan: caption per selected artifact path + data-fold decision. */
export interface InlineArtifactPlan {
  /** path → caption for artifacts that get the inline treatment. */
  captions: Map<string, string>;
  /** Deliver the text reply through the collapse machinery. */
  foldData: boolean;
}

/**
 * Prettify a filename into a caption title: strip extension, timestamps and
 * hash-ish suffixes, de-kebab/-snake, collapse whitespace.
 */
export function titleFromFilename(filename: string): string {
  const stem = (filename.split('/').pop() ?? filename).replace(/\.[A-Za-z0-9]+$/, '');
  const cleaned = stem
    .replace(/[-_.]?\d{4}-\d{2}-\d{2}[T_-]?[\d:-]*/g, '') // ISO-ish timestamps
    .replace(/[-_][a-f0-9]{6,}$/i, '') // trailing hex hash
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : stem;
}

/**
 * Build a caption for one artifact: prefer a reply-text line that mentions
 * the filename stem (the model usually narrates what it produced), else the
 * first markdown heading, else the prettified filename. Never empty.
 */
export function buildArtifactCaption(att: ArtifactCandidate, replyText: string): string {
  const name = att.filename ?? att.path.split('/').pop() ?? att.path;
  const stem = name.replace(/\.[A-Za-z0-9]+$/, '');
  const lines = replyText.split('\n').map((l) => l.trim());
  if (stem.length >= 4) {
    const mention = lines.find((l) => l.length > 0 && l.length <= CAPTION_MAX && l.toLowerCase().includes(stem.toLowerCase()));
    if (mention) return stripMd(mention).slice(0, CAPTION_MAX);
  }
  const heading = lines.find((l) => /^#{1,4}\s+\S/.test(l));
  if (heading) return stripMd(heading).slice(0, CAPTION_MAX);
  return titleFromFilename(name).slice(0, CAPTION_MAX);
}

/** Light markdown strip for caption text (captions render plain). */
function stripMd(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

/**
 * Does the reply body carry raw data that duplicates a rendered artifact —
 * a markdown table (≥3 consecutive pipe rows incl. a separator) or a large
 * fenced block (≥400 chars)? Only true when the body is long enough
 * (>720 chars) for the collapse renderer to actually engage
 * (`mdToTelegramHtmlCollapsed` head 480 × 1.5).
 */
export function hasFoldableData(replyText: string): boolean {
  if (replyText.length <= 720) return false;
  // Markdown table: header row, |---| separator, ≥1 data row.
  if (/^\s*\|.+\|\s*$\n^\s*\|?[\s:|-]*-{3,}[\s:|-]*\|?\s*$\n^\s*\|.+\|\s*$/m.test(replyText)) return true;
  // Large fenced block (data/code dump).
  for (const m of replyText.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    if ((m[1] ?? '').length >= 400) return true;
  }
  return false;
}

/**
 * Decide the inline delivery for this turn's artifacts. Selection preserves
 * attachment order (which mirrors production order in the turn), keeps only
 * size-known artifacts within the byte cap, and stops at the per-turn max.
 * Unselected artifacts keep the existing caption-less delivery — nothing is
 * ever dropped.
 */
export function planInlineArtifacts(atts: ArtifactCandidate[], replyText: string): InlineArtifactPlan {
  const captions = new Map<string, string>();
  for (const att of atts) {
    if (captions.size >= MAX_INLINE_ARTIFACTS) break;
    if (typeof att.bytes !== 'number' || att.bytes <= 0 || att.bytes > MAX_INLINE_ARTIFACT_BYTES) continue;
    if (captions.has(att.path)) continue;
    captions.set(att.path, buildArtifactCaption(att, replyText));
  }
  return { captions, foldData: captions.size > 0 && hasFoldableData(replyText) };
}
