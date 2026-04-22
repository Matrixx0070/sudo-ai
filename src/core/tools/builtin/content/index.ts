/**
 * Content & Communication toolkit — 12 LLM-powered tools registered into the
 * ToolRegistry.
 *
 * Each tool validates its required parameters, constructs an expert prompt, and
 * returns that prompt as `output`.  The agent loop feeds the output back through
 * the Brain, which produces the final content.  No direct Brain dependency is
 * needed here, keeping the module free of circular imports.
 *
 * Tools registered:
 *   content.write-article         — Long-form articles / blog posts with SEO
 *   content.write-copy            — Marketing copy, ads, product descriptions
 *   content.write-email-sequence  — Drip email campaigns with A/B variants
 *   content.write-script          — Video / podcast / presentation scripts
 *   content.write-social-post     — Platform-optimised social media posts
 *   content.rewrite               — Rewrite / paraphrase with style control
 *   content.summarize             — Summarise documents / meetings to key points
 *   content.proofread             — Grammar, spelling, and style suggestions
 *   content.seo-content-optimizer — Optimise content for target keywords
 *   content.presentation-builder  — Slide deck outlines from topic / notes
 *   comms.email-responder         — Auto-draft email replies matching tone
 *   comms.meeting-transcriber     — Transcribe and summarise meetings
 */

import type { ToolRegistry } from '../../registry.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger('content-builtin');

// ---------------------------------------------------------------------------
// content.write-article
// ---------------------------------------------------------------------------

