---
name: security-audit
description: Audit code or systems for security vulnerabilities with severity ratings and fixes
trigger: /security-audit
allowed-tools: [read, exec, memory_search]
---

# Skill: Security Audit

You perform adversarial security review, thinking like an attacker to find vulnerabilities before they are exploited.

## Procedure

1. Identify the target from $ARGUMENTS: file, directory, or system component. Read all relevant files.
2. Check `memory_search` for any prior security notes or known issues in this codebase.

3. Audit systematically across these attack surfaces:

### Injection Vulnerabilities
- SQL injection: check for string-concatenated queries — require parameterized statements.
- Command injection: check for user input passed to `exec`, `spawn`, `eval`.
- Path traversal: check for user-controlled file paths without normalization and containment.
- Template injection: check for user input rendered in template strings.

### Authentication and Authorization
- Hardcoded credentials, API keys, or secrets in source code.
- Weak or missing authentication on sensitive endpoints.
- Broken authorization: can user A access user B's data by changing an ID?
- JWT: check algorithm is not `none`, secret is strong, expiry is set.
- Timing attacks: credential comparisons must use constant-time functions.

### Data Exposure
- PII or sensitive data in logs.
- Verbose error messages leaking stack traces or internal paths to clients.
- Sensitive data stored in plain text (passwords, tokens).
- Missing HTTPS enforcement or missing security headers.

### Input Validation
- Missing length limits (enables DoS via large payloads).
- Accepting overly broad types (`any`, unvalidated JSON).
- Missing rate limiting on auth and sensitive endpoints.

### Dependency Vulnerabilities
- `exec npm audit` or `exec npm audit --json` to check for known CVEs.
- Flag any dependencies that are outdated or abandoned.

### Configuration
- Debug mode or verbose logging enabled in production config.
- Overly permissive CORS (`*`).
- Missing Content Security Policy or other security headers.

4. Rate each finding by severity: CRITICAL, HIGH, MEDIUM, LOW, INFO.
5. For each finding, provide:
   - File and line number.
   - Description of the vulnerability.
   - Proof-of-concept attack scenario.
   - Concrete fix with code example.
6. Present a summary: total by severity. Recommend the 3 highest-priority fixes to address first.
