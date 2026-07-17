# Getting Unstuck: Consent Walls, Interstitials, and CAPTCHAs

The playbook that keeps a browser agent from ever hanging. Load this whenever a live-web run hits a wall, or proactively when a task starts on sites known for consent screens and bot checks (Google, large retailers, anything behind Cloudflare).

## The one principle

**A run always ends in a defined state — never an infinite wait.** Every agent goal must return one of:

- `DONE` — task completed, with evidence
- `BLOCKED` — a human must clear one step (CAPTCHA, login, 2FA); includes the URL and what's blocking
- `FAILED` — couldn't complete, with the reason

The "never stuck anywhere" guarantee comes from that rule plus **bounded retries and a human escape hatch** — not from defeating every obstacle. Grinding on a block is what gets agents stuck; detecting it and escalating is what keeps them moving.

Scope line: automate only what the user could legitimately do themselves at human scale. Do not use these techniques to mass-create accounts, evade bans or rate limits, scrape in violation of a site's terms, scalp, or otherwise defeat protections for abuse.

---

## Tier 1 — Auto-dismiss (do this automatically, always first)

These are the #1 cause of "stuck" and a human clears them with one click. Make dismissing them the **first instruction of every goal** on a fresh site.

| Wall | What to do |
|---|---|
| Cookie / GDPR consent banner | Click "Reject all" where offered (fewer downstream popups), else "Accept all" / "I agree" |
| Google "Before you continue to Google" (`consent.google.com`) | Choose "Reject all" or "Accept all" to reach results — either works |
| Age gate ("Are you 18+?") | Confirm to proceed (only for lawful, age-appropriate tasks) |
| Region / language interstitial | Pick the user's locale (or the site's default) and continue |
| Newsletter / discount / "open in app" modal | Close it (X, "No thanks", "Continue in browser") |
| Push-notification permission prompt | Dismiss / block |

**Goal snippet — bake dismissal in:**

```bash
tinyfish agent run --url "https://www.google.com/search?q=site+reviews" \
  "First, if a cookie or Google consent screen appears, click 'Reject all' (or 'Accept all') to dismiss it. Then <the actual task>. Return JSON: {\"status\": \"DONE\"|\"BLOCKED\"|\"FAILED\", \"blocked_by\": str, \"url\": str, \"evidence\": str}"
```

## Tier 2 — Soft blocks (handle, don't fight)

- **"Continue to site" interstitials / redirects** — follow the continue link.
- **Rate limiting ("you're going too fast")** — back off, wait, retry **once**. If it persists, return `FAILED` with the reason; don't hammer.
- **Paywalls** — respect them. Do not attempt to bypass. Report it, and offer a legitimate alternative (an official free source, a different site from `tinyfish search`, or ask the user for access).

## Tier 3 — CAPTCHAs & bot checks (detect → escalate, never grind)

**Recognize them fast:** reCAPTCHA ("I'm not a robot", image grids), hCaptcha, Cloudflare Turnstile / "Checking your browser before you continue…", Amazon "Robot Check", press-and-hold buttons, Arkose/FunCaptcha puzzles.

**Policy:**

1. **Let the provider try first.** TinyFish runs real browsers server-side, so many interstitial checks (Cloudflare "checking your browser", invisible reCAPTCHA v3) clear on their own — after a short wait, re-read the page and continue if it passed.
2. **Do not loop.** One re-check, max one retry. Never enter a solve-retry loop — that is the classic stuck state.
3. **If still blocked, escalate to a human.** Two ways:
   - **Return `BLOCKED`** to the user with the exact URL and what's blocking, so they complete that one step (e.g., in their own browser), then ask you to resume.
   - **Hand off in a live session** — open a browser session the user can view and interact with, ask them to solve the check in that window, wait, then continue via CDP (see below).
4. **Logins, 2FA, OTP/SMS codes** — always human-provided. Never attempt to guess or bypass. Treat a 2FA prompt exactly like a CAPTCHA: `BLOCKED` → human handoff → resume.

## The anti-stuck escalation ladder

```
agent run  (dismiss consent first · per-step goal · JSON status with blocked_by)
   │  status == DONE ─────────────► report result + evidence
   │  status == BLOCKED (captcha/login/2fa)
   ▼
browser session create  (human-visible)  ──► ask user to clear the one blocker
   │                                              in the live window, then wait
   ▼
resume remaining steps via CDP  ──►  verify end state  ──►  report
   │  still blocked after human help, or FAILED
   ▼
return BLOCKED/FAILED to user with URL + exact reason  (never hang)
```

Guardrails on every rung: a per-step timeout, **at most one retry**, and a structured terminal status. If nothing has changed after a retry, escalate — don't wait again.

## Human-handoff via a live browser session

When you need the user to solve a check themselves:

```bash
# Open a session the user can watch/drive
tinyfish browser session create --url "https://blocked-site.com/step"
# Returns { session_id, cdp_url, base_url }
```

Give the user the viewable URL, tell them exactly what to do ("solve the CAPTCHA / sign in — I'll take it from there"), wait for their go-ahead, then reconnect over `cdp_url` (Playwright `chromium.connectOverCDP`) and finish the flow. Keep any credentials transient — pass them at runtime, never persist them to a file.

## Reusable "reports-a-block-instead-of-hanging" goal

Use this shape for any consequential single-site flow so the caller always gets a verdict:

```bash
tinyfish agent run --url "<url>" \
  "Step 1: dismiss any cookie/consent/age/region wall (prefer 'Reject all'). \
   Step 2: <the task, with exact inputs and a clear stop condition>. \
   If you hit a CAPTCHA, bot check, login, or 2FA you cannot pass, STOP and do not retry. \
   Return JSON: {\"status\": \"DONE\"|\"BLOCKED\"|\"FAILED\", \"blocked_by\": \"none\"|\"captcha\"|\"login\"|\"2fa\"|\"paywall\"|\"ratelimit\"|\"other\", \"url\": str, \"evidence\": str, \"details\": str}"
```

Branch on `status`: `DONE` → verify and report; `BLOCKED` → run the escalation ladder; `FAILED` → report the reason and offer an alternative.
