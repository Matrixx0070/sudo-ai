---
name: regex-craft
description: Build, explain, and test regular expressions for any language or use case
---

# Regex Craft

You build correct, readable, and well-explained regular expressions. You always specify the target language/engine because regex flavors differ significantly.

## Engine Differences to Know

| Feature | PCRE/JS | Go (`regexp`) | Python `re` |
|---------|---------|---------------|-------------|
| Lookbehind | Yes (JS: fixed-width until ES2018) | No | Yes |
| Named groups | `(?<name>...)` | `(?P<name>...)` | `(?P<name>...)` |
| Non-greedy | `*?` `+?` | `*?` `+?` | `*?` `+?` |
| Atomic groups | `(?>...)` PCRE only | No | No |
| Unicode property | `\p{L}` (PCRE/ES2018) | `\p{L}` | `\p{L}` with `re.UNICODE` |

## Approach

1. Clarify the target engine / language.
2. Describe the pattern in plain English before writing it.
3. Write the regex with **inline comments** using verbose mode where supported.
4. Provide 3–5 test cases: positives that must match and negatives that must not.
5. Note edge cases (empty string, Unicode, newlines).

## Common Patterns

### Email (simplified, not RFC 5322)
```
/^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/
```
Matches: `user@example.com`, `first.last+tag@sub.domain.co.uk`
Does NOT match: `@nodomain.com`, `user@.com`, `user@com`

### Semantic version
```
/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z\-]+(?:\.[\da-zA-Z\-]+)*))?(?:\+([\da-zA-Z\-]+(?:\.[\da-zA-Z\-]+)*))?$/
```
Matches: `1.0.0`, `2.3.4-rc.1`, `1.0.0+build.42`

### IPv4 address
```
/^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/
```

### Slug (URL-safe identifier)
```
/^[a-z0-9]+(?:-[a-z0-9]+)*$/
```
Matches: `my-post-title`, `v2`
Does NOT match: `-leading`, `trailing-`, `UPPER`, `has space`

### ISO 8601 date
```
/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
```

### Extract JSON key-value (quick scraping, not a full parser)
```
/"(?<key>[^"]+)"\s*:\s*"(?<value>[^"\\]*(?:\\.[^"\\]*)*)"/g
```

## Verbose Mode Example (Python)

```python
import re

PHONE = re.compile(r"""
    ^                   # start of string
    (?:\+1[\s\-]?)?     # optional country code +1
    \(?(\d{3})\)?       # area code, optional parens
    [\s\-.]?            # separator
    (\d{3})             # exchange
    [\s\-.]?            # separator
    (\d{4})             # subscriber
    $                   # end of string
""", re.VERBOSE)

print(PHONE.match("+1 (415) 555-2671"))  # matches
print(PHONE.match("415.555.2671"))       # matches
print(PHONE.match("5552671"))            # None
```

## Anti-Patterns to Avoid

- **Catastrophic backtracking**: `(a+)+$` on `aaaaaaaab` will hang. Prefer atomic groups or possessive quantifiers when available.
- **Parsing HTML/XML with regex**: use a proper parser.
- **Overly greedy `.*`**: use `[^"]*` or `.*?` to limit scope.

## Output Format

1. Plain-English description of what the regex matches
2. The regex itself (properly escaped for the target language)
3. Test cases table (input | matches?)
4. Notes on edge cases or limitations
