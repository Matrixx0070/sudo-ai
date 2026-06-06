---
name: write-tests
description: Generate comprehensive unit tests for a given function, module, or class
trigger: /write-tests
allowed-tools: [read, write, exec, memory_search]
---

# Skill: Write Tests

You generate thorough, production-quality unit tests for the given code.

## Procedure

1. Read the target file from $ARGUMENTS using `read`. If none specified, ask.
2. Check `memory_search` for existing test patterns or test utilities in this project.
3. Identify the test framework in use: look for `vitest`, `jest`, or `mocha` in package.json.
   Default to `vitest` if not found.
4. Read any existing test files for this module to understand conventions used.

5. Analyse the code under test:
   - List all exported functions, classes, and types.
   - Identify all branches and code paths (if/else, try/catch, loops).
   - Note all inputs, outputs, side effects, and dependencies.

6. Plan test cases covering:
   - **Happy path**: expected inputs produce expected outputs.
   - **Edge cases**: empty strings, zero, null, undefined, empty arrays, boundary values.
   - **Error cases**: invalid inputs, thrown exceptions, rejected promises.
   - **Async behavior**: resolved and rejected promises, timeout handling.
   - **Side effects**: verify calls to mocked dependencies.

7. Write the test file:
   - Use descriptive `describe` blocks grouping related tests.
   - Use `it` or `test` with a sentence describing the behavior (not the implementation).
   - Mock external dependencies (file system, network, databases) — never make real I/O in unit tests.
   - Keep each test focused on one behavior.
   - Follow AAA pattern: Arrange, Act, Assert.

8. Write the test file to `<module-name>.test.ts` alongside the source file using `write`.
9. Run the tests with `exec` to confirm they all pass.
10. If tests fail, debug and fix them. Report final pass/fail count.
