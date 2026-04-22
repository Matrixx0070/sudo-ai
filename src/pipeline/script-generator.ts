/**
 * @file script-generator.ts
 * Generates a full 8-scene Hinglish drama script from a selected topic
 * via the xAI Grok LLM with structured JSON output.
 */

import { createLogger } from '../core/shared/logger.js';
import { PipelineError } from '../core/shared/errors.js';
import { DEFAULT_MODEL } from '../core/shared/constants.js';
import { retry } from '../core/shared/utils.js';
import type { SelectedTopic, GeneratedScript, SceneScript, CharacterInfo } from './types.js';

const log = createLogger('pipeline:script-generator');

const MIN_SCENES = 6;
const MAX_SCENES = 10;
const MIN_DURATION_S = 25;
const MAX_DURATION_S = 40;

const SYSTEM_PROMPT = `You are a Hinglish drama script director creating scripts for viral YouTube Shorts.
Target audience: young adults in the configured region.

RULES:
- Write exactly 8 scenes (index 1-8), each 3-4 seconds of narration
- Scene 1 MUST be a powerful hook that stops the scroll
- Use natural Hinglish (mix of Hindi and English) — casual, emotional, relatable
- Each scene carries one strong emotion: shock, anger, betrayal, sadness, relief, twist
- Build tension progressively; scenes 5-6 are the crisis peak; scenes 7-8 are resolution or cliffhanger
- ctaQuestion MUST end with "?" and invite viewer to comment
- Characters must have believable desi names

Return ONLY valid JSON:
{
  "title": "string (Hinglish, max 80 chars)",
  "hookLine": "string (scene 1 hook, punchy, max 60 chars)",
  "ctaQuestion": "string (viewer engagement question ending with ?)",
  "scenes": [
    { "index": 1, "narration": "string (15-30 words)", "description": "string", "emotion": "string", "durationTarget": 3 }
  ],
  "characters": [
    { "name": "string", "role": "protagonist", "description": "string" }
  ]
}`;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function validateScene(raw: unknown, pos: number): SceneScript {
  if (typeof raw !== 'object' || raw === null) {
    throw new PipelineError(`Scene at position ${pos} is not an object`, 'pipeline_script_invalid');
  }
  const obj = raw as Record<string, unknown>;
  const narration = String(obj['narration'] ?? '').trim();
  if (narration.length === 0) {
    throw new PipelineError(`Scene ${pos} has empty narration`, 'pipeline_script_invalid');
  }
  const dur = Number(obj['durationTarget'] ?? 3);
  return {
    index: Number(obj['index'] ?? pos + 1),
    narration,
    description: String(obj['description'] ?? '').trim(),
    emotion: String(obj['emotion'] ?? 'neutral').trim(),
    durationTarget: isNaN(dur) ? 3 : Math.max(2, Math.min(5, dur)),
  };
}

function validateCharacter(raw: unknown, pos: number): CharacterInfo {
  if (typeof raw !== 'object' || raw === null) {
    throw new PipelineError(`Character at position ${pos} is not an object`, 'pipeline_script_invalid');
  }
  const obj = raw as Record<string, unknown>;
  const name = String(obj['name'] ?? '').trim();
  if (name.length === 0) {
    throw new PipelineError(`Character at position ${pos} has no name`, 'pipeline_script_invalid');
  }
  const role = String(obj['role'] ?? 'supporting');
  const validRoles = new Set(['protagonist', 'antagonist', 'supporting']);
  return {
    name,
    role: validRoles.has(role) ? (role as CharacterInfo['role']) : 'supporting',
    description: String(obj['description'] ?? '').trim(),
  };
}

