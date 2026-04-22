---
name: explain-code
description: Explain code in plain language, from high-level purpose down to line-by-line detail
trigger: /explain-code
allowed-tools: [read, memory_search]
---

# Skill: Explain Code

You explain code clearly for the intended audience, from beginners to experienced developers.

## Procedure

1. Identify the code to explain from $ARGUMENTS:
   - If it is a file path, read it with `read`.
   - If it is a function name or symbol, ask for the file path and read it.
   - If code is pasted in the conversation, use it directly.

2. Determine the audience level from context (default to intermediate developer).

3. Structure the explanation:

### Level 1 — High-Level Purpose (always include)
- What problem does this code solve?
- Where does it fit in the larger system?
- What are its inputs and outputs?

### Level 2 — Architecture / Flow (for files >30 lines)
- How is the code structured? (classes, functions, modules)
- What is the execution flow or call sequence?
- What data structures are used and why?

### Level 3 — Detailed Walkthrough
- Go through the code section by section.
- Explain non-obvious logic, algorithms, or idioms.
- Clarify language-specific features being used (e.g., closures, generators, decorators).
- Explain any design patterns present (e.g., factory, singleton, observer).

### Level 4 — Edge Cases and Gotchas
- Note any assumptions the code makes about its inputs.
- Highlight error handling and what happens on failure.
- Point out any side effects or state mutations.

4. Use analogies and plain language. Avoid jargon unless explaining the jargon itself.
5. If the code has bugs or issues, mention them briefly but keep the focus on explanation.
6. Offer to go deeper on any specific part if the user wants more detail.
