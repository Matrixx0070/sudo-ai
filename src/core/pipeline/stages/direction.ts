/**
 * Direction stage — calls Grok with the full director prompt to produce an
 * 8-scene DirectorPlan. Ported from director_prompt.py (SUDO-AI Python pipeline).
 */

import { createLogger } from '../../shared/logger.js';
import { PipelineError } from '../../shared/errors.js';
import type { PipelineRun, DirectorPlan, ScenePlan, CharacterDNA } from '../types.js';

const log = createLogger('pipeline:direction');

// ---------------------------------------------------------------------------
// Character DNA — Nova (outfit injected per story)
// ---------------------------------------------------------------------------

const NOVA_CHARACTER_DNA = `CHARACTER DNA — NOVA (frozen face/hair/body, outfit varies by story):
- Identity: 19-year-old female, lean athletic build
- Face: sharp angular jaw, large luminous violet eyes with inner glow, small nose, defined cheekbones, expressive anime features
- Hair: long flowing silver-white hair with electric blue tips, straight with subtle wave, reaches mid-back, often caught in wind
- Outfit: {{OUTFIT}}
- Signature feature: violet eyes have a subtle inner luminescence

STYLE LOCK (use identically every scene):
clean anime art style, cel-shaded, bold black outlines, vibrant flat colors with subtle gradient shading, Ufotable animation quality, sharp detailed linework, high contrast dramatic palette

QUALITY STACK (append to every image prompt):
masterpiece, best quality, ultra-detailed, sharp focus, cinematic composition, professional anime illustration, 8K resolution, vertical portrait orientation 9:16`;

const OUTFIT_LIBRARY: Record<string, string> = {
  default_casual: 'simple white kurta top with gold embroidery at neckline, dark blue jeans, brown leather sandals, thin gold chain necklace',
  sari_traditional: 'elegant deep red silk sari with gold border draped over shoulder, matching gold bangles, small gold jhumka earrings, bindi on forehead',
  office_formal: 'light blue collared button-up shirt tucked into black pencil skirt, simple watch on left wrist, small pearl earrings, black heels',
  casual_home: 'oversized soft pink t-shirt, grey cotton shorts, bare feet, hair tied in messy bun with scrunchie',
};

const LOCATION_LIBRARY: Record<string, string> = {
  house_interior: 'warm Indian living room with ornate wooden furniture, colorful cushions, framed family photos, ceiling fan, warm yellow tungsten lighting',
  park_daylight: 'sunlit public park with large banyan tree, wooden bench, green grass, golden hour sunlight filtering through leaves',
  street_night: 'narrow rain-slicked city street at night, neon shop signs in Hindi, wet reflections on road, dim orange streetlights',
  rooftop: 'concrete building rooftop at night, water tank, clothesline with saris, distant city lights twinkling, cool blue moonlight',
  temple_steps: 'ancient stone temple steps at dusk, oil lamp flames flickering, carved stone pillars, orange marigold garlands, purple twilight sky',
};

// ---------------------------------------------------------------------------
// Director system prompt (abbreviated from DIRECTOR_PROMPT_SHORTS)
// ---------------------------------------------------------------------------

