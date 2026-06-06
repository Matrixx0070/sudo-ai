---
name: onepassword
description: Retrieve secrets and credentials from 1Password vaults using the op CLI.
trigger: /1password, get secret, 1password, op vault, retrieve credential, fetch password
allowed-tools: [exec.run]
---

# Skill: 1Password

## Purpose
Retrieve secrets, passwords, API keys, and secure notes from 1Password vaults
using the `op` CLI. Never stores or logs secret values.

## When to use
- User or another skill needs a credential stored in 1Password
- User wants to list available vaults or items
- User wants to inject a secret into an environment variable or config file
- Agent needs to fetch an API key securely without hardcoding it

## How to use

1. Verify that the `op` CLI is installed: `exec.run: op --version`
   If not found, inform the user to install 1Password CLI and stop.

2. Check authentication status: `exec.run: op account list`
   If no accounts listed, prompt user to run `op signin` manually (agent cannot sign in interactively).

3. **Get a specific field from an item:**
   ```
   op read "op://<vault>/<item>/<field>"
   ```
   Examples:
   - `op read "op://Personal/GitHub/password"`
   - `op read "op://Work/AWS/access_key_id"`

4. **List vaults:**
   ```
   op vault list --format=json
   ```

5. **List items in a vault:**
   ```
   op item list --vault "<vault_name>" --format=json
   ```

6. **Get full item details:**
   ```
   op item get "<item_name>" --vault "<vault_name>" --format=json
   ```

7. **Use a secret in another command:**
   - Inject inline: `op run --env-file=<path> -- <command>`
   - Or fetch and pass as argument (do NOT log the value).

8. Security rules:
   - NEVER log, print, or store secret values in files or memory.
   - Only reveal values directly in the user's terminal session if explicitly requested.
   - Prefer `op run` injection over reading values directly.

## Requirements
- `op` CLI installed (see: https://developer.1password.com/docs/cli/get-started)
- User must be signed in via `op signin` or via 1Password desktop app integration.
- No environment variable required — authentication is handled by the op CLI itself.

## Example
```
/1password get "op://Work/SUDO-AI/api_key"
/1password list vault Work
/1password get item "GitHub Token" vault Personal field password
```
