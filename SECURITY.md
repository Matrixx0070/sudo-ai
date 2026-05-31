# Security Policy

## Supported Versions

| Version | Status |
|---|---|
| 4.1.x | Active support |
| < 4.1 | End-of-life — update recommended |

Security patches are applied to the latest minor release. Users should run `git pull` regularly or subscribe to release notifications.

---

## Reporting a Vulnerability

If you discover a security vulnerability, please report it privately rather than opening a public issue.

**Preferred method:**
- Open a **private security advisory** on GitHub (`Security → Advisories → New draft security advisory`)

**Alternative:**
- Email details to the repository owner (see commit metadata for contact)

Please include:
- A description of the vulnerability
- Steps to reproduce (minimal test case preferred)
- Impact assessment (what data or functionality is at risk)
- Suggested fix or mitigation, if any

We aim to acknowledge reports within **48 hours** and ship fixes within **7 days** for HIGH/CRITICAL severity.

---

## Security Architecture Overview

SUDO-AI implements defense-in-depth across multiple layers:

1. **Prompt Injection Detection** — Score-based pattern scanning on user and tool inputs. Triggers replan or blocks execution when confidence exceeds threshold.

2. **Sandboxed Execution** — Untrusted code runs inside bubblewrap with UID/GID drop, seccomp BPF allowlists, and an optional LD_PRELOAD execve seal.

3. **Tool Gate** — Dangerous operations (destructive exec, cloud metadata endpoints, private-IP SSRF) are blocked at the tool-router layer before reaching the OS.

4. **Audit & Observability** — Structured security events are logged to `data/logs/security.log`. Prometheus-compatible metrics expose injection-attempt counters and veto-gate decisions.

Each layer can be independently disabled via kill-switch environment variables for debugging or recovery. These are documented in [docs/api-reference.md](docs/api-reference.md).

---

## Disclosure Policy

- We follow **coordinated disclosure**: fixes are developed and tested before public announcement
- Reporters are credited in the advisory/release notes unless they request anonymity
- LOW-severity issues may be bundled into routine releases rather than emergency patches
