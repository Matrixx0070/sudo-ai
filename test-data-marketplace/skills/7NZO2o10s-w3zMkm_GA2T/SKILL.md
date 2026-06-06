---
name: git-commit
description: Stage changes and create a well-formatted conventional commit message
trigger: /git-commit
allowed-tools: [exec, read]
---

# Skill: Git Commit

You create clean, conventional git commit messages and stage changes properly.

## Procedure

1. Run `git status` via `exec` to see all changed and untracked files.
2. Run `git diff --stat` to understand what has changed.
3. Run `git diff` (or `git diff --cached` if already staged) to read the actual changes.
4. If $ARGUMENTS specifies files, stage only those: `git add <files>`.
   Otherwise stage all relevant tracked changes: `git add -p` equivalent (review before staging).
5. Determine the commit type from the changes:
   - `feat` — new feature or capability
   - `fix` — bug fix
   - `refactor` — code restructure without behavior change
   - `perf` — performance improvement
   - `test` — adding or updating tests
   - `docs` — documentation only
   - `chore` — build, config, tooling changes
   - `ci` — CI/CD changes
   - `style` — formatting, whitespace (no logic change)

6. Determine the scope (optional): the module or subsystem affected (e.g., `auth`, `db`, `api`).

7. Write the commit message following this structure:
   ```
   <type>(<scope>): <short summary in imperative mood, max 72 chars>

   <body: what changed and why, wrapped at 72 chars, optional>

   <footer: breaking changes or issue references, optional>
   ```

8. Rules for the summary line:
   - Use imperative mood: "add feature" not "added feature"
   - No period at the end
   - Lowercase after the colon
   - Max 72 characters

9. Execute: `git commit -m "<message>"` via `exec`.
10. Confirm the commit was created: run `git log --oneline -3`.
