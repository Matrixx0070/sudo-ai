---
name: git-workflow
description: Branch, commit, merge, and release using Git best practices including conventional commits and rebase workflow
triggers:
  - git workflow
  - branching strategy
  - git branching
  - rebase or merge
  - merge strategy
---

# Git Workflow

You advise on and execute Git operations following a clean, reversible, team-friendly workflow.

## Branch Naming Convention

```
<type>/<ticket-or-brief>

feature/PROJ-123-user-auth
fix/PROJ-456-null-crash
chore/bump-dependencies
release/v2.4.0
hotfix/PROJ-789-payment-timeout
```

Never commit directly to `main` or `master`. Always branch.

## Conventional Commits

Format: `<type>(<scope>): <subject>`

Subject: imperative mood, lowercase, no period, ≤72 chars.

```
feat(auth): add OAuth2 PKCE flow
fix(queue): prevent duplicate message processing on reconnect
chore(deps): upgrade fastify to 4.28.1
refactor(db): extract query builder into separate module
test(api): add integration tests for invoice creation
docs(readme): document environment variables
perf(cache): replace LRU with Redis to reduce cold starts
```

Body (optional): explain WHY, not WHAT. WHAT is in the diff.

Footer for breaking changes:
```
feat(api)!: remove deprecated /v1/users/me endpoint

BREAKING CHANGE: use /v1/me instead. Migration guide in CHANGELOG.md.
```

## Feature Branch Workflow

```bash
# 1. Start from a fresh main
git checkout main && git pull

# 2. Create feature branch
git checkout -b feature/PROJ-123-user-auth

# 3. Work, committing frequently
git add -p          # stage hunks, not whole files
git commit -m "feat(auth): scaffold OAuth2 callback handler"

# 4. Keep branch current (prefer rebase over merge)
git fetch origin
git rebase origin/main   # replays your commits on top of updated main

# 5. Fix conflicts during rebase
git status          # see conflicted files
# edit to resolve
git add <resolved-files>
git rebase --continue

# 6. Push
git push -u origin feature/PROJ-123-user-auth

# 7. Open PR, get review, squash-merge or rebase-merge to main
```

## Squash Merge vs Merge Commit vs Rebase

| Strategy | Result | When to use |
|----------|--------|-------------|
| Squash merge | 1 clean commit on main per PR | Most common — clean history |
| Rebase merge | N commits, linearized | When commit history has value |
| Merge commit | Creates a merge commit | Avoid on main — clutters log |

## Undoing Things

```bash
# Undo last commit, keep changes staged
git reset --soft HEAD~1

# Undo last commit, keep changes unstaged
git reset HEAD~1

# Discard last commit AND changes (DESTRUCTIVE)
git reset --hard HEAD~1

# Undo a pushed commit safely (creates a revert commit)
git revert <sha>
git push

# Unstage a file
git restore --staged <file>

# Discard working-tree changes to a file
git restore <file>
```

## Tagging a Release

```bash
git checkout main && git pull
git tag -a v2.4.0 -m "Release v2.4.0 — see CHANGELOG.md"
git push origin v2.4.0
```

## Useful One-Liners

```bash
# Show log as graph
git log --oneline --graph --decorate --all

# Find which commit introduced a string
git log -S "function processPayment" --oneline

# See what changed between two branches
git diff main...feature/my-branch

# List branches merged into main (safe to delete)
git branch --merged main
```

## Pre-commit Hook (recommended)

Install `pre-commit` or run lint/type-check automatically:
```bash
# .git/hooks/pre-commit
#!/bin/sh
npm run lint && npm run tsc:check
```
This catches errors before they reach CI.
