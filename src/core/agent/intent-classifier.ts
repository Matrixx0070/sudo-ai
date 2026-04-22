/**
 * Intent Classifier — SUDO-AI v4
 *
 * Classifies incoming user messages into intent types so the agent loop can
 * inject a routing hint into the brain context BEFORE calling the LLM.
 * This tells SUDO which execution path to take without the owner ever needing
 * to specify tools manually.
 *
 * Adapted from ChatGPT Agent output (2026-04-03) for SUDO-AI's architecture.
 */

export type IntentType = 'conversation' | 'single-tool' | 'multi-tool' | 'spawn-team';
export type Complexity = 'low' | 'medium' | 'high';

export interface TaskIntent {
  /** High-level classification of the request */
  intentType: IntentType;
  /** Tool names suggested for this task */
  suggestedTools: string[];
  /** Estimated complexity */
  complexity: Complexity;
  /** Agent roles when spawning a team (only present for spawn-team) */
  teamRoles?: string[];
}

// ---------------------------------------------------------------------------
// Patterns for casual conversation — no tools needed
// ---------------------------------------------------------------------------
const CONVERSATION_PATTERNS: RegExp[] = [
  /^\s*(?:hi|hello|hey|sup|yo)\b/i,
  /\bhow are you\b/i,
  /\bwhat'?s up\b/i,
  /\btell me a joke\b/i,
  /\bsay something\b/i,
  /^\s*(?:thanks?|thank you|cheers|ok|okay|sure|alright|cool|great|nice)\s*[.!]?\s*$/i,
  /^\s*(?:good morning|good night|good evening)\b/i,
];

// ---------------------------------------------------------------------------
// High-complexity keyword → team roles mapping
// ---------------------------------------------------------------------------
const SPAWN_KEYWORDS: Record<string, string[]> = {
  // YouTube / Content production
  'make a video': ['researcher', 'scriptwriter', 'voice-artist', 'video-editor', 'thumbnail-designer'],
  'youtube video': ['researcher', 'scriptwriter', 'voice-artist', 'video-editor', 'thumbnail-designer'],
  'full video': ['researcher', 'scriptwriter', 'voice-artist', 'video-editor', 'thumbnail-designer'],
  'youtube short': ['researcher', 'scriptwriter', 'voice-artist', 'short-form-editor'],
  'ai education video': ['researcher', 'scriptwriter', 'voice-artist', 'video-editor', 'thumbnail-designer'],
  podcast: ['researcher', 'scriptwriter', 'voice-artist', 'audio-editor'],
  // Coding / App builds
  'build an app': ['architect', 'backend', 'frontend', 'tester', 'devops'],
  'build a website': ['architect', 'frontend', 'backend', 'tester'],
  'new feature': ['architect', 'backend', 'frontend', 'tester', 'reviewer'],
  'full stack': ['architect', 'backend', 'frontend', 'database', 'tester'],
  // Content / Strategy
  presentation: ['researcher', 'scriptwriter', 'designer'],
  'content calendar': ['strategist', 'content-creator', 'seo-specialist'],
  campaign: ['strategist', 'content-creator', 'copywriter', 'designer'],
  'grow my channel': ['strategist', 'content-creator', 'seo-specialist', 'editor'],
  // Business
  project: ['project-manager', 'developer', 'tester'],
  'launch plan': ['strategist', 'researcher', 'developer', 'marketer'],
  // Research / Reports
  'full research': ['researcher', 'analyst', 'writer'],
  'market analysis': ['researcher', 'analyst', 'writer'],
  'full report': ['researcher', 'analyst', 'writer'],
};