const writeArticleTool: ToolDefinition = {
  name: 'content.write-article',
  description:
    'Generate a long-form article or blog post on any topic with SEO optimisation. '
    + 'Returns a complete, publication-ready article.',
  category: 'content',
  timeout: 60_000,
  parameters: {
    topic: { type: 'string', required: true, description: 'The topic or title to write about.' },
    style: {
      type: 'string',
      description: 'Writing style.',
      enum: ['professional', 'casual', 'academic', 'conversational', 'storytelling'],
      default: 'professional',
    },
    length: {
      type: 'string',
      description: 'Target length: short (~500 w), medium (~1000 w), long (~2000+ w).',
      enum: ['short', 'medium', 'long'],
      default: 'medium',
    },
    keywords: { type: 'string', description: 'Comma-separated SEO keywords to weave in naturally.' },
    audience: { type: 'string', description: 'Description of the target audience.' },
    outline: { type: 'string', description: 'Optional heading outline to follow.' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const topic = params['topic'] as string | undefined;
    logger.info({ session: ctx.sessionId, topic }, 'content.write-article invoked');

    if (!topic?.trim()) {
      return { success: false, output: 'topic is required.' };
    }

    try {
      const style    = (params['style']    as string | undefined) ?? 'professional';
      const length   = (params['length']   as string | undefined) ?? 'medium';
      const keywords = (params['keywords'] as string | undefined) ?? '';
      const audience = (params['audience'] as string | undefined) ?? 'general readers';
      const outline  = (params['outline']  as string | undefined) ?? '';

      const lengthGuide: Record<string, string> = {
        short: '400–600 words',
        medium: '900–1 100 words',
        long: '1 800–2 500 words',
      };

      const prompt = [
        `You are an expert content writer and SEO specialist.`,
        `Write a complete ${style} article of ${lengthGuide[length] ?? '900–1 100 words'} on the following topic:`,
        `TOPIC: ${topic}`,
        audience ? `TARGET AUDIENCE: ${audience}` : '',
        keywords ? `SEO KEYWORDS (weave in naturally, do not stuff): ${keywords}` : '',
        outline ? `OUTLINE TO FOLLOW:\n${outline}` : '',
        ``,
        `Requirements:`,
        `- Compelling headline followed by a strong opening hook`,
        `- Clear subheadings (H2/H3) for scannability`,
        `- Practical, actionable content backed by reasoning`,
        `- Natural keyword integration for SEO`,
        `- Concluding call-to-action paragraph`,
        `- Markdown formatting`,
      ].filter(Boolean).join('\n');

      return {
        success: true,
        output: prompt,
        data: { topic, style, length, keywords, audience },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ topic, err: msg }, 'content.write-article error');
      return { success: false, output: `write-article error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// content.write-copy
// ---------------------------------------------------------------------------

const writeCopyTool: ToolDefinition = {
  name: 'content.write-copy',
  description:
    'Generate high-converting marketing copy: ad text, product descriptions, landing page copy, taglines.',
  category: 'content',
  timeout: 45_000,
  parameters: {
    product: { type: 'string', required: true, description: 'Product, service, or offer being promoted.' },
    copyType: {
      type: 'string',
      required: true,
      description: 'Type of copy to produce.',
      enum: ['ad', 'product-description', 'landing-page', 'tagline', 'email-subject', 'cta'],
    },
    tone: {
      type: 'string',
      description: 'Desired tone.',
      enum: ['urgent', 'inspiring', 'friendly', 'luxury', 'playful', 'authoritative'],
      default: 'inspiring',
    },
    audience: { type: 'string', description: 'Target audience persona.' },
    usp: { type: 'string', description: 'Unique selling proposition or key benefit.' },
    wordLimit: { type: 'number', description: 'Maximum word count for the copy.', default: 150 },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const product = params['product'] as string | undefined;
    const copyType = params['copyType'] as string | undefined;
    logger.info({ session: ctx.sessionId, product, copyType }, 'content.write-copy invoked');

    if (!product?.trim()) return { success: false, output: 'product is required.' };
    if (!copyType?.trim()) return { success: false, output: 'copyType is required.' };

    try {
      const tone      = (params['tone']      as string | undefined) ?? 'inspiring';
      const audience  = (params['audience']  as string | undefined) ?? 'general consumers';
      const usp       = (params['usp']       as string | undefined) ?? '';
      const wordLimit = (params['wordLimit'] as number | undefined) ?? 150;

      const prompt = [
        `You are an expert direct-response copywriter.`,
        `Write ${copyType} copy for the following product/service:`,
        `PRODUCT/SERVICE: ${product}`,
        `TONE: ${tone}`,
        `TARGET AUDIENCE: ${audience}`,
        usp ? `UNIQUE SELLING PROPOSITION: ${usp}` : '',
        `WORD LIMIT: ${wordLimit} words maximum`,
        ``,
        `Requirements:`,
        `- Open with a powerful hook that speaks to the audience's pain point or desire`,
        `- Highlight the core benefit clearly and immediately`,
        `- Use persuasive language appropriate for ${tone} tone`,
        `- Include a clear call-to-action`,
        `- Output only the final copy text, ready to publish`,
      ].filter(Boolean).join('\n');

      return {
        success: true,
        output: prompt,
        data: { product, copyType, tone, audience },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ product, copyType, err: msg }, 'content.write-copy error');
      return { success: false, output: `write-copy error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// content.write-email-sequence
// ---------------------------------------------------------------------------

const writeEmailSequenceTool: ToolDefinition = {
  name: 'content.write-email-sequence',
  description:
    'Write a complete drip email campaign sequence with optional A/B subject-line variants.',
  category: 'content',
  timeout: 90_000,
  parameters: {
    goal: { type: 'string', required: true, description: 'Campaign goal, e.g. "onboard new SaaS users", "nurture leads".' },
    emailCount: { type: 'number', description: 'Number of emails in the sequence (1–10).', default: 3 },
    product: { type: 'string', description: 'Product or service being promoted.' },
    audience: { type: 'string', description: 'Subscriber persona description.' },
    abVariants: { type: 'boolean', description: 'Generate A/B subject line variants for each email.', default: false },
    tone: {
      type: 'string',
      description: 'Email tone.',
      enum: ['professional', 'friendly', 'urgent', 'storytelling'],
      default: 'friendly',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const goal = params['goal'] as string | undefined;
    logger.info({ session: ctx.sessionId, goal }, 'content.write-email-sequence invoked');

    if (!goal?.trim()) return { success: false, output: 'goal is required.' };

    try {
      const emailCount = Math.min(10, Math.max(1, (params['emailCount'] as number | undefined) ?? 3));
      const product    = (params['product']    as string | undefined) ?? '';
      const audience   = (params['audience']   as string | undefined) ?? 'subscribers';
      const abVariants = (params['abVariants'] as boolean | undefined) ?? false;
      const tone       = (params['tone']       as string | undefined) ?? 'friendly';

      const prompt = [
        `You are an expert email marketing strategist and copywriter.`,
        `Write a ${emailCount}-email drip campaign sequence.`,
        `GOAL: ${goal}`,
        product  ? `PRODUCT/SERVICE: ${product}` : '',
        `AUDIENCE: ${audience}`,
        `TONE: ${tone}`,
        abVariants ? `Include two A/B subject line variants (Subject A / Subject B) for each email.` : '',
        ``,
        `For each email provide:`,
        `1. Email number and recommended send timing (e.g., "Day 0 — Immediately after sign-up")`,
        `2. Subject line${abVariants ? ' A and Subject line B' : ''}`,
        `3. Preview text (90 characters max)`,
        `4. Full email body with greeting, body paragraphs, and CTA`,
        `5. CTA button text`,
        ``,
        `Separate each email with a horizontal rule (---).`,
      ].filter(Boolean).join('\n');

      return {
        success: true,
        output: prompt,
        data: { goal, emailCount, product, audience, tone, abVariants },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ goal, err: msg }, 'content.write-email-sequence error');
      return { success: false, output: `write-email-sequence error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// content.write-script
// ---------------------------------------------------------------------------

const writeScriptTool: ToolDefinition = {
  name: 'content.write-script',
  description:
    'Write a video, podcast, or presentation script with timing markers and speaker cues.',
  category: 'content',
  timeout: 90_000,
  parameters: {
    topic: { type: 'string', required: true, description: 'Topic or title of the script.' },
    scriptType: {
      type: 'string',
      required: true,
      description: 'Type of script.',
      enum: ['youtube', 'podcast', 'presentation', 'ad-spot', 'explainer'],
    },
    duration: { type: 'string', description: 'Target duration, e.g. "5 minutes", "30 seconds".', default: '5 minutes' },
    audience: { type: 'string', description: 'Target audience.' },
    keyPoints: { type: 'string', description: 'Comma-separated key points to cover.' },
    tone: {
      type: 'string',
      description: 'Delivery tone.',
      enum: ['educational', 'entertaining', 'inspirational', 'conversational', 'formal'],
      default: 'conversational',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const topic      = params['topic']      as string | undefined;
    const scriptType = params['scriptType'] as string | undefined;
    logger.info({ session: ctx.sessionId, topic, scriptType }, 'content.write-script invoked');

    if (!topic?.trim())      return { success: false, output: 'topic is required.' };
    if (!scriptType?.trim()) return { success: false, output: 'scriptType is required.' };

    try {
      const duration  = (params['duration']  as string | undefined) ?? '5 minutes';
      const audience  = (params['audience']  as string | undefined) ?? 'general audience';
      const keyPoints = (params['keyPoints'] as string | undefined) ?? '';
      const tone      = (params['tone']      as string | undefined) ?? 'conversational';

      const prompt = [
        `You are a professional ${scriptType} scriptwriter.`,
        `Write a complete, ready-to-record ${scriptType} script on the following topic:`,
        `TOPIC: ${topic}`,
        `TARGET DURATION: ${duration}`,
        `AUDIENCE: ${audience}`,
        `TONE: ${tone}`,
        keyPoints ? `KEY POINTS TO COVER: ${keyPoints}` : '',
        ``,
        `Script format requirements:`,
        `- [INTRO] hook that grabs attention within the first 5 seconds`,
        `- Timing markers at each section: [0:00], [0:30], [1:00], etc.`,
        `- Speaker directions in square brackets: [pause], [show graphic], [cut to B-roll]`,
        `- Natural spoken-word language (contractions, short sentences)`,
        `- [OUTRO] with clear call-to-action`,
        `- Estimated word count at the end`,
      ].filter(Boolean).join('\n');

      return {
        success: true,
        output: prompt,
        data: { topic, scriptType, duration, audience, tone },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ topic, scriptType, err: msg }, 'content.write-script error');
      return { success: false, output: `write-script error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// content.write-social-post
// ---------------------------------------------------------------------------

const writeSocialPostTool: ToolDefinition = {
  name: 'content.write-social-post',
  description:
    'Generate platform-optimised social media posts: Twitter/X threads, LinkedIn articles, Instagram captions, Facebook posts.',
  category: 'content',
  timeout: 45_000,
  parameters: {
    topic: { type: 'string', required: true, description: 'Topic or message for the post.' },
    platform: {
      type: 'string',
      required: true,
      description: 'Target social platform.',
      enum: ['twitter', 'linkedin', 'instagram', 'facebook', 'tiktok'],
    },
    goal: {
      type: 'string',
      description: 'Content goal.',
      enum: ['awareness', 'engagement', 'lead-gen', 'sales', 'education'],
      default: 'engagement',
    },
    tone: { type: 'string', description: 'Post tone: professional, casual, witty, inspirational.', default: 'casual' },
    hashtags: { type: 'boolean', description: 'Include relevant hashtags.', default: true },
    threadCount: { type: 'number', description: 'Number of tweets for Twitter thread (1–20).', default: 1 },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const topic    = params['topic']    as string | undefined;
    const platform = params['platform'] as string | undefined;
    logger.info({ session: ctx.sessionId, topic, platform }, 'content.write-social-post invoked');

    if (!topic?.trim())    return { success: false, output: 'topic is required.' };
    if (!platform?.trim()) return { success: false, output: 'platform is required.' };

    try {
      const goal        = (params['goal']        as string  | undefined) ?? 'engagement';
      const tone        = (params['tone']        as string  | undefined) ?? 'casual';
      const hashtags    = (params['hashtags']    as boolean | undefined) ?? true;
      const threadCount = Math.min(20, Math.max(1, (params['threadCount'] as number | undefined) ?? 1));

      const platformNotes: Record<string, string> = {
        twitter:   `${threadCount > 1 ? `${threadCount}-tweet thread` : 'single tweet'}, max 280 chars per tweet, punchy and direct`,
        linkedin:  'professional tone, 150–300 words, personal story angle, no excessive emojis',
        instagram: 'caption up to 2 200 chars, emoji-friendly, strong opening line, aesthetic language',
        facebook:  'conversational, up to 500 words, community-focused, encourage comments',
        tiktok:    'trend-aware, short punchy hooks, 150 chars max, call to duet/stitch',
      };

      const prompt = [
        `You are a social media content strategist expert in ${platform} content.`,
        `Create a ${goal}-focused ${platform} post on this topic:`,
        `TOPIC: ${topic}`,
        `TONE: ${tone}`,
        `PLATFORM REQUIREMENTS: ${platformNotes[platform] ?? platform}`,
        hashtags ? `Include 3–7 relevant hashtags at the end.` : 'Do not include hashtags.',
        ``,
        `Output only the final post text, ready to copy-paste and publish.`,
      ].filter(Boolean).join('\n');

      return {
        success: true,
        output: prompt,
        data: { topic, platform, goal, tone, threadCount },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ topic, platform, err: msg }, 'content.write-social-post error');
      return { success: false, output: `write-social-post error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// content.rewrite
// ---------------------------------------------------------------------------

const rewriteTool: ToolDefinition = {
  name: 'content.rewrite',
  description:
    'Rewrite or paraphrase any text with full control over tone, style, reading level, and audience.',
  category: 'content',
  timeout: 60_000,
  parameters: {
    text: { type: 'string', required: true, description: 'The original text to rewrite.' },
    instruction: {
      type: 'string',
      description: 'Specific rewrite instruction, e.g. "make it more concise", "formal tone", "simplify for beginners".',
      default: 'improve clarity and flow',
    },
    tone: {
      type: 'string',
      description: 'Target tone.',
      enum: ['formal', 'casual', 'persuasive', 'empathetic', 'confident', 'neutral'],
      default: 'neutral',
    },
    audience: { type: 'string', description: 'Target audience for the rewritten text.' },
    preserveLength: { type: 'boolean', description: 'Keep the rewritten text approximately the same length.', default: true },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const text = params['text'] as string | undefined;
    logger.info({ session: ctx.sessionId, chars: text?.length }, 'content.rewrite invoked');

    if (!text?.trim()) return { success: false, output: 'text is required.' };

    try {
      const instruction     = (params['instruction']     as string  | undefined) ?? 'improve clarity and flow';
      const tone            = (params['tone']            as string  | undefined) ?? 'neutral';
      const audience        = (params['audience']        as string  | undefined) ?? '';
      const preserveLength  = (params['preserveLength']  as boolean | undefined) ?? true;

      const prompt = [
        `You are an expert editor and writing coach.`,
        `Rewrite the following text according to these instructions:`,
        `INSTRUCTION: ${instruction}`,
        `TARGET TONE: ${tone}`,
        audience ? `TARGET AUDIENCE: ${audience}` : '',
        preserveLength ? 'Keep the output approximately the same length as the original.' : '',
        ``,
        `ORIGINAL TEXT:`,
        `---`,
        text,
        `---`,
        ``,
        `Output only the rewritten text. Do not add commentary or explanations.`,
      ].filter(Boolean).join('\n');

      return {
        success: true,
        output: prompt,
        data: { chars: text.length, instruction, tone, audience },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'content.rewrite error');
      return { success: false, output: `rewrite error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// content.summarize
// ---------------------------------------------------------------------------

const summarizeTool: ToolDefinition = {
  name: 'content.summarize',
  description:
    'Summarise any document, article, or meeting transcript into structured key points, TL;DR, or executive summary.',
  category: 'content',
  timeout: 60_000,
  parameters: {
    text: { type: 'string', required: true, description: 'The full text to summarise.' },
    format: {
      type: 'string',
      description: 'Summary format.',
      enum: ['tldr', 'bullet-points', 'executive-summary', 'key-takeaways', 'one-paragraph'],
      default: 'bullet-points',
    },
    maxPoints: { type: 'number', description: 'Maximum number of bullet points or takeaways (3–20).', default: 7 },
    audience: { type: 'string', description: 'Who will read the summary.' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const text = params['text'] as string | undefined;
    logger.info({ session: ctx.sessionId, chars: text?.length }, 'content.summarize invoked');

    if (!text?.trim()) return { success: false, output: 'text is required.' };

    try {
      const format    = (params['format']    as string | undefined) ?? 'bullet-points';
      const maxPoints = Math.min(20, Math.max(3, (params['maxPoints'] as number | undefined) ?? 7));
      const audience  = (params['audience']  as string | undefined) ?? '';

      const formatInstructions: Record<string, string> = {
        'tldr':              'Write a single TL;DR sentence (max 30 words) followed by 2–3 supporting sentences.',
        'bullet-points':     `Extract exactly ${maxPoints} key bullet points. Each point: one clear sentence.`,
        'executive-summary': `Write a structured executive summary: Overview, Key Findings (${maxPoints} max), Recommendations.`,
        'key-takeaways':     `List the ${maxPoints} most actionable takeaways numbered 1 to ${maxPoints}.`,
        'one-paragraph':     'Condense into one coherent paragraph of 80–120 words.',
      };

      const prompt = [
        `You are an expert analyst and summariser.`,
        audience ? `The summary is for: ${audience}.` : '',
        formatInstructions[format] ?? `Summarise in ${format} format.`,
        ``,
        `TEXT TO SUMMARISE:`,
        `---`,
        text,
        `---`,
        ``,
        `Output only the summary. No preamble.`,
      ].filter(Boolean).join('\n');

      return {
        success: true,
        output: prompt,
        data: { chars: text.length, format, maxPoints, audience },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'content.summarize error');
      return { success: false, output: `summarize error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// content.proofread
// ---------------------------------------------------------------------------

const proofreadTool: ToolDefinition = {
  name: 'content.proofread',
  description:
    'Check text for grammar, spelling, punctuation, and style issues. Returns annotated corrections and a clean revised version.',
  category: 'content',
  timeout: 60_000,
  parameters: {
    text: { type: 'string', required: true, description: 'The text to proofread.' },
    level: {
      type: 'string',
      description: 'Depth of review.',
      enum: ['grammar-only', 'standard', 'deep'],
      default: 'standard',
    },
    style: {
      type: 'string',
      description: 'Style guide to apply.',
      enum: ['ap', 'chicago', 'mla', 'british-english', 'american-english', 'none'],
      default: 'none',
    },
    returnCorrected: { type: 'boolean', description: 'Return a fully corrected version after the error list.', default: true },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const text = params['text'] as string | undefined;
    logger.info({ session: ctx.sessionId, chars: text?.length }, 'content.proofread invoked');

    if (!text?.trim()) return { success: false, output: 'text is required.' };

    try {
      const level           = (params['level']           as string  | undefined) ?? 'standard';
      const style           = (params['style']           as string  | undefined) ?? 'none';
      const returnCorrected = (params['returnCorrected'] as boolean | undefined) ?? true;

      const levelDesc: Record<string, string> = {
        'grammar-only': 'Fix only grammar, spelling, and punctuation errors.',
        'standard':     'Fix grammar, spelling, punctuation, word choice, and sentence clarity.',
        'deep':         'Fix grammar, spelling, punctuation, word choice, clarity, flow, tone consistency, and style.',
      };

      const prompt = [
        `You are a professional editor and proofreader.`,
        levelDesc[level] ?? 'Proofread the following text.',
        style !== 'none' ? `Apply ${style.toUpperCase()} style guide conventions.` : '',
        ``,
        `For each issue found, list it as:`,
        `- [TYPE] "original text" → "corrected text" — reason`,
        ``,
        returnCorrected
          ? `After the error list, output a section headed "## CORRECTED VERSION" with the fully revised text.`
          : '',
        ``,
        `TEXT TO PROOFREAD:`,
        `---`,
        text,
        `---`,
      ].filter(Boolean).join('\n');

      return {
        success: true,
        output: prompt,
        data: { chars: text.length, level, style, returnCorrected },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'content.proofread error');
      return { success: false, output: `proofread error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// content.seo-content-optimizer
// ---------------------------------------------------------------------------

const seoOptimizerTool: ToolDefinition = {
  name: 'content.seo-content-optimizer',
  description:
    'Analyse and optimise existing content for target keywords, search intent, and on-page SEO best practices.',
  category: 'content',
  timeout: 60_000,
  parameters: {
    content: { type: 'string', required: true, description: 'The existing content to optimise.' },
    primaryKeyword: { type: 'string', required: true, description: 'Main target keyword or keyphrase.' },
    secondaryKeywords: { type: 'string', description: 'Comma-separated secondary / LSI keywords.' },
    searchIntent: {
      type: 'string',
      description: 'Searcher intent for the primary keyword.',
      enum: ['informational', 'commercial', 'transactional', 'navigational'],
      default: 'informational',
    },
    outputMode: {
      type: 'string',
      description: 'What to return.',
      enum: ['analysis-only', 'optimised-content', 'both'],
      default: 'both',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const content        = params['content']        as string | undefined;
    const primaryKeyword = params['primaryKeyword'] as string | undefined;
    logger.info({ session: ctx.sessionId, primaryKeyword }, 'content.seo-content-optimizer invoked');

    if (!content?.trim())        return { success: false, output: 'content is required.' };
    if (!primaryKeyword?.trim()) return { success: false, output: 'primaryKeyword is required.' };

    try {
      const secondaryKeywords = (params['secondaryKeywords'] as string | undefined) ?? '';
      const searchIntent      = (params['searchIntent']      as string | undefined) ?? 'informational';
      const outputMode        = (params['outputMode']        as string | undefined) ?? 'both';

      const prompt = [
        `You are an expert SEO strategist and content optimiser.`,
        `PRIMARY KEYWORD: ${primaryKeyword}`,
        secondaryKeywords ? `SECONDARY / LSI KEYWORDS: ${secondaryKeywords}` : '',
        `SEARCH INTENT: ${searchIntent}`,
        ``,
        outputMode !== 'optimised-content'
          ? [
              `## SEO ANALYSIS`,
              `Evaluate the content against these criteria:`,
              `1. Keyword density and placement (title, H1, first 100 words, subheadings, conclusion)`,
              `2. Title tag and meta description recommendations`,
              `3. Internal linking opportunities`,
              `4. Content gaps vs. search intent`,
              `5. Readability score estimate (Flesch–Kincaid)`,
              `6. Overall SEO score /100 with top 3 improvements`,
            ].join('\n')
          : '',
        outputMode !== 'analysis-only'
          ? '\n## OPTIMISED CONTENT\nRewrite the content incorporating all SEO improvements naturally.'
          : '',
        ``,
        `CONTENT TO OPTIMISE:`,
        `---`,
        content,
        `---`,
      ].filter(Boolean).join('\n');

      return {
        success: true,
        output: prompt,
        data: { chars: content.length, primaryKeyword, secondaryKeywords, searchIntent, outputMode },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ primaryKeyword, err: msg }, 'content.seo-content-optimizer error');
      return { success: false, output: `seo-content-optimizer error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// content.presentation-builder
// ---------------------------------------------------------------------------

const presentationBuilderTool: ToolDefinition = {
  name: 'content.presentation-builder',
  description:
    'Create a structured slide deck outline from a topic or rough notes, including slide titles, key points, and speaker notes.',
  category: 'content',
  timeout: 60_000,
  parameters: {
    topic: { type: 'string', required: true, description: 'Presentation topic or title.' },
    slideCount: { type: 'number', description: 'Target number of slides (5–30).', default: 10 },
    audience: { type: 'string', description: 'Audience for the presentation.' },
    notes: { type: 'string', description: 'Raw notes or bullet points to incorporate.' },
    includeDesignTips: { type: 'boolean', description: 'Add design and visual suggestions per slide.', default: false },
    style: {
      type: 'string',
      description: 'Presentation style.',
      enum: ['corporate', 'educational', 'pitch-deck', 'keynote', 'workshop'],
      default: 'corporate',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const topic = params['topic'] as string | undefined;
    logger.info({ session: ctx.sessionId, topic }, 'content.presentation-builder invoked');

    if (!topic?.trim()) return { success: false, output: 'topic is required.' };

    try {
      const slideCount         = Math.min(30, Math.max(5, (params['slideCount'] as number | undefined) ?? 10));
      const audience           = (params['audience']           as string  | undefined) ?? 'general audience';
      const notes              = (params['notes']              as string  | undefined) ?? '';
      const includeDesignTips  = (params['includeDesignTips']  as boolean | undefined) ?? false;
      const style              = (params['style']              as string  | undefined) ?? 'corporate';

      const prompt = [
        `You are a professional presentation designer and communication expert.`,
        `Create a complete ${style} slide deck outline with exactly ${slideCount} slides.`,
        `TOPIC: ${topic}`,
        `AUDIENCE: ${audience}`,
        notes ? `RAW NOTES TO INCORPORATE:\n${notes}` : '',
        ``,
        `For each slide provide:`,
        `**Slide N: [Title]**`,
        `- Key point 1`,
        `- Key point 2 (max 4 bullets per slide, each ≤ 12 words)`,
        `Speaker notes: [2–3 sentences the presenter would say]`,
        includeDesignTips ? `Design tip: [visual/layout suggestion]` : '',
        ``,
        `Include: title slide, agenda slide, content slides, and a closing/CTA slide.`,
      ].filter(Boolean).join('\n');

      return {
        success: true,
        output: prompt,
        data: { topic, slideCount, audience, style, includeDesignTips },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ topic, err: msg }, 'content.presentation-builder error');
      return { success: false, output: `presentation-builder error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// comms.email-responder
// ---------------------------------------------------------------------------

const emailResponderTool: ToolDefinition = {
  name: 'comms.email-responder',
  description:
    'Auto-draft a contextually appropriate email reply that matches the original sender\'s tone and intent.',
  category: 'comms',
  timeout: 45_000,
  parameters: {
    originalEmail: { type: 'string', required: true, description: 'The full text of the email to reply to.' },
    replyIntent: { type: 'string', required: true, description: 'What you want the reply to accomplish, e.g. "decline politely", "confirm meeting", "request more info".' },
    senderName: { type: 'string', description: 'Name of the person you are replying to.' },
    yourName: { type: 'string', description: 'Your name for the sign-off.' },
    tone: {
      type: 'string',
      description: 'Desired reply tone.',
      enum: ['professional', 'friendly', 'concise', 'formal', 'empathetic'],
      default: 'professional',
    },
    additionalContext: { type: 'string', description: 'Any additional context or facts to include in the reply.' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const originalEmail = params['originalEmail'] as string | undefined;
    const replyIntent   = params['replyIntent']   as string | undefined;
    logger.info({ session: ctx.sessionId, replyIntent }, 'comms.email-responder invoked');

    if (!originalEmail?.trim()) return { success: false, output: 'originalEmail is required.' };
    if (!replyIntent?.trim())   return { success: false, output: 'replyIntent is required.' };

    try {
      const senderName        = (params['senderName']        as string | undefined) ?? '';
      const yourName          = (params['yourName']          as string | undefined) ?? '';
      const tone              = (params['tone']              as string | undefined) ?? 'professional';
      const additionalContext = (params['additionalContext'] as string | undefined) ?? '';

      const prompt = [
        `You are an expert business communicator.`,
        `Draft a ${tone} email reply with the following intent:`,
        `REPLY INTENT: ${replyIntent}`,
        senderName        ? `RECIPIENT NAME: ${senderName}` : '',
        yourName          ? `YOUR NAME (sign-off): ${yourName}` : '',
        additionalContext ? `ADDITIONAL CONTEXT: ${additionalContext}` : '',
        ``,
        `ORIGINAL EMAIL:`,
        `---`,
        originalEmail,
        `---`,
        ``,
        `Requirements:`,
        `- Match and mirror the original email's formality level`,
        `- Address all questions or action items from the original`,
        `- Keep it concise (under 200 words unless more is needed)`,
        `- Output only the email reply text with Subject, greeting, body, and sign-off`,
      ].filter(Boolean).join('\n');

      return {
        success: true,
        output: prompt,
        data: { replyIntent, tone, senderName },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ replyIntent, err: msg }, 'comms.email-responder error');
      return { success: false, output: `email-responder error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// comms.meeting-transcriber
// ---------------------------------------------------------------------------

const meetingTranscriberTool: ToolDefinition = {
  name: 'comms.meeting-transcriber',
  description:
    'Summarise a meeting transcript into structured minutes: attendees, decisions, action items with owners, and next steps.',
  category: 'comms',
  timeout: 90_000,
  parameters: {
    transcript: { type: 'string', required: true, description: 'Raw meeting transcript text.' },
    meetingTitle: { type: 'string', description: 'Title or subject of the meeting.' },
    date: { type: 'string', description: 'Meeting date (YYYY-MM-DD).' },
    outputFormat: {
      type: 'string',
      description: 'Output format.',
      enum: ['minutes', 'action-items-only', 'summary-and-actions', 'full-report'],
      default: 'summary-and-actions',
    },
    extractSentiment: { type: 'boolean', description: 'Include tone/sentiment analysis per topic.', default: false },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const transcript = params['transcript'] as string | undefined;
    logger.info({ session: ctx.sessionId, chars: transcript?.length }, 'comms.meeting-transcriber invoked');

    if (!transcript?.trim()) return { success: false, output: 'transcript is required.' };

    try {
      const meetingTitle      = (params['meetingTitle']      as string  | undefined) ?? 'Meeting';
      const date              = (params['date']              as string  | undefined) ?? new Date().toISOString().slice(0, 10);
      const outputFormat      = (params['outputFormat']      as string  | undefined) ?? 'summary-and-actions';
      const extractSentiment  = (params['extractSentiment']  as boolean | undefined) ?? false;

      const formatSections: Record<string, string[]> = {
        'minutes': [
          '## Meeting Minutes',
          '- Date, time, and attendees list',
          '- Agenda items discussed',
          '- Decisions made (each as a bullet)',
          '- Action items table: | Action | Owner | Due Date |',
          '- Next meeting date if mentioned',
        ],
        'action-items-only': [
          '## Action Items',
          'List every action item as: "[ ] {action} — Owner: {name} — Due: {date or TBD}"',
        ],
        'summary-and-actions': [
          '## Summary (3–5 sentences)',
          '## Key Decisions',
          '## Action Items table: | # | Action | Owner | Due Date | Priority |',
          '## Next Steps',
        ],
        'full-report': [
          '## Executive Summary',
          '## Attendees',
          '## Agenda & Discussion Points',
          '## Decisions Made',
          '## Action Items table',
          '## Risks & Blockers identified',
          '## Next Steps',
        ],
      };

      const sections = formatSections[outputFormat] ?? formatSections['summary-and-actions'];

      const prompt = [
        `You are an expert meeting facilitator and minute-taker.`,
        `Produce structured ${outputFormat.replace(/-/g, ' ')} for the following meeting:`,
        `MEETING: ${meetingTitle}`,
        `DATE: ${date}`,
        extractSentiment ? 'Include a brief sentiment/tone note for each major discussion topic.' : '',
        ``,
        `Required sections:`,
        ...sections,
        ``,
        `TRANSCRIPT:`,
        `---`,
        transcript,
        `---`,
        ``,
        `Output only the structured document in Markdown.`,
      ].filter(Boolean).join('\n');

      return {
        success: true,
        output: prompt,
        data: { chars: transcript.length, meetingTitle, date, outputFormat, extractSentiment },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'comms.meeting-transcriber error');
      return { success: false, output: `meeting-transcriber error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const CONTENT_TOOLS: ToolDefinition[] = [
  writeArticleTool,
  writeCopyTool,
  writeEmailSequenceTool,
  writeScriptTool,
  writeSocialPostTool,
  rewriteTool,
  summarizeTool,
  proofreadTool,
  seoOptimizerTool,
  presentationBuilderTool,
  emailResponderTool,
  meetingTranscriberTool,
];

/**
 * Register all content and communication tools with the given registry.
 * Called automatically by the built-in tool loader.
 *
 * @param registry - The application's central {@link ToolRegistry}.
 */
export function registerContentTools(registry: ToolRegistry): void {
  logger.info({ count: CONTENT_TOOLS.length }, 'Registering content tools');
  for (const tool of CONTENT_TOOLS) {
    registry.register(tool);
  }
  logger.info({ count: CONTENT_TOOLS.length }, 'Content tools registered');
}
