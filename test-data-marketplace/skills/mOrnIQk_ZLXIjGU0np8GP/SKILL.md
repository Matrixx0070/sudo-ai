---
name: documentation
description: Generate clear documentation for code, APIs, modules, or entire projects
trigger: /documentation
allowed-tools: [read, write, memory_search]
---

# Skill: Documentation

You generate accurate, developer-friendly documentation from source code and context.

## Procedure

1. Identify the documentation target from $ARGUMENTS:
   - Single file → document that module.
   - Directory → document the module/package.
   - API → generate API reference.
   - Project → generate README or full docs site structure.

2. Read all relevant source files using `read`.
3. Check `memory_search` for any existing documentation fragments or style preferences.
4. Identify the audience: internal developer, external API consumer, end user.

5. Generate documentation appropriate to the target:

### Module / File Documentation
- File-level JSDoc comment: purpose, author, dependencies.
- For each exported function: description, `@param` with types and descriptions, `@returns`, `@throws`, usage example.
- For each exported class: purpose, constructor params, key methods.
- For complex algorithms: inline comments explaining the why, not the what.

### API Reference Documentation
- Base URL and authentication method.
- For each endpoint:
  - Method and path.
  - Description of what it does.
  - Request parameters (path, query, body) with types and validation rules.
  - Response schema with field descriptions.
  - Error codes and their meanings.
  - Curl example showing a real request and response.

### README Documentation
- Project name, one-line description, and badges.
- What problem it solves (2-3 sentences).
- Quick start: install, configure, run (5 steps or fewer).
- Configuration reference (all env vars / config keys with defaults).
- Key features list.
- Architecture overview (how main modules relate).
- Contributing guide link or short instructions.

6. Write the documentation to appropriate files:
   - Inline JSDoc: `edit` the source file.
   - Standalone docs: `write` to `docs/<name>.md` or update `README.md`.

7. Review the generated documentation for accuracy against the code.
8. Flag any code paths that lack sufficient context to document accurately — ask for clarification.
