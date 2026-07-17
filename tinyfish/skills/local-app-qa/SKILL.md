---
name: local-app-qa
description: Smoke-test a locally running web app with a real browser agent — tunnel the local port to a public HTTPS URL via tinyfi.sh, send the TinyFish browser agent through key user flows, and report pass/fail with evidence. Use when the user wants to test their local app, run smoke tests or QA on localhost, verify a dev build works end to end, or check that pages, forms, and navigation behave before deploying.
---

# Local App QA

Combine the `tunneling` and `use-tinyfish` skills into a QA loop: expose the local app, let a real browser agent use it like a human would, and report what passed and what broke.

## Pre-flight Check (REQUIRED)

All three must pass before proceeding:

```bash
which ssh || echo "SSH not found"
which tinyfish && tinyfish auth status
```

If the TinyFish CLI is missing or unauthenticated, give the install/login instructions from the `use-tinyfish` skill and stop.

## Safety (read before tunneling)

Tunneling makes the app **publicly reachable** for the duration of the test.

- Do NOT tunnel admin panels, debug endpoints, or apps holding real user data or secrets.
- Use **test accounts and test data only** in flows that log in or submit forms.
- Tear the tunnel down as soon as the test run finishes — never leave it up.

If the app looks sensitive, warn the user and get explicit confirmation first.

---

## Workflow

### 1. Find the app

Ask which port the app runs on if not stated. To detect candidates:

```bash
ss -tlnp 2>/dev/null | grep LISTEN || lsof -iTCP -sTCP:LISTEN -P -n
```

Confirm the app responds locally before tunneling (e.g. the process is up and listening).

### 2. Open the tunnel (background)

```bash
ssh -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=60 \
  -R 80:localhost:<PORT> tinyfi.sh
```

Run it in the background, capture the printed `https://<random>.tinyfi.sh` URL, and verify it serves the app:

```bash
tinyfish fetch content get --format markdown "https://<random>.tinyfi.sh"
```

If the fetch returns the app's content, the tunnel is live.

### 3. Define the test plan

Use the user's flows if given. Otherwise propose a smoke plan from what the fetched homepage reveals, e.g.:

- Home page loads with expected title/content
- Primary navigation links resolve (no 404s / error pages)
- Key form submits and shows its success state (test data only)
- Auth pages render; login works **only if the user provided test credentials**

Show the plan and confirm before running anything that submits data.

### 4. Run the flows

One `tinyfish agent run` per flow, launched in parallel, each with a strict JSON verdict:

```bash
tinyfish agent run --url "https://<random>.tinyfi.sh" \
  "Go to the pricing page via the nav, verify all plan cards show a name and price. Return JSON: {\"flow\": \"pricing-page\", \"status\": \"PASS\" or \"FAIL\", \"evidence\": str, \"details\": str}"
```

Goal-writing rules: one flow per run; state the exact steps; define PASS criteria explicitly; require `evidence` describing what the agent actually saw.

### 5. Report

Present a results table — flow, status, evidence — then details for each FAIL: what the agent saw vs. what was expected, and a hypothesis for the cause (missing route, JS error, broken form handler). Suggest a fix where the cause is clear.

### 6. Tear down (ALWAYS)

Kill the background SSH process and confirm the tunnel URL no longer serves the app. Do this even when runs fail midway.

## Re-testing after a fix

Keep the same test plan and re-run only the failed flows, then the full plan once everything passes. Reuse the tunnel if still open; otherwise open a fresh one (the URL will change).

$ARGUMENTS