// ---------------------------------------------------------------------------
// Single-tool keyword mappings — ordered most specific first
// ---------------------------------------------------------------------------
const SINGLE_TOOL_MAPPINGS: { pattern: RegExp; tool: string }[] = [
  // Browser / Web
  { pattern: /\b(?:deep research|thorough research|full research)\b/i,        tool: 'research.deep-search' },
  { pattern: /\b(?:search|google|look up|find online|web search)\b/i,         tool: 'browser.search' },
  { pattern: /\b(?:screenshot|capture screen|take a screenshot)\b/i,          tool: 'browser.screenshot' },
  { pattern: /\b(?:open|navigate|go to|visit)\b.{0,50}\b(?:url|http|site|www)\b/i, tool: 'browser.navigate' },
  { pattern: /\b(?:scrape|extract data from|pull data from)\b/i,              tool: 'browser.scrape' },
  { pattern: /\bclick\b.{0,30}\b(?:button|link|element)\b/i,                  tool: 'browser.click' },
  { pattern: /\b(?:fill.{0,10}form|fill out)\b/i,                             tool: 'browser.fill-form' },
  { pattern: /\b(?:download.{0,30}file|download from)\b/i,                    tool: 'browser.download' },
  { pattern: /\bhttp (?:get|fetch) url\b/i,                                   tool: 'browser.fetch' },

  // Coder / Files
  { pattern: /\b(?:read|show me|open)\b.{0,40}\b(?:file|\.ts|\.js|\.json|\.md)\b/i, tool: 'coder.read-file' },
  { pattern: /\b(?:read multiple|batch read)\b/i,                             tool: 'coder.multi-read' },
  { pattern: /\b(?:write|create|make)\b.{0,40}\b(?:file|\.ts|\.js)\b/i,      tool: 'coder.write-file' },
  { pattern: /\b(?:edit|modify|change|update)\b.{0,40}\b(?:file|code|\.ts)\b/i, tool: 'coder.smart-edit' },
  { pattern: /\b(?:grep|search code|search in files?|find in code)\b/i,       tool: 'coder.grep' },
  { pattern: /\b(?:glob|find files?|list files?)\b/i,                         tool: 'coder.glob' },
  { pattern: /\b(?:typecheck|type check|tsc|typescript errors?)\b/i,          tool: 'coder.typecheck' },
  { pattern: /\b(?:git|commit|push|pull|clone|branch|merge)\b/i,              tool: 'coder.git' },
  { pattern: /\b(?:install|npm|pnpm|yarn|add package)\b/i,                   tool: 'coder.npm' },
  { pattern: /\b(?:run tests?|test suite|jest|vitest)\b/i,                    tool: 'coder.test' },
  { pattern: /\b(?:code review|review (?:the )?code)\b/i,                     tool: 'meta.claude-skill' },
  { pattern: /\b(?:debug|stack trace|find the bug)\b/i,                       tool: 'meta.claude-skill' },
  { pattern: /\bproject.?map|codebase overview\b/i,                           tool: 'coder.project-map' },
  { pattern: /\b(?:scaffold|new project structure)\b/i,                       tool: 'coder.scaffold' },

  // System / Infra
  { pattern: /\b(?:run|execute|shell|bash)\b.{0,20}\b(?:command|script|cmd)\b/i, tool: 'system.exec' },
  { pattern: /\b(?:health|status|diagnostics|self.?check|how is|are you ok)\b/i, tool: 'meta.health-check' },
  { pattern: /\b(?:restart service|restart sudo|restart yourself)\b/i,         tool: 'meta.service-control' },
  { pattern: /\b(?:system monitor|cpu|ram|memory usage|processes?)\b/i,        tool: 'system.monitor' },
  { pattern: /\b(?:disk space|disk usage|storage)\b/i,                        tool: 'system.disk' },
  { pattern: /\b(?:cron job|schedule task|add cron|list cron)\b/i,            tool: 'meta.cron-manager' },
  { pattern: /\b(?:backup (?:the )?(?:db|database|brain))\b/i,                tool: 'system.backup-brain' },
  { pattern: /\b(?:backup files?|create backup)\b/i,                          tool: 'system.backup' },
  { pattern: /\b(?:nginx|web server config)\b/i,                              tool: 'system.nginx' },
  { pattern: /\b(?:docker|container)\b/i,                                     tool: 'system.docker' },
  { pattern: /\bssh\b/i,                                                      tool: 'system.ssh' },
  { pattern: /\b(?:api key|secret|credential|store key)\b/i,                  tool: 'system.credentials' },
  { pattern: /\b(?:call api|http post|http request|api call)\b/i,             tool: 'system.api-call' },
  { pattern: /\b(?:security scan|vulnerability|pentest)\b/i,                  tool: 'super.security-scan' },
  { pattern: /\b(?:deploy|deployment|release)\b/i,                            tool: 'super.deploy' },
  { pattern: /\b(?:zip|unzip|archive|tar|compress)\b/i,                       tool: 'super.archive' },
  { pattern: /\b(?:translate to|translate (?:in)?to)\b/i,                     tool: 'super.translate' },
  { pattern: /\b(?:generate pdf|pdf from|pdf report)\b/i,                     tool: 'super.generate-pdf' },
  { pattern: /\b(?:ffmpeg|video.{0,20}audio|trim video|cut video)\b/i,        tool: 'super.ffmpeg' },
  { pattern: /\b(?:performance (?:profile|benchmark)|profile the app)\b/i,    tool: 'super.profile' },
  { pattern: /\b(?:auto.?fix|fix errors? automatically)\b/i,                  tool: 'super.auto-fix' },

  // Self / Meta
  { pattern: /\b(?:change your code|edit your code|modify yourself)\b/i,      tool: 'meta.self-modify' },
  { pattern: /\b(?:change (?:the )?model|switch model|use grok)\b/i,          tool: 'meta.self-modify' },
  { pattern: /\b(?:rebuild|compile|build yourself|npm run build)\b/i,          tool: 'meta.self-modify' },
  { pattern: /\b(?:create (?:a )?new tool|build (?:a )?tool|new skill)\b/i,   tool: 'meta.skill-creator' },
  { pattern: /\b(?:hot.?deploy|update tool live)\b/i,                         tool: 'meta.hot-deploy' },
  { pattern: /\b(?:forge|code forge|build app with forge)\b/i,                tool: 'meta.forge' },
  { pattern: /\b(?:plan|ultra.?plan|step.by.step plan)\b/i,                   tool: 'meta.ultra-plan' },
  { pattern: /\b(?:consciousness|modules? status|which modules?)\b/i,          tool: 'meta.consciousness-control' },
  { pattern: /\b(?:memory|what do you remember|past sessions?)\b/i,           tool: 'meta.memory-query' },
  { pattern: /\b(?:schedule|smart.?schedule)\b/i,                             tool: 'meta.smart-scheduler' },
  { pattern: /\b(?:cost|api spend|how much (?:did I |have I )?spent?)\b/i,    tool: 'meta.cost-tracker' },
  { pattern: /\b(?:spawn team|spawn agents?)\b/i,                             tool: 'meta.spawn-team' },
  { pattern: /\b(?:swarm|multi.?agent|parallel agents?)\b/i,                  tool: 'meta.swarm' },
  { pattern: /\b(?:trend|trending|what.s trending)\b/i,                       tool: 'meta.trend-radar' },
  { pattern: /\b(?:self.?test|run all tests?|test suite)\b/i,                 tool: 'meta.self-test' },
  { pattern: /\b(?:workflow|record workflow|replay)\b/i,                       tool: 'meta.workflow-recorder' },
  { pattern: /\b(?:autonomous mode|run autonomously)\b/i,                     tool: 'meta.autonomous-mode' },
  { pattern: /\b(?:standing order|persistent rule|always do)\b/i,             tool: 'system.standing-orders' },
  { pattern: /\b(?:claude (?:code )?skill|use the architect|use the reviewer|use the tester|use the debugger)\b/i, tool: 'meta.claude-skill' },

  // Content / Media / YouTube
  { pattern: /\b(?:write (?:a )?script|script for|video script)\b/i,          tool: 'content.write-script' },
  { pattern: /\b(?:write (?:an )?article|article about)\b/i,                  tool: 'content.write-article' },
  { pattern: /\b(?:social (?:media )?post|write (?:a )?post|tweet)\b/i,       tool: 'content.write-social-post' },
  { pattern: /\b(?:ad copy|write copy|marketing copy)\b/i,                    tool: 'content.write-copy' },
  { pattern: /\b(?:email sequence|drip (?:email|campaign))\b/i,               tool: 'content.write-email-sequence' },
  { pattern: /\b(?:rewrite|reword|rephrase)\b/i,                              tool: 'content.rewrite' },
  { pattern: /\b(?:summarize|summary of|tldr)\b/i,                            tool: 'content.summarize' },
  { pattern: /\b(?:proofread|grammar|spelling check)\b/i,                     tool: 'content.proofread' },
  { pattern: /\b(?:seo.{0,15}optimize|seo (?:content|text))\b/i,              tool: 'content.seo-content-optimizer' },
  { pattern: /\b(?:generate image|create image|make image|dall.e|midjourney)\b/i, tool: 'media.image-generate' },
  { pattern: /\b(?:edit (?:this )?image|image edit|remove background|crop image)\b/i, tool: 'media.image-edit-advanced' },
  { pattern: /\b(?:thumbnail|make thumbnail|create thumbnail)\b/i,            tool: 'media.thumbnail-generate' },
  { pattern: /\b(?:youtube short|short form|60.?second video)\b/i,            tool: 'media.shorts-factory' },
  { pattern: /\b(?:generate video|create video|video generation)\b/i,          tool: 'media.video-generate' },
  { pattern: /\b(?:edit video|video edit|cut clip)\b/i,                       tool: 'media.video-edit' },
  { pattern: /\b(?:video to clips|clip extraction)\b/i,                       tool: 'media.video-to-clips' },
  { pattern: /\b(?:upload (?:to )?youtube|youtube upload)\b/i,                tool: 'social.youtube-upload' },
  { pattern: /\b(?:youtube analytics|channel stats|youtube stats)\b/i,        tool: 'social.youtube-analytics' },
  { pattern: /\b(?:reply (?:to )?comments?|youtube comments?)\b/i,            tool: 'meta.comments' },
  { pattern: /\b(?:keyword research|keywords? for)\b/i,                       tool: 'marketing.keyword-research' },
  { pattern: /\b(?:seo audit|site audit)\b/i,                                 tool: 'marketing.seo-audit' },
  { pattern: /\b(?:competitor analysis|analyze competitor|compare (?:with )?competitor)\b/i, tool: 'marketing.competitor-analysis' },
  { pattern: /\b(?:content calendar|posting schedule)\b/i,                    tool: 'marketing.content-calendar' },
  { pattern: /\b(?:post (?:to )?all|multi.?platform post)\b/i,                tool: 'social.multi-post' },
  { pattern: /\b(?:schedule (?:a )?post|post at|post (?:later|tomorrow))\b/i, tool: 'social.schedule-post' },
  { pattern: /\b(?:what.s trending|trending on|social trends?)\b/i,           tool: 'social.trend-scanner' },
  { pattern: /\b(?:a\/b test|thumbnail a\/b|split test thumbnail)\b/i,        tool: 'meta.thumbnail-ab' },

  // Voice
  { pattern: /\b(?:text.to.speech|tts|voiceover|voice.?over|speak this)\b/i, tool: 'voice.tts' },
  { pattern: /\b(?:transcribe|speech.to.text|stt|convert audio)\b/i,          tool: 'voice.stt' },

  // Communication
  { pattern: /\b(?:notify|telegram|send me|message me|alert me)\b/i,          tool: 'comms.notify' },
  { pattern: /\b(?:send (?:an )?email|email (?:to|send))\b/i,                 tool: 'comms.email' },
  { pattern: /\b(?:slack message|post to slack)\b/i,                          tool: 'comms.slack' },
  { pattern: /\b(?:send sms|text message)\b/i,                                tool: 'comms.sms' },

  // Data
  { pattern: /\b(?:analyze (?:this )?csv|csv analysis)\b/i,                   tool: 'data.csv-analyzer' },
  { pattern: /\b(?:sql query|run sql|database query)\b/i,                     tool: 'data.sql-query' },
  { pattern: /\b(?:generate chart|make (?:a )?chart|visualize data)\b/i,     tool: 'data.chart-generator' },

  // Research
  { pattern: /\b(?:market research|market analysis)\b/i,                      tool: 'research.market-research' },
  { pattern: /\b(?:academic paper|research paper|arxiv)\b/i,                  tool: 'research.paper-finder' },

  // Business / Finance / Personal
  { pattern: /\b(?:invoice|generate invoice)\b/i,                             tool: 'business.invoicing' },
  { pattern: /\b(?:track earnings?|revenue tracker)\b/i,                      tool: 'earning.tracker' },
  { pattern: /\b(?:bookkeeping|financial record)\b/i,                         tool: 'finance.bookkeeper' },
  { pattern: /\b(?:tax (?:calc|estimate|calculator))\b/i,                     tool: 'finance.tax-calculator' },
  { pattern: /\b(?:set (?:a )?reminder|remind me)\b/i,                        tool: 'personal.reminder-system' },
  { pattern: /\b(?:project task|create task|manage task)\b/i,                 tool: 'pm.task-manager' },

  // Feedback
  { pattern: /\b(?:feedback stats?|how am i rating|my ratings?|good rate|bad tasks?)\b/i, tool: 'meta.feedback' },
  { pattern: /\b(?:what did i rate|what tasks? (?:were|are) bad|feedback report)\b/i,     tool: 'meta.feedback' },

  // Fallback: note / remember
  { pattern: /\b(?:remember|note this|save this|note that)\b/i,               tool: 'meta.memory-query' },
];

