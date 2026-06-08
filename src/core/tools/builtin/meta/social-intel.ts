/**
 * meta.social-intel — Social Intelligence Network tool for SUDO-AI.
 *
 * Actions:
 *   add-contact          — Add a new contact to the relationship memory
 *   search               — Full-text search across contacts
 *   record-interaction   — Log an interaction event with a contact
 *   top-influencers      — Return contacts ranked by trust score
 *   community-stats      — Aggregate stats: totals, by-platform, by-relationship, avg trust
 *   collaborations       — Return high-trust candidates for collaboration
 *   sentiment            — Aggregate sentiment breakdown across all interactions
 */

import path from 'node:path';
import { SocialIntelligence } from '../../../social/social-intelligence.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { MIND_DB } from '../../../shared/paths.js';

const logger = createLogger('meta-social-intel');

const DB_PATH = MIND_DB;

// ---------------------------------------------------------------------------
// Lazy singleton
// ---------------------------------------------------------------------------

let _social: SocialIntelligence | null = null;

function getSocial(): SocialIntelligence {
  if (!_social) {
    _social = new SocialIntelligence(DB_PATH);
    logger.info({ dbPath: DB_PATH }, 'SocialIntelligence singleton created');
  }
  return _social;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatContact(c: {
  id: string; name: string; platform: string; relationship: string;
  trustScore: number; interactionCount: number; lastInteraction?: string; tags: string[];
}): string {
  const tagStr = c.tags.length > 0 ? ` [${c.tags.join(', ')}]` : '';
  const last   = c.lastInteraction ? ` | last: ${c.lastInteraction.slice(0, 10)}` : '';
  return `[${c.id.slice(0, 8)}] ${c.name} (${c.platform} · ${c.relationship}) trust:${c.trustScore} interactions:${c.interactionCount}${last}${tagStr}`;
}

function formatInteraction(i: {
  id: string; contactId: string; type: string; sentiment: string;
  platform: string; timestamp: string; content: string;
}): string {
  return `[${i.timestamp.slice(0, 10)}] ${i.type} (${i.sentiment}) on ${i.platform}: ${i.content.slice(0, 80)}`;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const socialIntelTool: ToolDefinition = {
  name: 'meta.social-intel',
  description:
    'Social Intelligence Network: track relationships, log interactions, map influence, and monitor community health. '
    + 'Actions: add-contact (store a person with platform/relationship/trust metadata), '
    + 'search (find contacts by name/notes/tags), '
    + 'record-interaction (log a comment/DM/mention/collaboration with sentiment), '
    + 'top-influencers (ranked by trust score), '
    + 'community-stats (totals, by-platform, by-relationship, avg trust), '
    + 'collaborations (high-trust candidates for working together), '
    + 'sentiment (positive/neutral/negative breakdown across all interactions).',
  category: 'meta',
  timeout: 30_000,

  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'Operation to perform.',
      enum: ['add-contact', 'search', 'record-interaction', 'top-influencers', 'community-stats', 'collaborations', 'sentiment'],
    },
    name:            { type: 'string', description: '[add-contact] Full name or handle.' },
    platform:        { type: 'string', description: 'Platform: youtube|telegram|twitter|email|other.', enum: ['youtube','telegram','twitter','email','other'] },
    platformId:      { type: 'string', description: '[add-contact] Their username/ID on that platform.' },
    relationship:    { type: 'string', description: '[add-contact] Relationship type.', enum: ['viewer','subscriber','collaborator','competitor','mentor','friend','unknown'] },
    trustScore:      { type: 'number', description: '[add-contact] Trust score 0–10.', default: 5 },
    notes:           { type: 'string', description: '[add-contact] Free-form notes.' },
    tags:            { type: 'array',  description: '[add-contact] Categorisation tags.', items: { type: 'string', description: 'Tag.' } },
    query:           { type: 'string', description: '[search] Text to match in name, notes, tags, platform.' },
    contactId:       { type: 'string', description: '[record-interaction] Contact ID.' },
    interactionType: { type: 'string', description: '[record-interaction] Interaction type.', enum: ['comment','dm','mention','collaboration','email','call'] },
    content:         { type: 'string', description: '[record-interaction] Text of the interaction.' },
    sentiment:       { type: 'string', description: '[record-interaction] Sentiment.', enum: ['positive','neutral','negative'] },
    limit:           { type: 'number', description: '[top-influencers] Max results (default: 10, max: 100).', default: 10 },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = (params['action'] as string | undefined)?.trim();
    logger.info({ session: ctx.sessionId, action }, 'meta.social-intel invoked');

    if (!action) {
      return {
        success: false,
        output: 'action is required. Choose one of: add-contact, search, record-interaction, top-influencers, community-stats, collaborations, sentiment.',
      };
    }

    try {
      const social = getSocial();

      switch (action) {

        // -------------------------------------------------------------------
        case 'add-contact': {
          const name = (params['name'] as string | undefined)?.trim();
          if (!name) return { success: false, output: 'name is required for add-contact.' };

          const rawTrust = params['trustScore'];
          const trustScore = typeof rawTrust === 'number' ? rawTrust : 5.0;
          const rawTags = params['tags'];
          const tags = Array.isArray(rawTags) ? (rawTags as unknown[]).map(String) : [];

          const id = social.addContact({
            name,
            platform:     (params['platform'] as string | undefined) ?? 'other',
            platformId:   (params['platformId'] as string | undefined) ?? undefined,
            relationship: (params['relationship'] as string | undefined) as 'unknown' ?? 'unknown',
            trustScore,
            notes:        (params['notes'] as string | undefined) ?? '',
            tags,
          });

          logger.info({ id, name }, 'add-contact succeeded');
          return {
            success: true,
            output:  `Contact added: "${name}" (id: ${id})`,
            data:    { id, name },
          };
        }

        // -------------------------------------------------------------------
        case 'search': {
          const query = (params['query'] as string | undefined)?.trim();
          if (!query) return { success: false, output: 'query is required for search.' };

          const results = social.searchContacts(query);
          if (results.length === 0) {
            return { success: true, output: `No contacts found matching: "${query}"`, data: { results: [] } };
          }
          const lines = results.map(c => formatContact(c));
          return {
            success: true,
            output:  `${results.length} contact(s) matching "${query}":\n${lines.join('\n')}`,
            data:    { results },
          };
        }

        // -------------------------------------------------------------------
        case 'record-interaction': {
          const contactId = (params['contactId'] as string | undefined)?.trim();
          if (!contactId) return { success: false, output: 'contactId is required for record-interaction.' };
          const content = (params['content'] as string | undefined)?.trim();
          if (!content) return { success: false, output: 'content is required for record-interaction.' };

          const id = social.recordInteraction({
            contactId,
            type:      (params['interactionType'] as string | undefined) ?? 'comment',
            content,
            sentiment: (params['sentiment'] as string | undefined) as 'neutral' ?? 'neutral',
            platform:  (params['platform'] as string | undefined) ?? 'other',
            timestamp: new Date().toISOString(),
          });

          logger.info({ id, contactId, type: params['interactionType'] }, 'record-interaction succeeded');
          return {
            success: true,
            output:  `Interaction recorded (id: ${id}) for contact: ${contactId}`,
            data:    { id, contactId },
          };
        }

        // -------------------------------------------------------------------
        case 'top-influencers': {
          const rawLimit = params['limit'];
          const limit = typeof rawLimit === 'number'
            ? Math.min(100, Math.max(1, Math.floor(rawLimit)))
            : 10;

          const influencers = social.getTopInfluencers(limit);
          if (influencers.length === 0) {
            return { success: true, output: 'No contacts yet. Use add-contact to start building your network.', data: { influencers: [] } };
          }
          const lines = influencers.map((c, i) => `${i + 1}. ${formatContact(c)}`);
          return {
            success: true,
            output:  `Top ${influencers.length} influencer(s) by trust score:\n${lines.join('\n')}`,
            data:    { influencers },
          };
        }

        // -------------------------------------------------------------------
        case 'community-stats': {
          const stats = social.getCommunityStats();

          const platformLines = Object.entries(stats.byPlatform)
            .sort((a, b) => b[1] - a[1])
            .map(([p, n]) => `  ${p}: ${n}`)
            .join('\n') || '  (none)';

          const relLines = Object.entries(stats.byRelationship)
            .sort((a, b) => b[1] - a[1])
            .map(([r, n]) => `  ${r}: ${n}`)
            .join('\n') || '  (none)';

          const output = [
            'Community Stats',
            `  Total contacts:  ${stats.total}`,
            `  Average trust:   ${stats.avgTrust}`,
            'By platform:',
            platformLines,
            'By relationship:',
            relLines,
          ].join('\n');

          logger.info(stats, 'community-stats returned');
          return { success: true, output, data: stats };
        }

        // -------------------------------------------------------------------
        case 'collaborations': {
          const candidates = social.getCollaborationCandidates();
          if (candidates.length === 0) {
            return {
              success: true,
              output:  'No collaboration candidates yet. Add contacts with relationship=collaborator/friend/mentor and trustScore>=7.',
              data:    { candidates: [] },
            };
          }
          const lines = candidates.map((c, i) => `${i + 1}. ${formatContact(c)}`);
          return {
            success: true,
            output:  `${candidates.length} collaboration candidate(s):\n${lines.join('\n')}`,
            data:    { candidates },
          };
        }

        // -------------------------------------------------------------------
        case 'sentiment': {
          const summary = social.getSentimentSummary();
          const total   = summary.positive + summary.neutral + summary.negative;
          const pct     = (n: number): string => total > 0 ? ` (${Math.round((n / total) * 100)}%)` : '';

          const output = [
            'Interaction Sentiment Summary',
            `  Total interactions: ${total}`,
            `  Positive: ${summary.positive}${pct(summary.positive)}`,
            `  Neutral:  ${summary.neutral}${pct(summary.neutral)}`,
            `  Negative: ${summary.negative}${pct(summary.negative)}`,
          ].join('\n');

          logger.info(summary, 'sentiment returned');
          return { success: true, output, data: { ...summary, total } };
        }

        // -------------------------------------------------------------------
        default:
          return {
            success: false,
            output:  `Unknown action: "${action}". Valid actions: add-contact, search, record-interaction, top-influencers, community-stats, collaborations, sentiment.`,
          };
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg, session: ctx.sessionId }, 'meta.social-intel error');
      return { success: false, output: `Social intel error: ${msg}` };
    }
  },
};
