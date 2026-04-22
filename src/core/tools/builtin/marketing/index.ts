/**
 * Marketing toolkit — registers 6 marketing tools into the ToolRegistry.
 *
 * All tools are LLM-powered via ctx.config.brain and return structured
 * marketing artefacts (reports, ad copy, calendars, competitor analyses).
 *
 * Tools registered:
 *   marketing.seo-audit         — Full site SEO audit with fix recommendations
 *   marketing.keyword-research  — Find keywords by volume, difficulty, intent
 *   marketing.ad-campaign-builder — Create ad campaigns with copy + targeting
 *   marketing.ad-copy-generator  — Generate A/B ad copy variants
 *   marketing.competitor-analysis — Deep competitor analysis
 *   marketing.content-calendar   — Plan content publishing calendar
 */

import type { ToolRegistry } from '../../registry.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger('marketing-builtin');

// ---------------------------------------------------------------------------
// Shared LLM helper
// ---------------------------------------------------------------------------

interface BrainLike {
  chat(messages: Array<{ role: string; content: string }>): Promise<{ content: string }>;
}

interface ConfigLike {
  brain?: BrainLike;
}

async function askBrain(ctx: ToolContext, system: string, user: string): Promise<string> {
  const config = ctx.config as ConfigLike | undefined;
  if (!config?.brain) {
    throw new Error('Brain (LLM) is not available. Ensure the brain module is configured.');
  }
  const response = await config.brain.chat([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]);
  return response.content.trim();
}

// ---------------------------------------------------------------------------
// marketing.seo-audit
// ---------------------------------------------------------------------------

