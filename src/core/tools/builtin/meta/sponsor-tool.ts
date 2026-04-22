/**
 * meta.sponsors — Sponsor/Brand Outreach tool.
 *
 * Wraps SponsorManager to provide full pipeline management: add prospects,
 * update deal status, view pipeline stats, generate outreach emails.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger('meta.sponsors');

export const sponsorsTool: ToolDefinition = {
  name: 'meta.sponsors',
  description:
    'Manage brand sponsorship pipeline: add prospects, update deal status, list sponsors, find new prospects by niche, view pipeline stats, and generate personalised outreach emails.',
  category: 'meta',
  timeout: 20_000,
  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'Operation to perform.',
      enum: ['add', 'list', 'update-status', 'prospects', 'pipeline', 'outreach-email'],
    },
    brandName: {
      type: 'string',
      description: 'Brand name (required for add, outreach-email).',
    },
    niche: {
      type: 'string',
      description: 'Industry/vertical e.g. tech, gaming, finance (required for add, prospects).',
    },
    contactEmail: {
      type: 'string',
      description: 'Brand contact email address (optional for add).',
    },
    contactName: {
      type: 'string',
      description: 'Brand contact person name (optional for add).',
    },
    dealValue: {
      type: 'number',
      description: 'Estimated or agreed deal value in USD (optional for add/update-status).',
    },
    notes: {
      type: 'string',
      description: 'Freeform notes about the sponsor or deal.',
    },
    sponsorId: {
      type: 'string',
      description: 'Sponsor ID (required for update-status, outreach-email).',
    },
    status: {
      type: 'string',
      description: 'New pipeline status (required for update-status).',
      enum: ['prospect', 'contacted', 'negotiating', 'active', 'completed', 'declined'],
    },
    filterStatus: {
      type: 'string',
      description: 'Filter list by status (optional for list).',
      enum: ['prospect', 'contacted', 'negotiating', 'active', 'completed', 'declined'],
    },
    subscribers: {
      type: 'number',
      description: 'Your channel subscriber count (required for outreach-email).',
    },
    avgViews: {
      type: 'number',
      description: 'Your channel average views per video (required for outreach-email).',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    logger.info({ session: ctx.sessionId, action }, 'meta.sponsors invoked');

    try {
      const { SponsorManager } = await import('../../../business/sponsor-manager.js');
      const mgr = new SponsorManager();

      try {
        switch (action) {
          // ------------------------------------------------------------------
          case 'add': {
            const brandName = params['brandName'] as string | undefined;
            const niche = params['niche'] as string | undefined;
            if (!brandName?.trim()) return { success: false, output: 'brandName is required for add.' };
            if (!niche?.trim()) return { success: false, output: 'niche is required for add.' };

            const id = mgr.addSponsor({
              brandName,
              niche,
              status: (params['status'] as 'prospect' | undefined) ?? 'prospect',
              contactEmail: params['contactEmail'] as string | undefined,
              contactName: params['contactName'] as string | undefined,
              dealValue: params['dealValue'] as number | undefined,
              notes: (params['notes'] as string | undefined) ?? '',
              lastContactAt: undefined,
            });

            return {
              success: true,
              output: `Sponsor added: "${brandName}" (id: ${id}) — status: prospect`,
              data: { id, brandName, niche },
            };
          }

          // ------------------------------------------------------------------
          case 'list': {
            const filterStatus = params['filterStatus'] as string | undefined;
            const sponsors = mgr.listSponsors(filterStatus ? { status: filterStatus } : undefined);
            if (sponsors.length === 0) {
              return { success: true, output: 'No sponsors found.', data: [] };
            }
            const lines = sponsors.map(
              (s) => `[${s.id.slice(0, 8)}] ${s.brandName} — ${s.status}${s.dealValue ? ` ($${s.dealValue.toLocaleString()})` : ''}`,
            );
            return {
              success: true,
              output: `${sponsors.length} sponsor(s):\n${lines.join('\n')}`,
              data: sponsors,
            };
          }

          // ------------------------------------------------------------------
          case 'update-status': {
            const sponsorId = params['sponsorId'] as string | undefined;
            const status = params['status'] as string | undefined;
            if (!sponsorId?.trim()) return { success: false, output: 'sponsorId is required for update-status.' };
            if (!status?.trim()) return { success: false, output: 'status is required for update-status.' };

            mgr.updateStatus(
              sponsorId,
              status as Parameters<typeof mgr.updateStatus>[1],
              params['notes'] as string | undefined,
            );

            return {
              success: true,
              output: `Sponsor ${sponsorId} status updated to "${status}".`,
              data: { sponsorId, status },
            };
          }

          // ------------------------------------------------------------------
          case 'prospects': {
            const niche = params['niche'] as string | undefined;
            if (!niche?.trim()) return { success: false, output: 'niche is required for prospects.' };

            const brands = mgr.findProspects(niche);
            return {
              success: true,
              output: `Suggested prospects for "${niche}":\n${brands.join('\n')}`,
              data: { niche, brands },
            };
          }

          // ------------------------------------------------------------------
          case 'pipeline': {
            const stats = mgr.getPipeline();
            return {
              success: true,
              output: [
                `Pipeline overview:`,
                `  Prospects:   ${stats.prospects}`,
                `  Contacted:   ${stats.contacted}`,
                `  Negotiating: ${stats.negotiating}`,
                `  Active:      ${stats.active}`,
                `  Revenue:     $${stats.totalRevenue.toLocaleString()}`,
              ].join('\n'),
              data: stats,
            };
          }

          // ------------------------------------------------------------------
          case 'outreach-email': {
            const sponsorId = params['sponsorId'] as string | undefined;
            const subscribers = params['subscribers'] as number | undefined;
            const avgViews = params['avgViews'] as number | undefined;
            if (!sponsorId?.trim()) return { success: false, output: 'sponsorId is required for outreach-email.' };
            if (!subscribers || subscribers <= 0) return { success: false, output: 'subscribers must be a positive number.' };
            if (!avgViews || avgViews <= 0) return { success: false, output: 'avgViews must be a positive number.' };

            const sponsor = mgr.getSponsor(sponsorId);
            if (!sponsor) return { success: false, output: `Sponsor not found: ${sponsorId}` };

            const email = mgr.generateOutreachEmail(sponsor, { subscribers, avgViews });
            return {
              success: true,
              output: email,
              data: { sponsorId, brandName: sponsor.brandName, emailLength: email.length },
            };
          }

          // ------------------------------------------------------------------
          default:
            return { success: false, output: `Unknown action: ${action}` };
        }
      } finally {
        mgr.close();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'meta.sponsors error');
      return { success: false, output: `Sponsors error: ${msg}` };
    }
  },
};
