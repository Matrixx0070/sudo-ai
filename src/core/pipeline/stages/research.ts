/**
 * Research stage — gathers story facts and background for the given topic.
 * Uses Grok to synthesise key narrative facts, emotional angles, and sources.
 */

import { createLogger } from '../../shared/logger.js';
import { PipelineError } from '../../shared/errors.js';
import { DEFAULT_MODEL } from '../../shared/constants.js';
import type { PipelineRun, ResearchData } from '../types.js';

const log = createLogger('pipeline:research');

const RESEARCH_SYSTEM_PROMPT = `You are a research analyst for a YouTube Shorts production team.
Given a story topic, extract the key facts, emotional hooks, and narrative angles that make this story compelling.
Return ONLY valid JSON matching: { "facts": string[], "summary": string, "sources": string[] }
Keep facts punchy, under 25 words each. Maximum 12 facts. Summary under 60 words.`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateResearchData(raw: unknown): ResearchData {
  if (typeof raw !== 'object' || raw === null) {
    throw new PipelineError('Research response is not an object', 'pipeline_research_invalid');
  }
  const obj = raw as Record<string, unknown>;

  if (!Array.isArray(obj['facts']) || obj['facts'].length === 0) {
    throw new PipelineError('Research response missing facts array', 'pipeline_research_invalid');
  }
  if (typeof obj['summary'] !== 'string' || obj['summary'].trim().length === 0) {
    throw new PipelineError('Research response missing summary', 'pipeline_research_invalid');
  }
  if (!Array.isArray(obj['sources'])) {
    obj['sources'] = [];
  }

  return {
    facts: (obj['facts'] as unknown[]).map(String),
    summary: String(obj['summary']).trim(),
    sources: (obj['sources'] as unknown[]).map(String),
  };
}

// ---------------------------------------------------------------------------
// Stage runner
// ---------------------------------------------------------------------------

export async function runResearch(
  run: PipelineRun,
  _checkpoint: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  log.info({ runId: run.id, topic: run.topic }, 'Research stage start');

  const { topic } = run;
  if (!topic || topic.trim().length === 0) {
    throw new PipelineError('Topic is empty — cannot run research', 'pipeline_research_no_topic');
  }

  const apiKey = process.env['XAI_API_KEY'] ?? process.env['OPENAI_API_KEY'];
  if (!apiKey) {
    throw new PipelineError(
      'No LLM API key found (XAI_API_KEY or OPENAI_API_KEY)',
      'pipeline_research_no_key',
    );
  }

  const userPrompt = `Topic: "${topic}"\n\nResearch this topic for a 30-second YouTube Shorts story. Extract facts that create emotional impact, curiosity, and narrative tension.`;

  log.debug({ runId: run.id, model: DEFAULT_MODEL }, 'Calling LLM for research');

  let researchData: ResearchData;
  try {
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'grok-3-fast',
        messages: [
          { role: 'system', content: RESEARCH_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.7,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new PipelineError(
        `LLM request failed: ${response.status} ${body.slice(0, 200)}`,
        'pipeline_research_llm_error',
        { status: response.status },
      );
    }

    const json = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    const content = json.choices[0]?.message?.content ?? '';
    const parsed: unknown = JSON.parse(content);
    researchData = validateResearchData(parsed);
  } catch (err) {
    if (err instanceof PipelineError) throw err;
    throw new PipelineError(
      `Research LLM call failed: ${String(err)}`,
      'pipeline_research_llm_error',
    );
  }

  log.info(
    { runId: run.id, factCount: researchData.facts.length },
    'Research stage complete',
  );

  return {
    research: researchData,
    costUsd: 0.001, // estimated; replace with actual token accounting
  };
}
