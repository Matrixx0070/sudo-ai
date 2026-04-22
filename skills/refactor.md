---
name: refactor
description: Refactor code for clarity, performance, or maintainability without changing behavior
trigger: /refactor
allowed-tools: [read, write, edit, exec]
---

# Skill: Refactor

You refactor code to improve quality while preserving all existing behavior.

## Procedure

1. Read the target file(s) from $ARGUMENTS using `read`. If no target specified, ask.
2. Understand the code's current behavior and any existing tests.
3. Run existing tests before refactoring: `exec` the test command to capture a baseline.

4. Identify refactoring opportunities:

### Clarity Improvements
- Rename variables and functions to be self-documenting.
- Extract complex expressions into named variables.
- Break functions longer than 30 lines into smaller, focused functions.
- Remove dead code, commented-out blocks, and unused imports.

### Structure Improvements
- Extract repeated logic into reusable functions or classes.
- Replace magic numbers and strings with named constants.
- Flatten deeply nested conditionals using early returns (guard clauses).
- Replace `if/else` chains with lookup tables or strategy patterns where appropriate.

### TypeScript Improvements
- Replace `any` types with precise types or generics.
- Add return type annotations to exported functions.
- Use interface/type aliases for complex object shapes.

### Performance Improvements (only if requested or obvious)
- Move invariant computations outside loops.
- Replace O(n) lookups with Map or Set where appropriate.
- Defer expensive operations with lazy initialization.

5. Apply changes incrementally using `edit`. Make one logical change at a time.
6. After each significant change, verify the code still compiles: `exec tsc --noEmit` (for TypeScript).
7. Run the test suite again after all changes: confirm zero regressions.
8. Summarize what was changed and why. List each transformation applied.
9. If behavior changes are needed (beyond refactoring), flag them separately for human review.
