---
name: notion
description: Read, create, and update Notion pages and database entries using the Notion API.
trigger: /notion, create notion page, read notion, update notion, notion database, add to notion
allowed-tools: [web.fetch]
---

# Skill: Notion

## Purpose
Interact with Notion workspaces: read page content, create new pages, append blocks
to existing pages, and query or insert rows in Notion databases.

## When to use
- User wants to create a new Notion page or document
- User wants to read or summarize an existing Notion page
- User wants to add an entry to a Notion database (e.g., task tracker, notes DB)
- User wants to append content to an existing page

## How to use

1. Check that `NOTION_API_KEY` is set in the environment. If missing, inform the user and stop.

2. **Read a page:**
   - Use `web.fetch` GET `https://api.notion.com/v1/pages/<page_id>`
   - Headers: `Authorization: Bearer $NOTION_API_KEY`, `Notion-Version: 2022-06-28`
   - Then fetch blocks: GET `https://api.notion.com/v1/blocks/<page_id>/children`
   - Extract and present text content from paragraph, heading, and bulleted_list_item blocks.

3. **Create a page:**
   - Determine the parent (page ID or database ID) from `$ARGUMENTS` or ask.
   - POST `https://api.notion.com/v1/pages` with body:
     ```json
     {
       "parent": { "page_id": "<parent_id>" },
       "properties": { "title": [{ "text": { "content": "<title>" } }] },
       "children": [{ "paragraph": { "rich_text": [{ "text": { "content": "<body>" } }] } }]
     }
     ```
   - Return the new page URL from the response.

4. **Append blocks to a page:**
   - PATCH `https://api.notion.com/v1/blocks/<page_id>/children`
   - Body: `{ "children": [ <block objects> ] }`

5. **Query a database:**
   - POST `https://api.notion.com/v1/databases/<database_id>/query`
   - Optionally include `filter` and `sorts` in the body.
   - Present results in a readable table format.

6. **Insert a database row:**
   - POST `https://api.notion.com/v1/pages` with `"parent": { "database_id": "<id>" }`
   - Include `properties` matching the database schema.

## Requirements
- `NOTION_API_KEY` — Notion internal integration token (starts with `secret_`).
- The integration must be connected to the target pages/databases in Notion settings.
- Page/database IDs can be extracted from Notion URLs (32-char hex, optionally hyphenated).

## Example
```
/notion create page in <parent_id> title:"Meeting Notes" body:"Discussed Q2 goals."
/notion read page <page_id>
/notion query database <database_id>
```
