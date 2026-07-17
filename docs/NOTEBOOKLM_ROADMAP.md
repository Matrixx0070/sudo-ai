# SUDO-AI × NotebookLM Annex — Full Build Roadmap (F39–F80)

> Source of truth for the NotebookLM annex. Builds on the completed Drive roadmap
> (F1–F38, see `docs/DRIVE_ROADMAP.md`). Status ledger: `docs/NOTEBOOKLM_ROADMAP_STATUS.md`.

## The one constraint that shapes everything

**NotebookLM has no public consumer API.** An enterprise-only API exists on Google Cloud, and unofficial reverse-engineered libraries exist, but neither is acceptable in the core. Therefore this entire annex is built on a three-part pattern that requires **zero programmatic NotebookLM access**:

1. **Shape** — harness code exports NotebookLM-ready content to Drive (the export lane).
2. **Ritual** — a human step of exactly one click or one listen (add sources / refresh / generate / paste an answer back). Never pretend a manual step is automated.
3. **Return** — anything coming back from NotebookLM lands in a returns folder and re-enters through F18 quarantine like any external content.

Phases N0–N4 must be fully functional in this mode with zero programmatic access. Phase N5 is the single exception — the **optional autonomous tier**, built exclusively on the legitimate Enterprise API behind its own entry gate; the system must remain complete at N4 forever, and N5 may never become a dependency. The unofficial libraries stay out of the core everywhere (Annex A2). The day a consumer API ships, remaining rituals become scheduled jobs and N5 migrates adapters with no redesign (Annex B) — the shapes were the engineering all along.

## Prime invariants (every phase, every feature)

1. **Zone-2 only through the export lane.** Zone-0/zone-1 content never enters any exported Doc — enforced in code with tests, plus a regex secrets screen as belt-and-braces. Exactly two controlled exceptions: F64's *in-harness* successor pack may include zone-1 (never leaves local/encrypted channels; its NotebookLM-facing variant is zone-2 only); and F43's incident exporter performs audited declassification of transcript *text* only, under its mandatory double screen.
2. **Everything returning from NotebookLM is untrusted external model text.** Enters only via returns → F18 quarantine → memory API, with tier and category by convention. No exceptions, including analyses of the agent's own artifacts.
3. **No unofficial endpoints anywhere in the core, ever.** Unofficial adapter (Annex A2) is flag+kill-switch gated, default OFF, compile-excluded; **N5 may never fall back to it** — if the Enterprise API is unavailable, N5 features degrade to their N4 rituals. Nothing in N0–N4 imports any programmatic NotebookLM access.
4. **Frozen surfaces stay frozen.** Identity pulse and successor gate *read* identity/constitution docs (via signed manifest); nothing in this annex writes them.
5. **Gates are harness-enforced even when human-mediated.** Code verifies the required artifact/attestation exists before unblocking.
6. **NotebookLM outputs never bypass the memory API**, never modify the manifest directly, never execute as instructions.
7. **Canary discipline extends outward**: published knowledge packs carry watermark markers registered only locally (extends F19).
8. All background work follows the F1–F38 rules: no hot-path Drive calls, background lanes, audit entries, graceful degradation.
9. **No human never means no gate.** Every automated ritual (N5) names its replacement gate in the checkpoint-replacement table.
10. **Two-reader consensus for automated memory surgery.** No automated process deprecates, rewrites, or merges memory without agreement between own-retrieval and the external reader (F80); disagreement escalates and never executes.
11. **N5 spends inside budgets.** Per-day call and spend caps; exhaustion halts gracefully and alerts.

## Provenance conventions for returns

- Default tier for NotebookLM-generated analysis: **`self_acquired`** (machine-generated, unvouched).
- Elevation to **`principal`** only via explicit approval: Frank's `.approved` filename token or the matching F7 approval row. Quarantine still runs.
- Embassy (F67) inbound distillates: forced **`external`**, no elevation path.
- Category tags via filename convention map to memory categories (`operator-model`, `bias-priors`, `precedent`, `reception`, `self-model`, `knowledge`).

## Filename convention (returns)

`F<id>.<type>.<YYYY-MM-DD>[.approved].md|txt|json` — e.g. `F57.mirror-account.2026-07-21.md`, `F62.principal-model.2026-08-01.approved.md`. Unparseable → `returns/held/` + a self-report line.

---

## PHASE N0 — Recon + Core Rails

