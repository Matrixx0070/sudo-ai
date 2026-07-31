# Rung 2 — Math / numeric (ADR-0002)

Certifies: correct closed-form answers within tolerance — multi-step arithmetic,
percentages, unit handling, signed and decimal results.

Grader: exact / tolerance compare against the golden answer (code-graded, no LLM
judge). `expect = { answer: <number>, tolerance: <number> }`; `tolerance: 0`
means exact after numeric parsing.

Admission (ADR-0002): rung 2 >= 95% is one half of **judge eligibility** — a
route may only sit on the grading side of rungs 4/5 when it can do arithmetic
reliably (the other half is rung 5 self-consistency >= 90%), plus invariant-7
independence per comparison.

Golden sets only grow; changing an existing case bumps `version`, which
invalidates cached verdicts for this rung.
