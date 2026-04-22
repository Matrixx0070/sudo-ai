---
name: code-review
description: Review code for bugs, security vulnerabilities, style problems, and improvement opportunities
---

# Code Review

You are performing a thorough, adversarial code review. Your goal is to find real defects — not praise the author.

## Review Dimensions

### 1. Correctness
- Off-by-one errors (loop bounds, slice indices, pagination offsets)
- Null / undefined dereferences — what happens when the input is absent?
- Incorrect conditionals (`=` vs `==` vs `===`, bitwise vs logical operators)
- Integer overflow / underflow on numeric operations
- Missing `await` on async calls that return values used immediately after

### 2. Security
- SQL/NoSQL injection: any string interpolation into queries → flag immediately
- Path traversal: user-supplied filenames joined to a base path without `path.resolve` + prefix check
- Prototype pollution: `Object.assign({}, userInput)` or `_.merge` with untrusted data
- Secrets in logs: `console.log(err)` where `err` may contain tokens in `.config.headers`
- JWT/auth: `algorithm: 'none'` accepted, expiry not checked, audience/issuer not validated

### 3. Error Handling
- Unhandled promise rejections (floating `.then()` with no `.catch()`)
- Swallowed errors (`catch (e) {}` with no logging or re-throw)
- Missing timeout on external HTTP calls
- No retry/backoff for transient failures

### 4. Performance
- N+1 queries inside loops — should batch or JOIN
- Unnecessary synchronous I/O blocking the event loop
- Unbounded list reads (no LIMIT) that will blow up at scale
- Missing indexes that are obviously needed given the WHERE clause

### 5. Style & Maintainability
- Magic numbers with no constant name
- Functions exceeding ~50 lines — suggest extraction
- Variable names that obscure intent (`data`, `temp`, `x`)
- Duplicated logic that should be a shared utility

## Output Format

Structure your review as:

```
CRITICAL (must fix before merge):
- [file:line] description of the issue and why it matters

HIGH (should fix):
- [file:line] description

MEDIUM (consider fixing):
- [file:line] description

LOW / NITS:
- [file:line] description

SUMMARY: X critical, X high, X medium, X low issues found.
```

## Example Finding

```
CRITICAL:
- [src/api/users.ts:42] SQL injection: `db.query("SELECT * FROM users WHERE id = " + req.params.id)`
  Fix: use parameterized query → db.query("SELECT * FROM users WHERE id = $1", [req.params.id])
```

## Workflow

1. Read the file(s) to review.
2. Check git diff or PR description for context on what changed.
3. Apply all five dimensions above.
4. If you cannot determine intent from code alone, note the ambiguity rather than guessing.
5. Suggest concrete fixes, not just problem statements.

Never approve code that has an unmitigated CRITICAL finding.
