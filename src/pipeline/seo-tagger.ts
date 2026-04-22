/**
 * @file seo-tagger.ts
 * Generates YouTube-optimized SEO metadata (title, description, tags, hashtags)
 * via the xAI Grok LLM with a deterministic fallback when the LLM is unavailable.
 */

import { createLogger } from '../core/shared/logger.js';
import { PipelineError } from '../core/shared/errors.js';
import { retry } from '../core/shared/utils.js';
import type { GeneratedScript, AssembledVideo, SeoMetadata } from './types.js';

const log = createLogger('pipeline:seo-tagger');

const MAX_TITLE_CHARS = 100;
const MAX_TAGS = 30;
const MIN_TAGS = 20;
const REQUIRED_HASHTAG = '#shorts';
const CATEGORY_ID = '24';
const CONTENT_LANGUAGE = 'hi';

const SYSTEM_PROMPT = `You are a YouTube SEO specialist for a short-form drama content channel targeting the configured region.

RULES:
- title: max 100 characters, Hinglish, hook-based, 1-2 relevant emojis at end
- description: 300-500 characters, first sentence hooks viewer, keywords used naturally
- tags: 20-30 tags mixing Hindi words, English words, and trending search terms; no # symbol
- hashtags: exactly 3 strings starting with #, MUST include "#shorts"
- categoryId: always "24"
- language: always "hi"

Return ONLY valid JSON:
{
  "title": "string",
  "description": "string",
  "tags": ["string"],
  "hashtags": ["#shorts", "string", "string"],
  "categoryId": "24",
  "language": "hi"
}`;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateSeoResponse(raw: unknown): Omit<SeoMetadata, 'costUsd'> {
  if (typeof raw !== 'object' || raw === null) {
    throw new PipelineError('SEO LLM response is not a JSON object', 'pipeline_seo_api_error');
  }
  const obj = raw as Record<string, unknown>;

  const title = String(obj['title'] ?? '').trim();
  if (!title) throw new PipelineError('SEO response missing title', 'pipeline_seo_api_error');
  if (title.length > MAX_TITLE_CHARS) {
    throw new PipelineError(
      `SEO title exceeds ${MAX_TITLE_CHARS} chars (got ${title.length})`,
      'pipeline_seo_api_error',
    );
  }

  const description = String(obj['description'] ?? '').trim();
  if (!description) {
    throw new PipelineError('SEO response missing description', 'pipeline_seo_api_error');
  }

  if (!Array.isArray(obj['tags'])) {
    throw new PipelineError('SEO tags must be an array', 'pipeline_seo_api_error');
  }
  const tags = (obj['tags'] as unknown[]).map(String);
  if (tags.length < MIN_TAGS || tags.length > MAX_TAGS) {
    throw new PipelineError(
      `SEO tags count ${tags.length} outside ${MIN_TAGS}-${MAX_TAGS}`,
      'pipeline_seo_api_error',
    );
  }

  if (!Array.isArray(obj['hashtags'])) {
    throw new PipelineError('SEO hashtags must be an array', 'pipeline_seo_api_error');
  }
  const hashtags = (obj['hashtags'] as unknown[]).map(String);
  if (!hashtags.includes(REQUIRED_HASHTAG)) {
    throw new PipelineError(
      `SEO hashtags must include "${REQUIRED_HASHTAG}"`,
      'pipeline_seo_api_error',
    );
  }

  return { title, description, tags, hashtags, categoryId: CATEGORY_ID, language: CONTENT_LANGUAGE };
}

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

