---
name: eng-deploy-checklist
version: 1.1.0
description: Run a pre-deploy verification covering code readiness, migrations, flags, config, observability, and a tested rollback before promoting to a shared environment.
author: matrixx0070
tags: [deploy, release, rollback, migrations, ci, feature-flags]
capabilities: []
---

## When to use

Immediately before promoting a change to a shared or production environment. The goal is to catch the failure that would page someone at 3am — and to know how to undo the release fast.

**Not for:** local runs, throwaway preview branches, or docs-only changes with no runtime surface. Match the rigor to the blast radius.

## Method

1. **Code readiness.** Target commit is on the intended branch, CI is green, required approvals are in, and the diff ships only what this release intends. If CI is red or the diff has unrelated changes, stop — no-go.
2. **Migrations.** Schema changes must be backward-compatible with currently-running code (expand-then-contract), reversible or forward-fixable, and tested on a production-shaped dataset. If a migration is long-running, run it out-of-band before the deploy, not inline.
3. **Feature flags.** New behavior ships dark or ramped; default state is safe; a kill-switch exists and has been exercised.
4. **Config & secrets.** New env vars/keys exist in the target environment. Never assume `--update-env` removed deleted keys — verify the running process sees the intended set.
5. **Observability.** Dashboards, logs, and alerts cover the new path. Name the metric that proves success and the signal that proves failure.
6. **Rollback plan.** Write the exact rollback command, the error-rate/latency thresholds that trigger it, and who decides. If you can't state the rollback, you're not ready to deploy.
7. **Sequencing.** Order dependent steps (migrate → deploy → flip flag), name the deploy window and on-call owner, and confirm nobody else is mid-deploy.

## Example

```
Release: orders-v2 / commit a1b2c3d / production
Checklist:
  Code readiness .... PASS  (CI green, 2 approvals, diff scoped)
  Migrations ........ PASS  (add nullable col, expand phase only)
  Feature flags ..... PASS  (orders_v2 default off, kill-switch tested)
  Config/secrets .... FAIL  (ORDERS_V2_URL missing in prod)
Blocking: set ORDERS_V2_URL in prod before deploy.
Rollback: `deploy rollback orders a1b2c3d`; trigger if 5xx >2% for 5m; owner @oncall.
Recommendation: NO-GO until config fixed.
```

## Pitfalls

- **Backward-incompatible migration** deployed with old code still running → mid-deploy errors.
- **Rollback that was never tested** — discovering it doesn't work during the incident.
- **Flag defaulting on**, so the "dark" launch is live to everyone immediately.
- **Assuming config propagated** instead of verifying the running process's actual environment.
- **No post-deploy verification window.** Declaring success at "deploy finished" instead of watching the success metric for a defined bake period (e.g. 15m); most bad releases look fine for the first 60 seconds.
- **Deploying at the worst time.** Friday evening, during peak traffic, or with no on-call reachable — the checklist can pass and the release still be reckless.

## Post-deploy verification (the deploy is not done at "deployed")

1. Immediately: process is up, health endpoint green, version/commit reported by the running process matches the release.
2. Bake period (define it up front, e.g. 15-30m): watch the named success metric and failure signal from step 5; compare error rate and latency to pre-deploy baseline, not to zero.
3. Exercise the new path once yourself (or via smoke test) — a green health check does not prove the new feature works.
4. Only after the bake period passes, mark the release done and record the version + outcome; if the failure signal fires, execute the rollback plan without debate — debug from the rolled-back state.

## Output format

```
Release: <name / commit / environment>
Checklist (PASS | FAIL | N/A, one-line note each):
  Code readiness / Migrations / Feature flags / Config & secrets /
  Observability / Rollback plan / Sequencing
Blocking issues: <must-fix before deploy>
Rollback plan: <trigger thresholds + exact command + owner>
Recommendation: GO | NO-GO
```
