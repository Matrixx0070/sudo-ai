---
name: himalaya-email
description: Send and receive email via local IMAP/SMTP using the himalaya CLI client.
trigger: /himalaya, local email, imap email, send email himalaya, check email, read email imap
allowed-tools: [exec.run]
---

# Skill: Himalaya Email

## Purpose
Send and receive email through any IMAP/SMTP provider using the `himalaya` CLI.
Works with Gmail, Fastmail, self-hosted servers, and any standard IMAP/SMTP setup.
Requires no OAuth — uses standard email credentials configured in himalaya's config.

## When to use
- User wants to send or read email without Gmail/OAuth setup
- User has a self-hosted or IMAP-based email account
- User wants to manage multiple email accounts via a unified CLI interface
- User needs to list, search, read, or reply to emails from the terminal

## How to use

1. Verify himalaya is installed: `exec.run: himalaya --version`
   If not found, suggest: `cargo install himalaya` or check distro packages.

2. Verify configuration exists: `exec.run: himalaya account list`
   If no accounts configured, direct user to `~/.config/himalaya/config.toml`.

3. **List emails in inbox:**
   ```
   himalaya envelope list --account <account> --folder INBOX --max-width 0
   ```
   Presents: ID, from, subject, date.

4. **Read a specific email:**
   ```
   himalaya message read <id> --account <account>
   ```
   Display headers + plain-text body. If HTML-only, note that rendering is limited.

5. **Send an email:**
   ```
   himalaya message send --account <account> \
     --to "<recipient>" \
     --subject "<subject>" \
     --body "<body text>"
   ```
   Confirm with sent message ID if returned.

6. **Reply to an email:**
   ```
   himalaya message reply <id> --account <account> --all
   ```
   Compose body and pass via stdin or `--body` flag.

7. **Search emails:**
   ```
   himalaya envelope search "FROM alice@example.com" --folder INBOX
   ```
   Supports standard IMAP search criteria.

8. **Move or delete:**
   - Move: `himalaya message move <id> --account <account> --folder Archive`
   - Delete: `himalaya message delete <id> --account <account>`

## Requirements
- `himalaya` CLI installed (`cargo install himalaya` or system package).
- Valid `~/.config/himalaya/config.toml` with at least one account configured.
- No additional environment variables required if config file is present.

## Example
```
/himalaya list inbox
/himalaya read 42
/himalaya send to:bob@example.com subject:"Hello" body:"Quick note."
/himalaya search FROM:alice@example.com
```