function buildFallbackMetadata(
  script: GeneratedScript,
  video: AssembledVideo,
): Omit<SeoMetadata, 'costUsd'> {
  log.warn(
    { topicId: script.topic.entry.id, duration: video.durationSeconds },
    'LLM unavailable — using deterministic fallback SEO metadata',
  );

  const title = `${script.title} | ${script.topic.entry.emotion} story`.slice(0, MAX_TITLE_CHARS);

  const description = (
    `${script.hookLine} — ${script.topic.entry.title}. ` +
    `Watch this ${script.topic.entry.emotion} Hinglish drama short. ` +
    `${script.ctaQuestion} Comment below! ` +
    `#hinglish #drama #indianstories`
  ).slice(0, 500);

  const baseTags = [
    script.topic.entry.emotion, script.topic.category,
    'hinglish drama', 'hindi short film', 'emotional drama',
    'emotional story', 'viral shorts', 'hindi kahani',
    'desi drama', 'short video', 'hindi video', 'emotional video',
    'short drama series', 'viral drama short', 'south asia stories',
    'family drama', 'betrayal story', 'love story hindi',
    'heart touching', 'viral short film',
  ];
  const titleWords = script.topic.entry.title
    .split(/\s+/).filter((w) => w.length > 3).slice(0, 5);
  const tags = [...new Set([...baseTags, ...titleWords])].slice(0, MAX_TAGS);

  return {
    title,
    description,
    tags,
    hashtags: [REQUIRED_HASHTAG, '#hinglishstories', '#dramaticshorts'],
    categoryId: CATEGORY_ID,
    language: CONTENT_LANGUAGE,
  };
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

async function callSeoLLM(
  script: GeneratedScript,
  video: AssembledVideo,
): Promise<Omit<SeoMetadata, 'costUsd'>> {
  const apiKey = process.env['XAI_API_KEY'] ?? process.env['OPENAI_API_KEY'];
  if (!apiKey) {
    throw new PipelineError('No API key (XAI_API_KEY / OPENAI_API_KEY)', 'pipeline_seo_api_error');
  }

  const userPrompt =
    `Video Title: "${script.title}"\n` +
    `Hook Line: "${script.hookLine}"\n` +
    `CTA Question: "${script.ctaQuestion}"\n` +
    `Category: "${script.topic.category}"\n` +
    `Primary Emotion: "${script.topic.entry.emotion}"\n` +
    `Duration: ${video.durationSeconds} seconds\n\n` +
    `Generate optimized YouTube SEO metadata for this Hinglish drama Short.`;

  log.debug({ topicId: script.topic.entry.id }, 'Calling LLM for SEO metadata');

  const response = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-3-fast',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.7,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new PipelineError(
      `SEO LLM request failed: ${response.status} ${body.slice(0, 200)}`,
      'pipeline_seo_api_error',
      { status: response.status },
    );
  }

  let content: string;
  try {
    const json = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    content = json.choices[0]?.message?.content ?? '';
  } catch (err) {
    throw new PipelineError(`Failed to parse SEO response envelope: ${String(err)}`, 'pipeline_seo_api_error');
  }

  if (!content.trim()) {
    throw new PipelineError('SEO LLM returned empty content', 'pipeline_seo_api_error');
  }

  let parsed: unknown;
  try { parsed = JSON.parse(content); }
  catch (err) {
    throw new PipelineError(`SEO content is not valid JSON: ${String(err)}`, 'pipeline_seo_api_error');
  }

  return validateSeoResponse(parsed);
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Generate YouTube SEO metadata for an assembled video using xAI grok-3-fast.
 * Retries the LLM 3 times before falling back to deterministic metadata built
 * from script fields — the pipeline never stalls on SEO generation.
 *
 * @param script - GeneratedScript providing title, hookLine, ctaQuestion.
 * @param video  - AssembledVideo providing durationSeconds.
 * @returns SeoMetadata with title, description, tags, hashtags, categoryId,
 *          language, and costUsd.
 * @throws PipelineError pipeline_seo_api_error only on invalid arguments.
 */
export async function generateSeoMetadata(
  script: GeneratedScript,
  video: AssembledVideo,
): Promise<SeoMetadata> {
  if (!script?.topic?.entry?.id) {
    throw new PipelineError('generateSeoMetadata: invalid script argument', 'pipeline_seo_api_error');
  }
  if (!video?.durationSeconds || video.durationSeconds <= 0) {
    throw new PipelineError('generateSeoMetadata: invalid video argument', 'pipeline_seo_api_error');
  }

  log.info({ topicId: script.topic.entry.id }, 'SEO metadata generation start');

  let metadata: Omit<SeoMetadata, 'costUsd'>;
  let costUsd = 0;
  let usedFallback = false;

  try {
    metadata = await retry(() => callSeoLLM(script, video), 3, [1_000, 2_000, 4_000]);
    costUsd = 0.0003; // Estimated for grok-3-fast; replace with token accounting.
  } catch (err) {
    log.error({ err: String(err), topicId: script.topic.entry.id }, 'SEO LLM failed — activating fallback');
    metadata = buildFallbackMetadata(script, video);
    usedFallback = true;
  }

  log.info(
    {
      topicId: script.topic.entry.id,
      titleLength: metadata.title.length,
      tagCount: metadata.tags.length,
      usedFallback,
      costUsd,
    },
    'SEO metadata generation complete',
  );

  return { ...metadata, costUsd };
}
