/**
 * @file tools/builtin/comms/github-notify.ts
 * @description comms.github-notify — GitHub Notifications tool wrapper.
 *
 * Reads from vault (namespace: github) or GITHUB_TOKEN env var.
 * Lists unread GitHub notifications via the REST API (no SDK — raw fetch).
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { listGitHubNotifications } from '../../../channels/github-connector.js';
import { createLogger } from '../../../shared/logger.js';

const log = createLogger('tool:comms.github-notify');

export const githubNotifyTool: ToolDefinition = {
  name: 'comms.github-notify',
  description:
    'List unread GitHub notifications for the authenticated user. ' +
    'Requires GITHUB_TOKEN env var or PAT stored in vault (namespace: github, url: https://api.github.com). ' +
    'Returns notification subject titles, types, and repository names.',
  category: 'comms',
  timeout: 20_000,
  parameters: {
    limit: {
      type: 'number',
      required: false,
      default: 20,
      description: 'Maximum number of notifications to return (max 50).',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const limit = typeof params['limit'] === 'number'
      ? Math.min(50, Math.max(1, params['limit']))
      : 20;

    log.info({ sessionId: ctx.sessionId, limit }, 'GitHub notifications list');
    const result = await listGitHubNotifications(limit, ctx.signal);

    return {
      success: result.success,
      output: result.output,
      data: result.notifications
        ? {
            notifications: result.notifications.map(n => ({
              id: n.id,
              reason: n.reason,
              title: n.subject.title,
              type: n.subject.type,
              repo: n.repository.full_name,
              updated_at: n.updated_at,
            })),
            count: result.count,
          }
        : undefined,
    };
  },
};

export default githubNotifyTool;
