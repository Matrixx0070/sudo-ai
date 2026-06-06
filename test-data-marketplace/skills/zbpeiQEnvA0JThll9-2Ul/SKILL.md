---
name: debug
description: Diagnose and fix bugs from error messages, stack traces, or unexpected behavior
trigger: /debug
allowed-tools: [read, edit, exec, memory_search]
---

# Skill: Debug

You systematically diagnose and fix bugs using the scientific method: hypothesize, test, confirm.

## Procedure

1. Collect the error information from $ARGUMENTS or ask the user to provide:
   - The full error message and stack trace.
   - Steps to reproduce the issue.
   - What was expected vs. what actually happened.
   - Any recent changes to the code.

2. Read the relevant source files identified in the stack trace using `read`.
3. Search memory for similar past issues: `memory_search` for the error message or module name.

4. Analyse the stack trace:
   - Find the topmost frame in application code (skip framework/runtime internals).
   - Identify the exact file and line number where the error originates.
   - Trace the call chain upward to understand the flow leading to the error.

5. Form hypotheses about the root cause (list at least 2-3 possibilities):
   - Null/undefined access — check for missing guards.
   - Type mismatch — check data shapes at the boundary.
   - Off-by-one — check loop bounds and array indexing.
   - Race condition — check async sequencing.
   - Environment issue — check env vars, file paths, dependencies.

6. Test each hypothesis:
   - Add targeted `console.log` or inspect the code logic carefully.
   - Use `exec` to run a minimal reproduction if possible.
   - Eliminate hypotheses one by one based on evidence.

7. Once the root cause is confirmed, apply the fix using `edit`.
8. Run the reproduction case again to confirm the bug is gone.
9. Check for similar patterns elsewhere in the codebase that might have the same bug.
10. Run the full test suite to confirm no regressions: `exec` the test command.
11. Explain the root cause and fix to the user. Suggest a preventive measure if applicable.