const seoAuditTool: ToolDefinition = {
  name: 'marketing.seo-audit',
  description:
    'Perform a full SEO audit for a website URL or page description. Returns on-page issues, technical recommendations, content gaps, and a prioritised fix list.',
  category: 'marketing',
  timeout: 60_000,
  parameters: {
    url: { type: 'string', required: true, description: 'Website URL or page to audit (e.g. https://example.com).' },
    context: { type: 'string', description: 'Optional extra context about the site (industry, target audience, competitors).' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const url = params['url'] as string | undefined;
    const context = (params['context'] as string | undefined) ?? '';
    logger.info({ session: ctx.sessionId, url }, 'marketing.seo-audit invoked');

    if (!url?.trim()) return { success: false, output: 'url is required.' };

    try {
      const system = 'You are an expert SEO consultant with 10+ years of experience. Provide detailed, actionable audits.';
      const user = `Perform a comprehensive SEO audit for: ${url}
${context ? `Context: ${context}` : ''}

Structure your response with these sections:
1. TECHNICAL SEO (page speed, mobile, schema, crawlability issues)
2. ON-PAGE SEO (title tags, meta descriptions, headings, content quality)
3. CONTENT GAPS (missing topics, thin content, duplicate content)
4. BACKLINK PROFILE (authority estimation, link building opportunities)
5. PRIORITY FIX LIST (top 10 actions ranked by impact, format: Impact|Effort|Action)

Be specific with actionable recommendations.`;

      const output = await askBrain(ctx, system, user);
      logger.info({ url }, 'SEO audit complete');
      return { success: true, output, data: { url, auditLength: output.length } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ url, err: msg }, 'marketing.seo-audit error');
      return { success: false, output: `SEO audit error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// marketing.keyword-research
// ---------------------------------------------------------------------------

const keywordResearchTool: ToolDefinition = {
  name: 'marketing.keyword-research',
  description:
    'Research keywords for a topic or niche. Returns estimated search volume tiers, keyword difficulty, search intent, and long-tail variations.',
  category: 'marketing',
  timeout: 60_000,
  parameters: {
    topic: { type: 'string', required: true, description: 'Topic, niche, or seed keyword to research.' },
    industry: { type: 'string', description: 'Industry or vertical for context (e.g. SaaS, eCommerce, Health).' },
    count: { type: 'number', description: 'Number of keywords to return (default: 20).', default: 20 },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const topic = params['topic'] as string | undefined;
    const industry = (params['industry'] as string | undefined) ?? '';
    const count = Math.min(50, Math.max(5, (params['count'] as number | undefined) ?? 20));
    logger.info({ session: ctx.sessionId, topic }, 'marketing.keyword-research invoked');

    if (!topic?.trim()) return { success: false, output: 'topic is required.' };

    try {
      const system = 'You are an expert SEO keyword researcher. Provide data-driven keyword analysis with realistic estimations.';
      const user = `Research ${count} keywords for the topic: "${topic}"
${industry ? `Industry: ${industry}` : ''}

For each keyword provide:
- Keyword phrase
- Volume tier: [HIGH >10k/mo | MED 1k-10k | LOW 100-1k | NICHE <100]
- Difficulty: [EASY | MEDIUM | HARD | VERY HARD]
- Intent: [INFORMATIONAL | NAVIGATIONAL | COMMERCIAL | TRANSACTIONAL]
- Type: [HEAD | BODY | LONG-TAIL]

Format as a table. Then provide:
CONTENT IDEAS: 5 content pieces targeting the best opportunities
QUICK WINS: 3 low-difficulty, decent-volume keywords to target first`;

      const output = await askBrain(ctx, system, user);
      logger.info({ topic, count }, 'Keyword research complete');
      return { success: true, output, data: { topic, industry, requestedCount: count } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ topic, err: msg }, 'marketing.keyword-research error');
      return { success: false, output: `Keyword research error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// marketing.ad-campaign-builder
// ---------------------------------------------------------------------------

const adCampaignBuilderTool: ToolDefinition = {
  name: 'marketing.ad-campaign-builder',
  description:
    'Build a complete ad campaign for Google or Facebook/Meta. Returns campaign structure, targeting parameters, budget recommendations, and ad copy variants.',
  category: 'marketing',
  timeout: 60_000,
  parameters: {
    product: { type: 'string', required: true, description: 'Product or service to advertise.' },
    platform: { type: 'string', required: true, description: 'Ad platform.', enum: ['google', 'facebook', 'instagram', 'linkedin', 'tiktok'] },
    budget: { type: 'number', description: 'Monthly budget in USD (default: 1000).', default: 1000 },
    goal: { type: 'string', description: 'Campaign goal.', enum: ['awareness', 'traffic', 'leads', 'sales', 'app-installs'], default: 'leads' },
    audience: { type: 'string', description: 'Target audience description (age, interests, demographics).' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const product = params['product'] as string | undefined;
    const platform = (params['platform'] as string | undefined) ?? 'google';
    const budget = (params['budget'] as number | undefined) ?? 1000;
    const goal = (params['goal'] as string | undefined) ?? 'leads';
    const audience = (params['audience'] as string | undefined) ?? '';
    logger.info({ session: ctx.sessionId, product, platform }, 'marketing.ad-campaign-builder invoked');

    if (!product?.trim()) return { success: false, output: 'product is required.' };

    try {
      const system = `You are a senior digital marketing strategist specialising in ${platform} advertising.`;
      const user = `Build a complete ${platform} ad campaign for: "${product}"
Goal: ${goal} | Monthly Budget: $${budget}${audience ? ` | Audience: ${audience}` : ''}

Provide:
1. CAMPAIGN STRUCTURE (campaign → ad sets/groups → ads hierarchy)
2. TARGETING PARAMETERS (demographics, interests, behaviours, keywords if applicable)
3. BUDGET ALLOCATION (daily budget per ad set, bid strategy)
4. AD COPY VARIANTS (3 headline variants, 3 description variants, CTA options)
5. AUDIENCE SEGMENTS (2-3 audience segments with rationale)
6. SUCCESS METRICS (KPIs to track, target CPC/CPL/ROAS)`;

      const output = await askBrain(ctx, system, user);
      logger.info({ product, platform }, 'Ad campaign built');
      return { success: true, output, data: { product, platform, budget, goal } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ product, err: msg }, 'marketing.ad-campaign-builder error');
      return { success: false, output: `Ad campaign builder error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// marketing.ad-copy-generator
// ---------------------------------------------------------------------------

const adCopyGeneratorTool: ToolDefinition = {
  name: 'marketing.ad-copy-generator',
  description:
    'Generate A/B ad copy variants for any platform and format. Returns multiple headline, body, and CTA combinations ready to test.',
  category: 'marketing',
  timeout: 60_000,
  parameters: {
    product: { type: 'string', required: true, description: 'Product or service to write copy for.' },
    format: { type: 'string', required: true, description: 'Ad format.', enum: ['google-search', 'google-display', 'facebook-feed', 'instagram-story', 'linkedin-sponsored', 'email-subject'] },
    usp: { type: 'string', description: 'Unique selling proposition or key benefit.' },
    tone: { type: 'string', description: 'Tone of voice.', enum: ['professional', 'casual', 'urgent', 'friendly', 'authoritative'], default: 'professional' },
    variants: { type: 'number', description: 'Number of A/B variants to generate (2-5, default: 3).', default: 3 },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const product = params['product'] as string | undefined;
    const format = (params['format'] as string | undefined) ?? 'google-search';
    const usp = (params['usp'] as string | undefined) ?? '';
    const tone = (params['tone'] as string | undefined) ?? 'professional';
    const variants = Math.min(5, Math.max(2, (params['variants'] as number | undefined) ?? 3));
    logger.info({ session: ctx.sessionId, product, format }, 'marketing.ad-copy-generator invoked');

    if (!product?.trim()) return { success: false, output: 'product is required.' };

    try {
      const system = `You are an expert direct-response copywriter with a proven track record of high-converting ${format} ads.`;
      const user = `Write ${variants} A/B ad copy variants for: "${product}"
Format: ${format} | Tone: ${tone}${usp ? ` | USP: ${usp}` : ''}

For each variant (VARIANT A, B, C...) provide:
- HEADLINE 1 (30 chars max for Google, 40 for social)
- HEADLINE 2 (if applicable)
- DESCRIPTION (90 chars max for Google, 125 for social)
- CTA (call-to-action button text)
- RATIONALE (1 sentence explaining the angle)

End with TESTING NOTES: which variant to test first and why.`;

      const output = await askBrain(ctx, system, user);
      logger.info({ product, format, variants }, 'Ad copy generated');
      return { success: true, output, data: { product, format, tone, variants } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ product, err: msg }, 'marketing.ad-copy-generator error');
      return { success: false, output: `Ad copy generator error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// marketing.competitor-analysis
// ---------------------------------------------------------------------------

const competitorAnalysisTool: ToolDefinition = {
  name: 'marketing.competitor-analysis',
  description:
    'Deep competitor analysis covering pricing, features, traffic estimates, messaging, and weaknesses. Identifies gaps and opportunities.',
  category: 'marketing',
  timeout: 60_000,
  parameters: {
    company: { type: 'string', required: true, description: 'Your company or product name.' },
    competitors: { type: 'string', required: true, description: 'Competitor names or URLs (comma-separated, max 5).' },
    focus: { type: 'string', description: 'Analysis focus area.', enum: ['pricing', 'features', 'messaging', 'seo', 'full'], default: 'full' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const company = params['company'] as string | undefined;
    const competitors = params['competitors'] as string | undefined;
    const focus = (params['focus'] as string | undefined) ?? 'full';
    logger.info({ session: ctx.sessionId, company }, 'marketing.competitor-analysis invoked');

    if (!company?.trim()) return { success: false, output: 'company is required.' };
    if (!competitors?.trim()) return { success: false, output: 'competitors is required.' };

    const competitorList = competitors.split(',').map(s => s.trim()).filter(Boolean).slice(0, 5);

    try {
      const system = 'You are a competitive intelligence analyst. Provide structured, data-informed competitor analyses.';
      const user = `Conduct a ${focus} competitor analysis for "${company}" vs: ${competitorList.join(', ')}

Structure your analysis:
1. FEATURE COMPARISON TABLE (key features, mark ✓/✗/partial for each competitor)
2. PRICING ANALYSIS (pricing models, tiers, positioning — infer from market knowledge)
3. MESSAGING & POSITIONING (value props, target segments, tone)
4. TRAFFIC & SEO ESTIMATES (domain authority tier, estimated organic traffic tier)
5. STRENGTHS & WEAKNESSES (per competitor)
6. OPPORTUNITIES (gaps in competitor offerings your company can exploit)
7. THREATS (competitor advantages you need to counter)
8. RECOMMENDED ACTIONS (3-5 strategic moves)`;

      const output = await askBrain(ctx, system, user);
      logger.info({ company, competitorCount: competitorList.length }, 'Competitor analysis complete');
      return { success: true, output, data: { company, competitors: competitorList, focus } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ company, err: msg }, 'marketing.competitor-analysis error');
      return { success: false, output: `Competitor analysis error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// marketing.content-calendar
// ---------------------------------------------------------------------------

const contentCalendarTool: ToolDefinition = {
  name: 'marketing.content-calendar',
  description:
    'Generate a content publishing calendar for blogs, social media, or video channels. Returns a structured schedule with topics, formats, and publishing dates.',
  category: 'marketing',
  timeout: 60_000,
  parameters: {
    brand: { type: 'string', required: true, description: 'Brand or channel name.' },
    channels: { type: 'string', required: true, description: 'Publishing channels (comma-separated, e.g. blog, twitter, youtube, linkedin).' },
    period: { type: 'string', description: 'Planning period.', enum: ['1-week', '2-weeks', '1-month', '3-months'], default: '1-month' },
    niche: { type: 'string', description: 'Content niche or industry.' },
    goals: { type: 'string', description: 'Content goals (e.g. brand awareness, lead generation, community building).' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const brand = params['brand'] as string | undefined;
    const channels = params['channels'] as string | undefined;
    const period = (params['period'] as string | undefined) ?? '1-month';
    const niche = (params['niche'] as string | undefined) ?? '';
    const goals = (params['goals'] as string | undefined) ?? '';
    logger.info({ session: ctx.sessionId, brand, period }, 'marketing.content-calendar invoked');

    if (!brand?.trim()) return { success: false, output: 'brand is required.' };
    if (!channels?.trim()) return { success: false, output: 'channels is required.' };

    const channelList = channels.split(',').map(s => s.trim()).filter(Boolean);

    try {
      const system = 'You are a content strategist and editorial director. Create strategic, audience-focused content calendars.';
      const user = `Create a ${period} content calendar for "${brand}"
Channels: ${channelList.join(', ')}
${niche ? `Niche: ${niche}` : ''}
${goals ? `Goals: ${goals}` : ''}

Provide:
1. CONTENT THEMES (3-5 monthly/weekly themes with rationale)
2. PUBLISHING SCHEDULE (table: Date | Channel | Content Type | Topic | Format | CTA)
3. CONTENT MIX (% breakdown: educational/entertaining/promotional/engagement)
4. REPURPOSING STRATEGY (how to adapt each piece across channels)
5. KEY DATES (holidays, events, trending topics to leverage)
6. PRODUCTION CHECKLIST (what to prepare per content type)`;

      const output = await askBrain(ctx, system, user);
      logger.info({ brand, period, channels: channelList.length }, 'Content calendar generated');
      return { success: true, output, data: { brand, channels: channelList, period } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ brand, err: msg }, 'marketing.content-calendar error');
      return { success: false, output: `Content calendar error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const MARKETING_TOOLS: ToolDefinition[] = [
  seoAuditTool,
  keywordResearchTool,
  adCampaignBuilderTool,
  adCopyGeneratorTool,
  competitorAnalysisTool,
  contentCalendarTool,
];

/**
 * Register all marketing tools with the given registry.
 * Called automatically by the built-in tool loader.
 *
 * @param registry - The application's central {@link ToolRegistry}.
 */
export function registerMarketingTools(registry: ToolRegistry): void {
  logger.info({ count: MARKETING_TOOLS.length }, 'Registering marketing tools');
  for (const tool of MARKETING_TOOLS) {
    registry.register(tool);
  }
  logger.info({ count: MARKETING_TOOLS.length }, 'Marketing tools registered');
}
