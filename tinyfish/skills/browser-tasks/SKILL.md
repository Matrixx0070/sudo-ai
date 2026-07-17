---
name: browser-tasks
description: 'Do anything a human can do in a browser — fill and submit forms, search and filter, add to cart, book, register, download, compare across tabs, walk multi-step flows — using the TinyFish agent, with browser sessions for full control. Use when the user asks to "do X on a site" for them: fill out this form, sign me up, find and apply the filter, check out, book the slot, complete this flow online.'
---

# Browser Tasks

The playbook for acting on the web like a human would, not just reading it. Built on the `use-tinyfish` ladder — this skill covers the **act** side: clicks, forms, flows, and their consequences.

## Pre-flight Check (REQUIRED)

Run the `use-tinyfish` pre-flight (CLI installed + authenticated). Stop with install/login instructions if either fails.

## Ground Rules (non-negotiable)

Acting has consequences reading doesn't. Before ANY step that is irreversible or has real-world effect — placing an order, making a payment, submitting an application, sending a message, deleting something, agreeing to terms — **stop and get the user's explicit confirmation with the exact details** (what will be submitted, to whom, cost if any). Never confirm on the user's behalf.

- Use credentials, personal details, or payment info **only** if the user explicitly provided them for this task. Never guess, reuse, or invent them.
- Prefer stopping one step before the point of no return: fill the cart, reach the review screen, then report back and let the user decide.
- Don't automate actions the user couldn't legitimately do themselves (fake accounts, vote manipulation, scalping, evading bans).

---

## Decomposing "do this for me"

Break the human task into steps a browser agent can verify, then pick the tool per step:

| Step looks like | Tool |
|---|---|
| Find the right site/page | `tinyfish search query` |
| Read/compare page content | `tinyfish fetch content get` |
| Click, type, filter, submit, navigate one site | `tinyfish agent run` |
| Stateful multi-page flow, logins, downloads, precise control | `tinyfish browser session create` + CDP |

Multiple independent sites (compare, cross-post, check each) → separate parallel `agent run` calls, one site per goal — never one combined goal.

## Writing goals that act reliably

State the steps, the inputs, the stop condition, and the proof:

```bash
tinyfish agent run --url "https://example.com/contact" \
  "Fill the contact form: name 'Frank', email 'frank@example.com', message 'Requesting a quote for 100 units'. Submit it. Return JSON: {\"submitted\": bool, \"confirmation_text\": str, \"error\": str}"
```

- Give exact input values in the goal — never let the agent improvise user data.
- Define the stop condition ("stop at the order review page — do NOT place the order").
- Always demand JSON proof of the end state: confirmation text, order summary, visible error.
- One site, one flow per run. Chain runs for multi-phase tasks, checking each result before the next.

## Getting unstuck (consent walls, CAPTCHAs, logins)

The things that hang browser agents. Handle them so a run never stalls:

- **Auto-dismiss the easy walls first.** Make "dismiss any cookie/consent/age/region wall" the first step of every goal on a fresh site — Google's "Before you continue", GDPR banners, newsletter and "open in app" modals. Prefer "Reject all" where offered.
- **Detect CAPTCHAs and bot checks; do not grind.** reCAPTCHA, hCaptcha, Cloudflare "Checking your browser", Amazon Robot Check, press-and-hold. Let the provider's real browser clear invisible checks (re-read the page after a short wait), retry at most once, then escalate.
- **Escalate to a human instead of looping.** Return a `BLOCKED` status (with the URL and what's blocking) so the user can clear that one step, or hand off in a live `browser session` for them to solve it, then resume via CDP. Logins, 2FA, and OTP codes are always human-provided.
- **Every goal returns a verdict, never a hang** — `DONE` / `BLOCKED` / `FAILED` with `blocked_by`, under a per-step timeout and a one-retry cap.

Full detection signals, tier-by-tier tactics, the escalation ladder, and ready-to-use goal templates are in `references/unblocking.md` — read it when a page blocks you or before starting on block-prone sites. Only automate what the user could legitimately do themselves; never defeat protections for abuse.

## Verifying the outcome

An agent claiming success isn't proof. After any consequential action, verify independently: a second `agent run` or `fetch` that checks the resulting state (the booking appears in "my reservations", the post is live, the form shows its confirmation page). Report to the user what was verified, not just what was attempted.

## Escalating to a raw browser session

When the agent can't hold a flow (login walls with the user's credentials, file downloads/uploads, drag-and-drop, iframes, pixel-precise steps):

```bash
tinyfish browser session create --url "https://example.com"
```

Connect to the returned `cdp_url` with Playwright (`chromium.connectOverCDP`) or any CDP client and script the flow yourself. Same ground rules apply — pause the script and confirm with the user before the irreversible step. Handle credentials transiently: pass them into the script at runtime; never write them into files that persist.

## Reporting

After the task: what was done step by step, the verified end state with evidence, anything left deliberately unconfirmed and what the user must do to finish it. If a step failed, say where the flow stopped and what the page showed.

$ARGUMENTS
