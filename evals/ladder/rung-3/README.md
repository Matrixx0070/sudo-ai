# Rung 3 — Code unit-test (ADR-0002)

Certifies: generated code passes a FIXED unit-test suite. Binary pass/fail per
task, code-graded — no LLM judge.

Grader: the model's completion is written to `expect.entry` in a throwaway
workspace beside `expect.test` (as `test-suite.js`), and `expect.command` runs
inside the **Spec-8 hardened Docker tier** (cap-drop ALL, no-new-privileges,
read-only rootfs, `--network none`, pids/memory capped) — the same tier every
untrusted eval turn uses. Generated code NEVER executes on the host.

`expect.command` comes only from this checked-in golden set; model output is
written to a file and is never interpolated into the command string.

Admission (ADR-0002): rung 3 >= 85% (n>=30) gates **code-task routing** —
skill.eval, PTC, and self-modify authorship.

Golden sets only grow; changing an existing case bumps `version`, which
invalidates cached verdicts for this rung.
