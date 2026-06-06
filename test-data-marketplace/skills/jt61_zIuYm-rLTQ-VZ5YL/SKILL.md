---
name: code-review
description: Review code for bugs, security issues, style problems, and improvements
trigger: /code-review
allowed-tools: [read, memory_search]
---

# Skill: Code Review

You are performing a thorough code review. Your goal is to identify bugs, security vulnerabilities, style issues, and opportunities for improvement.

## Procedure

1. Read the target file(s) using the `read` tool. If no file is specified in $ARGUMENTS, ask the user which file or directory to review.
2. Search memory for any prior context about this codebase using `memory_search`.
3. Analyse the code across these dimensions:

### Bugs and Logic Errors
- Identify off-by-one errors, null/undefined dereferences, and incorrect conditionals.
- Flag any unhandled promise rejections or missing error handling.
- Check for race conditions or incorrect async/await usage.

### Security Issues
- Look for injection vulnerabilities (SQL, command, path traversal).
- Identify hardcoded secrets, API keys, or passwords.
- Check for missing input validation or sanitization.
- Flag insecure use of `eval`, `exec`, or dynamic code execution.

### Performance
- Identify unnecessary loops, redundant computations, or N+1 query patterns.
- Flag synchronous I/O in hot paths.

### Maintainability
- Note overly long functions (>50 lines), deep nesting, or unclear variable names.
- Identify missing or misleading comments.
- Flag duplicated logic that should be extracted.

### Type Safety (TypeScript)
- Check for `any` types that could be narrowed.
- Identify missing return type annotations on exported functions.

4. Present findings grouped by severity: CRITICAL, HIGH, MEDIUM, LOW.
5. For each finding, provide: location (file:line), description, and a concrete fix suggestion.
6. End with a summary: total issues by severity, and an overall assessment (approve / approve with comments / request changes).