function buildDirectorPrompt(topic: string, facts: string[], castBlock: string): string {
  const lessonsBlock = facts.length > 0
    ? `KEY FACTS:\n${facts.map((f, i) => `${i + 1}. ${f}`).join('\n')}`
    : '';

  const locationTemplates = Object.entries(LOCATION_LIBRARY)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');

  return `You are an elite YouTube Shorts director. Create an 8-scene production plan for MAXIMUM retention.

TOPIC: "${topic}"
${lessonsBlock}

STRUCTURE: 8 scenes, 30 seconds total. Mix of 3s and 4s scenes.
STORY: Single emotional arc (Betrayal, Mystery, or Revenge). Start IN MEDIAS RES.
ENDING written FIRST, then opening crafted to loop seamlessly back to scene 1.

SCENES:
1. THE HOOK (4s) — extreme close-up face, teaser WITHOUT spoiling twist
2. THE GOLDEN PAST (4s) — flashback, warm tones, protagonist + antagonist happy
3. THE FIRST CRACK (3s) — over-shoulder, show object of suspicion
4. THE EVIDENCE (3s) — extreme close-up on proof, mini-cliffhanger
5. THE BETRAYER REVEALED (4s) — medium shot, antagonist in true form
6. THE CONFRONTATION (4s) — face-to-face, maximum emotional intensity
7. THE AFTERMATH (4s) — protagonist's power shift
8. THE LOOP + CTA (4s) — resolution + engagement question + mirrors scene 1

LOCATION TEMPLATES:
${locationTemplates}

CAST RULES: Minimum 2 characters. Protagonist narrates first person.
${castBlock}

NARRATION: English only. Max 25 words per scene. Use [pause], <whisper> emotion tags.
IMAGE PROMPTS: 40-75 words. Formula: [Character DNA] + [Action] + [Environment] + [Lighting] + [Camera] + [Style Lock] + [Quality Stack]
VIDEO PROMPTS: 30-80 words. Describe ONLY motion + camera + physics. Add "face identity preserved" on any face shot.

Return ONLY valid JSON:
{
  "title": "viral title under 60 chars with emoji",
  "hookLine": "scene 1 narration teaser",
  "ctaQuestion": "scene 8 engagement question",
  "cast": {
    "protagonist": { "name": "Nova", "role": "protagonist", "appearance": "...", "outfit": "..." },
    "antagonist": { "name": "...", "role": "antagonist", "appearance": "...", "outfit": "..." }
  },
  "narration": ["scene1 line", "scene2 line", "...8 lines total"],
  "scenes": [
    {
      "index": 1,
      "description": "...",
      "location": "location key or custom",
      "charactersInScene": ["protagonist"],
      "cameraAngle": "extreme close-up face",
      "narrationLine": "...",
      "emotionalBeat": "shock",
      "dalleImagePrompt": "...",
      "grokVideoPrompt": "...",
      "textOverlay": "bold 2-6 word teaser"
    }
  ]
}`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateDirectorPlan(raw: unknown): DirectorPlan {
  if (typeof raw !== 'object' || raw === null) {
    throw new PipelineError('Director response is not an object', 'pipeline_direction_invalid');
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj['title'] !== 'string' || obj['title'].trim().length === 0) {
    throw new PipelineError('Director plan missing title', 'pipeline_direction_invalid');
  }
  if (!Array.isArray(obj['scenes']) || obj['scenes'].length !== 8) {
    throw new PipelineError(
      `Director plan must have exactly 8 scenes, got ${Array.isArray(obj['scenes']) ? (obj['scenes'] as unknown[]).length : 0}`,
      'pipeline_direction_invalid',
    );
  }
  if (!Array.isArray(obj['narration']) || (obj['narration'] as unknown[]).length !== 8) {
    throw new PipelineError('Director plan narration must have 8 lines', 'pipeline_direction_invalid');
  }

  const scenes = (obj['scenes'] as unknown[]).map((s, idx) => {
    if (typeof s !== 'object' || s === null) {
      throw new PipelineError(`Scene ${idx} is not an object`, 'pipeline_direction_invalid');
    }
    const scene = s as Record<string, unknown>;
    return {
      index: Number(scene['index'] ?? idx + 1),
      description: String(scene['description'] ?? ''),
      location: String(scene['location'] ?? ''),
      charactersInScene: Array.isArray(scene['charactersInScene'])
        ? (scene['charactersInScene'] as unknown[]).map(String)
        : [],
      cameraAngle: String(scene['cameraAngle'] ?? ''),
      narrationLine: String(scene['narrationLine'] ?? ''),
      emotionalBeat: String(scene['emotionalBeat'] ?? ''),
      dalleImagePrompt: typeof scene['dalleImagePrompt'] === 'string' ? scene['dalleImagePrompt'] : undefined,
      grokVideoPrompt: typeof scene['grokVideoPrompt'] === 'string' ? scene['grokVideoPrompt'] : undefined,
      textOverlay: typeof scene['textOverlay'] === 'string' ? scene['textOverlay'] : undefined,
    } satisfies ScenePlan;
  });

  const rawCast = (obj['cast'] ?? {}) as Record<string, unknown>;
  const cast: Record<string, CharacterDNA> = {};
  for (const [key, val] of Object.entries(rawCast)) {
    if (typeof val === 'object' && val !== null) {
      const c = val as Record<string, unknown>;
      cast[key] = {
        name: String(c['name'] ?? key),
        role: (c['role'] as CharacterDNA['role']) ?? 'supporting',
        appearance: String(c['appearance'] ?? ''),
        outfit: String(c['outfit'] ?? ''),
      };
    }
  }

  return {
    title: String(obj['title']).trim(),
    scenes,
    cast,
    narration: (obj['narration'] as unknown[]).map(String),
    hookLine: String(obj['hookLine'] ?? scenes[0]?.narrationLine ?? ''),
    ctaQuestion: String(obj['ctaQuestion'] ?? ''),
  };
}

// ---------------------------------------------------------------------------
// Stage runner
// ---------------------------------------------------------------------------

export async function runDirection(
  run: PipelineRun,
  checkpoint: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  log.info({ runId: run.id, topic: run.topic }, 'Direction stage start');

  const apiKey = process.env['XAI_API_KEY'];
  if (!apiKey) {
    throw new PipelineError('XAI_API_KEY not set', 'pipeline_direction_no_key');
  }

  const researchData = (checkpoint['research'] as { research?: { facts?: string[] } } | undefined)
    ?.research;
  const facts: string[] = researchData?.facts ?? [];

  const outfitKey = 'sari_traditional';
  const outfit = OUTFIT_LIBRARY[outfitKey] ?? OUTFIT_LIBRARY['default_casual'] ?? '';
  const novaBlock = NOVA_CHARACTER_DNA.replace('{{OUTFIT}}', outfit);
  const prompt = buildDirectorPrompt(run.topic, facts, novaBlock);

  log.debug({ runId: run.id, factCount: facts.length }, 'Calling Grok for director plan');

  let plan: DirectorPlan;
  try {
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'grok-3',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.9,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new PipelineError(
        `Grok director call failed: ${response.status} ${body.slice(0, 200)}`,
        'pipeline_direction_llm_error',
        { status: response.status },
      );
    }

    const json = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    const content = json.choices[0]?.message?.content ?? '';
    const parsed: unknown = JSON.parse(content);
    plan = validateDirectorPlan(parsed);
  } catch (err) {
    if (err instanceof PipelineError) throw err;
    throw new PipelineError(
      `Direction stage failed: ${String(err)}`,
      'pipeline_direction_llm_error',
    );
  }

  log.info({ runId: run.id, title: plan.title, scenes: plan.scenes.length }, 'Direction stage complete');

  return { plan, costUsd: 0.015 };
}
