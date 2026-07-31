# Rung 4 — Task completion (ADR-0002, JUDGED)

Certifies: the route completes a bounded task correctly — goal reached, output
faithful, constraints respected.

Grader: programmatic assertions FIRST (rung-0 assertion keys: outputContains /
outputMatches / jsonParses / nonEmpty), then an LLM judge for goal satisfaction
via `expect.rubric` (0-10, pass at `expect.minScore`, default 7). A route that
fails the programmatic part never reaches the judge — no point paying a judge to
bless output we can already prove wrong.

**Invariant 7:** the judge must be independent of the route under test. Because a
run grades ONE route, independence is decided per RUN: if the judge shares the
route's provider the whole rung HOLDS (`judgeHeld: true`, admitted false) before
any spend. Pin a different judge with `SUDO_EVAL_JUDGE_ROUTE`.

Admission (ADR-0002): rung 4 >= 90% (n>=20) for serving tool turns; full-turn
executors need >= 95% on the nonce-probe suite (a separate golden set).
