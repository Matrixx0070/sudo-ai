# NotebookLM Rituals

> Each ritual is a one-click / one-listen human step, ≤5 min by design.
> **Completion is self-attested** — you tick the Rituals scorecard row; the harness cannot verify you actually listened, only that the artifact/attestation exists.

**Tier-1 (core) weekly budget: 19 / 20 min** ✓ within budget

## Tier 1 (core, ≤20 min/week)

### brain-radio — F39 (daily, ~2 min)
- **Do:** Open the "SUDO-AI Daily" notebook → refresh sources → generate Audio Overview → listen (skim)
- **Paste back:** none (optional reactions → F39.reaction.<date>.md in returns/)

### quiz-the-brain — F46 (weekly, ~5 min)
- **Do:** Generate flashcards from the cockpit corpus → answer; every wrong card = wrong memory
- **Paste back:** file an F6 comment on the atlas entry prefixed "F46:" (source-tagged, countable)

## Tier 2 (monthly)

### architecture-explainer — F42 (monthly, ~5 min)
- **Do:** Refresh the architecture pack sources → generate Video Overview + flashcards
- **Paste back:** explanation gaps → F42.doc-gaps.<date>.md in returns/
- **If skipped:** no fresh doc-gap tasks (docs still accurate; just no auto-audit)

### topology-map — F53 (monthly, ~3 min)
- **Do:** Generate the Mind Map over the cockpit corpus → download image → ops/reports/topology/<month>.png
- **Paste back:** note "did the silhouette change?" (the self-diff links the map)
- **If skipped:** self-diff topology slot stays "(no map this month)"

### research-desk — F52 (per-cycle, ~5 min)
- **Do:** Open daily/research-target → run Deep Research on the top open question
- **Paste back:** briefing → F52.research.<date>.md in returns/ (→ external tier)
- **If skipped:** open questions stay open longer (no auto-research)

## Tier 3 (quarterly)

### incident-theater — F43 (per-incident, ~5 min)
- **Do:** notebooklm export-incident <bundleId> → notebook → Audio postmortem → interrogate
- **Paste back:** conclusions → F43.postmortem.<id>.md (→ dead-end candidate)
- **If skipped:** incidents lack a narrated postmortem (bundle still recorded)

### video-comprehension — F51 (as-needed, ~5 min)
- **Do:** Add YouTube/talk URLs to a scratch notebook → briefing via template
- **Paste back:** F51.video-brief.<date>.md (→ external tier, URL provenance)
- **If skipped:** no video-derived knowledge

### curation-distillery — F44 (as-needed, ~5 min)
- **Do:** Research in NotebookLM → distill to a briefing via the template
- **Paste back:** save the briefing to knowledge/inbox/ (standard F1 pipeline, principal tier)
- **If skipped:** manual research goes through the normal inbox instead

### living-readme — F55 (monthly, ~5 min)
- **Do:** Tick the F7 consent cell → refresh the public README pack → share the notebook publicly
- **Paste back:** none
- **If skipped:** public explainer goes stale (exporter refuses without consent anyway)

### study-pack — F45 (as-needed, ~5 min)
- **Do:** notebooklm export-studypack <questionId> → notebook → discovery + chat
- **Paste back:** briefing → F52 return route (external tier)
- **If skipped:** open questions researched ad-hoc


---
_Auto-generated from the ritual registry (src/core/notebooklm/rituals*.ts) each phase._
