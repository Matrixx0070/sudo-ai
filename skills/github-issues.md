---
name: github-issues
description: Create, comment on, and close GitHub issues using the GitHub API or gh CLI.
trigger: /github-issues, create issue, github issue, open issue, close issue, comment on issue, list issues
allowed-tools: [web.fetch, exec.run]
---

# Skill: GitHub Issues

## Purpose
Manage GitHub issues: create new issues with labels and assignees, list open issues,
add comments to existing issues, and close or reopen issues.

## When to use
- User wants to file a new bug report or feature request on GitHub
- User wants to see open issues on a repository
- User wants to comment on or close an existing issue
- User wants to link a commit or PR to an issue

## How to use

1. Check that `GITHUB_TOKEN` is set in the environment. If missing, check if `gh` CLI is
   authenticated (`exec.run: gh auth status`). If neither, inform the user and stop.

2. **Preferred method — gh CLI** (if available):
   - Create: `gh issue create --repo <owner/repo> --title "<title>" --body "<body>" --label "<label>"`
   - List: `gh issue list --repo <owner/repo> --state open --limit 20`
   - View: `gh issue view <number> --repo <owner/repo>`
   - Comment: `gh issue comment <number> --repo <owner/repo> --body "<comment>"`
   - Close: `gh issue close <number> --repo <owner/repo>`
   - Reopen: `gh issue reopen <number> --repo <owner/repo>`

3. **Fallback — GitHub REST API via web.fetch:**
   - Base URL: `https://api.github.com/repos/<owner>/<repo>/issues`
   - Headers: `Authorization: token $GITHUB_TOKEN`, `Accept: application/vnd.github+json`
   - Create issue: POST with `{ "title", "body", "labels", "assignees" }`
   - List issues: GET with `?state=open&per_page=20`
   - Add comment: POST `<base_url>/<number>/comments` with `{ "body" }`
   - Close issue: PATCH `<base_url>/<number>` with `{ "state": "closed" }`

4. Extract `<owner>/<repo>` from `$ARGUMENTS`, or detect from current git remote (`exec.run: git remote get-url origin`).

5. For issue bodies, use GitHub-flavored Markdown. Include reproduction steps for bugs.

## Requirements
- `GITHUB_TOKEN` — personal access token or fine-grained token with `issues:write` scope.
- OR `gh` CLI authenticated via `gh auth login`.
- Repository must be accessible with the provided credentials.

## Example
```
/github-issues create repo:myorg/myapp title:"Login fails on Safari" label:bug
/github-issues list repo:myorg/myapp
/github-issues comment 42 repo:myorg/myapp "Fixed in branch fix/safari-login"
/github-issues close 42 repo:myorg/myapp
```