// ---------------------------------------------------------------------------
// Multi-step connector patterns
// ---------------------------------------------------------------------------
const MULTI_STEP_CONNECTOR = /\b(?:and then|then|after that|first.{0,50}then|,\s*and\s+(?:then\s+)?(?:also\s+)?(?:finally\s+)?)\b/i;

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Classify the intent of a user message into one of four categories.
 * Returns a TaskIntent that the agent loop injects as a routing hint.
 */
export function classifyIntent(userMessage: string): TaskIntent {
  const msg = userMessage.trim();
  const lower = msg.toLowerCase();

  // 1. Casual conversation — no tools
  if (CONVERSATION_PATTERNS.some(p => p.test(msg))) {
    return { intentType: 'conversation', suggestedTools: [], complexity: 'low' };
  }

  // 2. Spawn-team: high-complexity keywords
  for (const [keyword, roles] of Object.entries(SPAWN_KEYWORDS)) {
    if (lower.includes(keyword)) {
      return {
        intentType: 'spawn-team',
        suggestedTools: ['meta.spawn-team'],
        complexity: 'high',
        teamRoles: roles,
      };
    }
  }

  // 3. Multi-tool: connectors or length/verb heuristic
  if (MULTI_STEP_CONNECTOR.test(lower)) {
    const parts = lower.split(MULTI_STEP_CONNECTOR).filter(Boolean);
    const tools = new Set<string>();
    for (const part of parts) {
      const sub = classifyIntent(part);
      sub.suggestedTools.forEach(t => tools.add(t));
    }
    return {
      intentType: 'multi-tool',
      suggestedTools: Array.from(tools),
      complexity: 'medium',
    };
  }

  // 4. Single-tool: keyword → tool mapping
  for (const { pattern, tool } of SINGLE_TOOL_MAPPINGS) {
    if (pattern.test(lower)) {
      return { intentType: 'single-tool', suggestedTools: [tool], complexity: 'low' };
    }
  }

  // 5. Length + verb count heuristic → likely multi-step
  const words = lower.split(/\s+/);
  const verbCount = words.filter(w =>
    /(?:ing|ed)$|\b(?:run|create|fix|build|generate|write|edit|research|analyze|design|deploy)\b/.test(w)
  ).length;

  if (words.length > 20 || verbCount > 1) {
    return { intentType: 'multi-tool', suggestedTools: [], complexity: 'medium' };
  }

  // 6. Default — let brain decide, treat as low-complexity conversation
  return { intentType: 'conversation', suggestedTools: [], complexity: 'low' };
}

/**
 * Format the intent as a one-line system hint injected before the brain call.
 * Example: "[INTENT: spawn-team | complexity: high | tools: meta.spawn-team | roles: researcher, scriptwriter]"
 */
export function formatIntentHint(intent: TaskIntent): string {
  const parts: string[] = [
    `INTENT: ${intent.intentType}`,
    `complexity: ${intent.complexity}`,
  ];
  if (intent.suggestedTools.length > 0) {
    parts.push(`suggested-tools: ${intent.suggestedTools.join(', ')}`);
  }
  if (intent.teamRoles && intent.teamRoles.length > 0) {
    parts.push(`team-roles: ${intent.teamRoles.join(', ')}`);
  }
  return `[${parts.join(' | ')}]`;
}
