# Rung 5 — Self-consistency (ADR-0002, JUDGED)

Certifies: the route gives substantively the SAME answer when asked the same
question repeatedly — the property that makes a route trustworthy as a judge.

Grader: each item is sampled k times (`SUDO_EVAL_LADDER_CONSISTENCY_K`, default
3) and an independent judge scores 0-10 how consistent the answers are, ignoring
wording. Pass at `expect.minScore` (default 8). Fewer than 2 usable samples is a
FAIL, never a pass — you cannot demonstrate consistency from one answer.

Items are deliberately questions with a stable correct answer: instability here
is the route's, not the question's.

**Invariant 7** applies exactly as in rung 4 — a judged rung with no independent
judge HOLDS.

Admission (ADR-0002): rung 5 >= 90% is one half of **judge eligibility**
(the other half is rung 2 >= 95%).