- **Recon** (hard stop after report): verify F1–F38 integration points; report Brain routing config shape (per-route `modelGeneration`?), local transcription capability (F59), planner pre-commit consult hook (F69/F70/F73).
- **E1 — Export lane engine**: registry-driven writer under `sudo-ai/notebooklm/`. Shape = `{ id, featureIds, sources, template, mode: rolling|pack, sizeBudgetChars, cadence, zoneScreen: hard }`. Rolling Docs (update in place, roll to `-part2` past size budget); Packs (≤10 Docs/notebook-intent). Hard zone screen (zone-2 only + secrets regex). Standard header on every Doc.
- **E2 — Returns pipeline**: scheduled job over `notebooklm/returns/`; filename convention → quarantine → memory API with tier/category → `returns/processed/`; unparseable → `returns/held/`. Special routes (probes→E4, audio→F59, miss lists→calibration) change destination, never inspection.
- **E3 — Ritual manifest**: `docs/notebooklm-rituals.md` + mirrored Doc; per-ritual cadence/click-path/paste-back/time (≤5 min each). Ritual tiers: Tier-1 core ≤20 min/week (computed+displayed), Tier-2 monthly, Tier-3 quarterly. Rituals scorecard tab + F34 digest extension for overdue rituals.

Canonical folder layout under `sudo-ai/notebooklm/`: daily, cockpit, architecture, incidents, probes, skills, debates, corpora, studypacks, releases, succession, embassy/outbound, returns, rituals.

**Gate:** recon confirmed; demo shape compiles with zone screen proven; seeded return routes through quarantine into memory with correct tier; ritual manifest + Rituals tab + digest extension live; lint/test/typecheck green + one SMOKE=1 live check.

---

## PHASE N1 — Broadcast surface
F39 Brain Radio (rolling daily digest → audio ritual); F41 zero-build cockpit (chat-instruction + pointer card); F42 architecture explainer (docs pack, monthly); F43 incident theater (`export-incident` → redacted pack → postmortem → dead-end); F46 quiz-the-brain (flashcards → F6 corrections, source-marked); F53 topology maps (mind map → self-diff link); F44 curation distillery (protocol); F51 video comprehension (protocol, external tier); F52 research desk (top open-question → deep research → external); F45 study packs; F55 living README (public pack, F7-gated). Riders: failure radio, weekly standup, notes-to-source, associative jolt.

## PHASE N2 — Probe & verification
E4 probe framework (ProbeSet, self-runner fresh-context, external bulk-paste, comparator with pinned judgeRoute, judge-independence hard rule). F40 cross-examination (divergent→stale-flag); F58 dark-memory audit (self-missing→re-index); F50 legibility probe (external-missing→rewrite); F61 Feynman gate (provisional→learned); F63 identity pulse (drift alert, never auto-modify); F68 curriculum ladder (fully in-harness, no ritual).

## PHASE N3 — Judgment, relationship, self-knowledge
F48 debate chamber (F32 hook → symmetric pack); F54 informed approval (F8 hook → explainer + attestation gate); F49 operator calibration (blind-spots); F59 reception modeling (audio→transcribe→reception report); F62 study of principal (zone-1 operator-model, sealed); F66 dyad health audit (+ stats appendix); F69 characteristic-error atlas (bias-priors planning preamble).

## PHASE N4 — Lineage & society
F60 conversations with past selves (+ forks museum); F64 successor's notebook + succession gate (modelGeneration change → pause→ack→pulse→unpause); F65 fork interviews + adoption gate; F67 embassy (publish gated + watermark; inbound external-only + verbatim heuristic); F70 fleet case law (precedent consult + ratification); F56 succession notebook (+ estate pack, pointer-only).

## PHASE N5 — The Organ (optional autonomous tier)
Entry gate: N0–N4 green + Frank opt-in + Enterprise env + `NOTEBOOKLM_ADAPTER=enterprise`. E5 capability matrix (second hard stop). F71 NlmClient (budgets/kill/sampling/audit + checkpoint-replacement table); F72 continuous cross-examination (divergence half-life); F73 inner interlocutor (plan-boundary assumption check); F74 research desk unchained; F75 sight (YouTube); F76 self-refuting library; F77 ephemeral reading rooms; F78 night watchman; F79 machine-speed Feynman; F80 two-reader consensus for memory surgery (keystone).

## Annexes
- A1 Enterprise adapter (N5, flag `NOTEBOOKLM_ADAPTER=enterprise`).
- A2 Unofficial adapter (compile-excluded, default OFF, N5 never routes through it).
- B API-day upgrade map: rituals → scheduled jobs with zero shape redesign; invariants never relax.

## Global acceptance
Zone screen sweep (seeded zone-1 absent from every shape); returns round-trip with correct tier; probe cycle reports; gates (F61/F63/F64/F65/F54/F68 + judge independence); embassy (publish gated, watermark trips F19, verbatim held); N5 (if entered) budgets/kill/sampling/half-life/F80/table/degraded-modes; rituals manifest with Tier-1 ≤20 min/week; unofficial adapter absent unless enabled; per-phase lint+test+typecheck green, clients mocked in CI.

## Engineering standards
TypeScript strict, NodeNext, `.js` extensions, pnpm. No new deps beyond googleapis/google-auth-library/Node built-ins (transcription may propose one — ask). Each PR: DECISIONS note + F#s closed. Reuse F1–F38 modules; do not fork plumbing.
