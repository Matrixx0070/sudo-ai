---
name: obsidian
description: Read, write, and edit markdown notes inside a local Obsidian vault.
trigger: /obsidian, read note, write note, create note, edit vault, obsidian note, search vault
allowed-tools: [filesystem.read, filesystem.write, filesystem.edit]
---

# Skill: Obsidian

## Purpose
Interact with a local Obsidian vault: read existing notes, create new notes,
append content to notes, and search for notes by title or content.

## When to use
- User wants to read a specific note from their Obsidian vault
- User wants to create a new note or journal entry
- User wants to append information to an existing note
- User wants to find notes related to a topic
- User wants to create a daily note for today

## How to use

1. Check that `OBSIDIAN_VAULT` environment variable is set (path to the vault root).
   If missing, inform the user and stop.

2. **Read a note:**
   - Resolve path: `$OBSIDIAN_VAULT/<folder>/<note>.md` (ask user if ambiguous).
   - Use `filesystem.read` to load the file content.
   - Present the note, rendering frontmatter separately from body.

3. **Create a new note:**
   - Determine title and folder from `$ARGUMENTS` or ask.
   - Sanitize the filename (replace spaces with `-`, remove special chars).
   - Use `filesystem.write` to write to `$OBSIDIAN_VAULT/<folder>/<title>.md`.
   - Include YAML frontmatter: `created`, `tags` if provided.

4. **Append to an existing note:**
   - Use `filesystem.read` to get current content.
   - Use `filesystem.write` to write updated content (original + new section appended).
   - Or use `filesystem.edit` to insert at a specific location.

5. **Create a daily note:**
   - Path: `$OBSIDIAN_VAULT/Daily Notes/YYYY-MM-DD.md` (standard Obsidian convention).
   - If exists, append new content; if not, create with today's date as heading.

6. **Search vault:**
   - List `.md` files under `$OBSIDIAN_VAULT` recursively via `filesystem.read` on directory.
   - Search filenames and content for the query term.
   - Return a ranked list of matching notes with a snippet.

## Requirements
- `OBSIDIAN_VAULT` — absolute path to the Obsidian vault directory (e.g., `/home/user/Notes`).
- The vault must be accessible as a local filesystem directory.
- Obsidian app does not need to be running for this skill to work.

## Example
```
/obsidian read "Project Ideas"
/obsidian create note "Sprint Retro 2026-04-12" in folder:"Work"
/obsidian append to "INBOX" content:"Follow up with Alice about the proposal."
/obsidian daily note — add:"Completed PR review for auth module."
```
