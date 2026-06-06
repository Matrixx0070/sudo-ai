---
name: slack-integration
description: Post messages, read DMs, and interact with Slack channels using a bot token.
trigger: /slack, send slack message, slack dm, post to channel, read slack, slack notification
allowed-tools: [comms.slack-send, web.fetch]
---

# Skill: Slack Integration

## Purpose
Interact with Slack workspaces: post messages to channels, send direct messages,
read recent messages, search message history, and react to messages.

## When to use
- User wants to send a message to a Slack channel or DM
- User wants to check recent messages in a channel
- User wants to send a notification or alert to a Slack channel
- Automated pipeline needs to report status to a Slack channel
- User wants to search for past messages in Slack

## How to use

1. Check that `SLACK_BOT_TOKEN` is set in the environment (starts with `xoxb-`).
   If missing, direct user to create a Slack app at https://api.slack.com/apps.

2. **Post a message to a channel (preferred — uses comms.slack-send):**
   - Use `comms.slack-send` with `{ channel: "#channel-name", text: "<message>" }`
   - Supports markdown-like mrkdwn: `*bold*`, `_italic_`, `<URL|link text>`

3. **Post a message via API (fallback):**
   - POST `https://slack.com/api/chat.postMessage`
   - Headers: `Authorization: Bearer $SLACK_BOT_TOKEN`, `Content-Type: application/json`
   - Body: `{ "channel": "<channel_id_or_name>", "text": "<message>" }`
   - Check `ok: true` in response.

4. **Send a direct message:**
   - First open a DM channel: POST `https://slack.com/api/conversations.open`
   - Body: `{ "users": "<user_id>" }` — get channel ID from response.
   - Then post message to that channel ID.

5. **Read recent messages:**
   - GET `https://slack.com/api/conversations.history`
   - Params: `channel=<channel_id>&limit=20`
   - Present: timestamp (as readable time), username, message text.

6. **List channels:**
   - GET `https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=100`
   - Filter by name to find channel IDs.

7. **Search messages:**
   - GET `https://slack.com/api/search.messages?query=<search_term>&count=10`
   - Requires `search:read` OAuth scope on the bot token.

8. **Add a reaction to a message:**
   - POST `https://slack.com/api/reactions.add`
   - Body: `{ "channel": "<channel_id>", "timestamp": "<msg_ts>", "name": "thumbsup" }`

9. For rich messages, use Block Kit JSON in the `blocks` field instead of `text`.

## Requirements
- `SLACK_BOT_TOKEN` — Bot User OAuth Token (`xoxb-...`) from Slack app settings.
- Bot must be invited to channels it needs to post in (`/invite @botname`).
- Required OAuth scopes: `chat:write`, `channels:read`, `channels:history`, `im:write`.
- For search: add `search:read` scope.

## Example
```
/slack post to:#engineering "Deployment complete. Version 2.1.0 is live."
/slack dm @alice "Can you review PR #42 when you get a chance?"
/slack read #general last 10 messages
/slack search "deployment failed" in #ops
```