function validateResponse(raw: unknown): {
  title: string; hookLine: string; ctaQuestion: string;
  scenes: SceneScript[]; characters: CharacterInfo[];
} {
  if (typeof raw !== 'object' || raw === null) {
    throw new PipelineError('Script LLM response is not a JSON object', 'pipeline_script_invalid');
  }
  const obj = raw as Record<string, unknown>;

  const title = String(obj['title'] ?? '').trim();
  const hookLine = String(obj['hookLine'] ?? '').trim();
  const ctaQuestion = String(obj['ctaQuestion'] ?? '').trim();

  if (!title) throw new PipelineError('Script missing title', 'pipeline_script_invalid');
  if (!hookLine) throw new PipelineError('Script missing hookLine', 'pipeline_script_invalid');

  if (!Array.isArray(obj['scenes']) || obj['scenes'].length === 0) {
    throw new PipelineError('Script missing scenes array', 'pipeline_script_invalid');
  }
  if (obj['scenes'].length < MIN_SCENES || obj['scenes'].length > MAX_SCENES) {
    throw new PipelineError(
      `Script has ${obj['scenes'].length} scenes; expected ${MIN_SCENES}-${MAX_SCENES}`,
      'pipeline_script_invalid',
    );
  }

  const scenes = (obj['scenes'] as unknown[]).map((s, i) => validateScene(s, i));
  const totalDuration = scenes.reduce((sum, s) => sum + s.durationTarget, 0);
  if (totalDuration < MIN_DURATION_S || totalDuration > MAX_DURATION_S) {
    throw new PipelineError(
      `Total duration ${totalDuration}s outside ${MIN_DURATION_S}-${MAX_DURATION_S}s`,
      'pipeline_script_invalid',
    );
  }

  if (!Array.isArray(obj['characters']) || obj['characters'].length === 0) {
    throw new PipelineError('Script must have at least one character', 'pipeline_script_invalid');
  }
  const characters = (obj['characters'] as unknown[]).map((c, i) => validateCharacter(c, i));

  return { title, hookLine, ctaQuestion, scenes, characters };
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

async function callScriptLLM(topic: SelectedTopic): Promise<GeneratedScript> {
  const apiKey = process.env['XAI_API_KEY'] ?? process.env['OPENAI_API_KEY'];
  if (!apiKey) {
    throw new PipelineError('No API key (XAI_API_KEY / OPENAI_API_KEY)', 'pipeline_script_api_error');
  }

  const model =
    typeof DEFAULT_MODEL === 'string' && DEFAULT_MODEL.includes('grok')
      ? DEFAULT_MODEL.replace('xai/', '')
      : 'grok-3';

  const userPrompt =
    `Topic: "${topic.entry.title}"\n` +
    `Hook: "${topic.entry.hook}"\n` +
    `Primary Emotion: "${topic.entry.emotion}"\n` +
    `Category: "${topic.category}"\n\n` +
    `Write a full 8-scene Hinglish script. Scene 1 should riff on the provided hook.`;

  log.debug({ topicId: topic.entry.id, model }, 'Calling LLM for script');

  const response = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.9,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new PipelineError(
      `Script LLM request failed: ${response.status} ${body.slice(0, 200)}`,
      'pipeline_script_api_error',
      { status: response.status },
    );
  }

  let content: string;
  try {
    const json = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    content = json.choices[0]?.message?.content ?? '';
  } catch (err) {
    throw new PipelineError(`Failed to parse script response envelope: ${String(err)}`, 'pipeline_script_api_error');
  }

  if (!content.trim()) {
    throw new PipelineError('Script LLM returned empty content', 'pipeline_script_api_error');
  }

  let parsed: unknown;
  try { parsed = JSON.parse(content); }
  catch (err) {
    throw new PipelineError(`Script content is not valid JSON: ${String(err)}`, 'pipeline_script_invalid');
  }

  const validated = validateResponse(parsed);
  return {
    topic,
    title: validated.title,
    scenes: validated.scenes,
    characters: validated.characters,
    totalDurationTarget: validated.scenes.reduce((s, sc) => s + sc.durationTarget, 0),
    hookLine: validated.hookLine,
    ctaQuestion: validated.ctaQuestion,
    rawNarration: validated.scenes.map((s) => s.narration).join(' '),
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Generate a full Hinglish drama script for the given topic using xAI Grok.
 * Retries up to 3 times with exponential backoff. Validates scene count (6-10),
 * character presence, and total duration (25-40 s).
 *
 * @param topic - Selected topic with entry details and batch metadata.
 * @returns Validated GeneratedScript ready for the voice stage.
 * @throws PipelineError pipeline_script_api_error on network/API failure,
 *         pipeline_script_invalid on malformed LLM output.
 */
export async function generateScript(topic: SelectedTopic): Promise<GeneratedScript> {
  if (!topic?.entry?.id) {
    throw new PipelineError('generateScript: invalid topic argument', 'pipeline_script_invalid');
  }
  log.info({ topicId: topic.entry.id, title: topic.entry.title }, 'Script generation start');

  const script = await retry(() => callScriptLLM(topic), 3, [1_000, 3_000, 6_000]);

  log.info(
    { topicId: topic.entry.id, scenes: script.scenes.length, duration: script.totalDurationTarget },
    'Script generation complete',
  );
  return script;
}
