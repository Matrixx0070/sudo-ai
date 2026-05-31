# AutoBugFix Wave — Architect Spec

## Overview
Autonomous error-capture → GitHub issue → auto-fix → deploy pipeline. Errors from tool failures and health check degradations create deduplicated GitHub issues. Eligible issues (HIGH+/CRITICAL, src/core/, known fix pattern) trigger self-build auto-fix. Successful PRs auto-deploy via pm2.

## Architecture
```
ErrorReporter ──► GitHubIssuesConnector ──► AutoFixTrigger ──► Orchestrator ──► DeploymentHook
      ▲              (REST API)                (poll issues)    (commit+PR)      (CI+deploy)
      │
  Hook subscriptions:
  - after:tool-call (failures)
  - session:end (summary)
  - watchdog:_logSummary (critical)
```

## Kill-Switches (exact === '1')
- `SUDO_AUTOFIX_DISABLE` — skip auto-fix trigger
- `SUDO_AUTODEPLOY_DISABLE` — skip deployment
- `SUDO_GITHUB_ISSUES_DISABLE` — log locally, don't create issues
- `SUDO_HEALTH_ALERT_DISABLE` — watchdog skips ErrorReporter
- `SUDO_AUTOFIX_MAX_PER_HOUR` — default 1
- `SUDO_AUTOFIX_MIN_SEVERITY` — default 'HIGH'

## Env
- `GITHUB_TOKEN` — required PAT
- `GITHUB_OWNER` / `GITHUB_REPO` — default from git remote

## Module A: ErrorReporter (src/core/health/error-reporter.ts)
- Subscribe hooks: after:tool-call, session:end, error:captured
- Severity: CRITICAL (crash), HIGH (tool failure prod), MEDIUM (health degradation), LOW (cosmetic)
- Deduplicate: check ErrorMemory + GitHub search for open issue with same normalized signature
- Issue template: title, body with stack trace, env (Node version, commit SHA, sudo version), severity label
- If existing issue found → add comment instead of new issue

## Module B: GitHubIssuesConnector (src/core/channels/github-issues.ts)
- REST API v3 wrapper
- Methods: createIssue, searchIssues, addComment, closeIssue, addLabel
- Auth: Bearer GITHUB_TOKEN
- Rate limit: handle 429, expose remaining count
- Deduplication query: `repo:owner/repo is:issue is:open label:"auto-fix" "signature"`

## Module C: AutoFixTrigger (src/core/self-build/auto-fix-trigger.ts)
- Poll for issues labeled "auto-fix" or severity HIGH+/CRITICAL
- Rate limit: max 1/hour (configurable)
- Eligibility gates:
  - Error in src/core/ path
  - ErrorMemory.suggestFix() returns known pattern
  - Severity >= SUDO_AUTOFIX_MIN_SEVERITY
- Creates branch: `auto-fix/<issue-number>-<short-desc>`
- Triggers self-build orchestrator tick with issue context
- Creates PR via existing github-integration.ts with "fixes #N" in body
- Labels PR with "auto-fix"

## Module D: DeploymentHook (src/core/self-build/deployment-hook.ts)
- Monitor PR status after auto-fix PR creation
- Detect CI pass + merged state
- Run `pnpm lint && pnpm test`
- Deploy: `pm2 reload sudo-ai-v5 --update-env`
- Failure → rollback to previous commit, add comment to issue

## Module E: HealthAlertReporter (modify src/core/health/watchdog.ts)
- In _logSummary(), call ErrorReporter for critical checks
- Escalate repeated degradation (same check fails 3+ times) to HIGH
- Track consecutive failures per check name

## Database Schema (data/mind.db)
```sql
CREATE TABLE IF NOT EXISTS auto_fix_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_number INTEGER NOT NULL,
  error_signature TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  fixed_at TEXT,
  commit_sha TEXT,
  pr_number INTEGER,
  deployment_sha TEXT,
  deployed_at TEXT
);
CREATE INDEX idx_auto_fix_issue ON auto_fix_log(issue_number);
CREATE INDEX idx_auto_fix_signature ON auto_fix_log(error_signature);
CREATE INDEX idx_auto_fix_status ON auto_fix_log(status);

CREATE TABLE IF NOT EXISTS auto_fix_rate_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  executed_at TEXT NOT NULL,
  issue_number INTEGER NOT NULL
);
CREATE INDEX idx_rate_log_time ON auto_fix_rate_log(executed_at);
```

## Tests
- Unit tests per module (mock GitHub API, mock ErrorMemory)
- Integration test: full flow error→issue→fix→deploy
- Deduplication test, rate limit test, kill-switch test

## File Ownership
| File | Builder |
|---|---|
| src/core/health/error-reporter.ts | Builder A |
| src/core/health/error-reporter.test.ts | Builder A |
| src/core/health/watchdog.ts (modify) | Builder A |
| src/core/channels/github-issues.ts | Builder B |
| src/core/channels/github-issues.test.ts | Builder B |
| src/core/self-build/auto-fix-trigger.ts | Builder C |
| src/core/self-build/auto-fix-trigger.test.ts | Builder C |
| src/core/self-build/deployment-hook.ts | Builder D |
| src/core/self-build/deployment-hook.test.ts | Builder D |
| DB migration | Builder A |
