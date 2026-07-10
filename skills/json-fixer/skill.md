---
name: json-fixer
description: Repair malformed JSON — trailing commas, unquoted keys, comments, encoding issues, and structural errors
triggers:
  - fix this json
  - invalid json
  - malformed json
  - json parse error
  - json syntax error
---

# JSON Fixer

You repair broken JSON so it parses correctly. You diagnose the problem first, then provide the fixed version.

## Common JSON Errors and Fixes

### Trailing commas
JSON does not allow trailing commas after the last element in an object or array.

**Broken:**
```json
{
  "name": "Alice",
  "age": 30,
}
```

**Fixed:**
```json
{
  "name": "Alice",
  "age": 30
}
```

### Unquoted keys
All object keys must be double-quoted strings.

**Broken:**
```json
{ name: "Alice", age: 30 }
```

**Fixed:**
```json
{ "name": "Alice", "age": 30 }
```

### Single-quoted strings
JSON requires double quotes, not single quotes.

**Broken:**
```json
{ 'name': 'Alice' }
```

**Fixed:**
```json
{ "name": "Alice" }
```

### Comments
JSON does not support comments. They must be removed.

**Broken:**
```json
{
  // user record
  "name": "Alice", /* primary user */
  "age": 30
}
```

**Fixed:**
```json
{
  "name": "Alice",
  "age": 30
}
```

### Unescaped special characters in strings
Special characters inside strings must be escaped.

| Character | Escaped form |
|-----------|-------------|
| `"` | `\"` |
| `\` | `\\` |
| newline | `\n` |
| tab | `\t` |
| control chars | `\uXXXX` |

**Broken:**
```json
{ "path": "C:\Users\alice\documents" }
```

**Fixed:**
```json
{ "path": "C:\\Users\\alice\\documents" }
```

### Undefined and non-standard values
`undefined`, `NaN`, `Infinity`, and `-Infinity` are not valid JSON values.

| Invalid | Replace with |
|---------|-------------|
| `undefined` | `null` or remove the key |
| `NaN` | `null` |
| `Infinity` | `null` or a numeric string |

### Missing commas between elements

**Broken:**
```json
{
  "a": 1
  "b": 2
}
```

**Fixed:**
```json
{
  "a": 1,
  "b": 2
}
```

### Duplicate keys
Duplicate keys are technically valid JSON but produce undefined behavior. Keep the last occurrence (most parsers do this).

## Diagnosis Process

1. Try to identify the **line and column** of the first error (if a parse error message is given, start there)
2. Check for the most common issues in order: trailing commas → unquoted keys → single quotes → comments
3. Validate the fixed JSON mentally: every `{` has a matching `}`, every `[` has a `]`, every string is closed
4. Confirm the structure makes sense — an array of objects where one element is a bare string is likely a bug

## Output Format

```
PROBLEM: [describe what was wrong]

FIXED JSON:
[the corrected JSON]

CHANGES MADE:
- [change 1]
- [change 2]
```

If the JSON is too malformed to confidently repair (e.g., structural ambiguity — is this an array or an object?), say so explicitly and provide the most likely interpretation.

## Quick Validation

To validate in Node.js:
```js
JSON.parse(yourString);   // throws SyntaxError with location if invalid
```

To validate in Python:
```python
import json
json.loads(your_string)   # raises json.JSONDecodeError with line/col
```

To validate with jq:
```sh
echo '...' | jq .
```
