---
name: gmail
description: Send, read, and search Gmail messages using Google OAuth authentication.
trigger: /gmail, send email, read email, check inbox, search gmail, reply to email
allowed-tools: [comms.gmail-send, comms.gmail-read, web.fetch]
---

# Skill: Gmail

## Purpose
Interact with Gmail to send new messages, read incoming emails, reply to threads,
and search the inbox — all via the Gmail API using an OAuth access token.

## When to use
- User asks to send an email via Gmail
- User wants to check, read, or summarize unread messages
- User wants to search for emails by sender, subject, or keyword
- User wants to reply to or forward an existing thread

## How to use

1. Check that `GMAIL_OAUTH_TOKEN` is available in the environment. If missing, inform the user and stop.

2. **Send an email:**
   - Extract recipient, subject, and body from `$ARGUMENTS` or ask the user.
   - Use `comms.gmail-send` with `{ to, subject, body, cc?, bcc? }`.
   - Confirm send with the returned message ID.

3. **Read / list emails:**
   - Use `comms.gmail-read` with `{ action: "list", maxResults: 10, query?: "is:unread" }`.
   - Present a summary: sender, subject, date, snippet for each message.

4. **Read a specific email:**
   - Use `comms.gmail-read` with `{ action: "get", messageId: "<id>" }`.
   - Display full body, strip HTML if needed, show attachments list.

5. **Search emails:**
   - Use `comms.gmail-read` with `{ action: "search", query: "<Gmail search expression>" }`.
   - Valid Gmail query examples: `from:alice@example.com`, `subject:invoice`, `has:attachment`.

6. **Reply to a thread:**
   - Fetch the thread ID from the original message.
   - Use `comms.gmail-send` with `{ threadId, to, subject: "Re: <original>", body }`.

## Requirements
- `GMAIL_OAUTH_TOKEN` — valid Google OAuth2 access token with `gmail.modify` scope.
- Token must be refreshed externally before expiry; this skill does not refresh tokens.

## Example
```
/gmail send to:bob@example.com subject:"Meeting tomorrow" body:"Are you free at 10am?"
/gmail read unread
/gmail search from:alice@example.com has:attachment
```
