/**
 * @file notebooklm/rituals-n1.ts
 * @description N1 ritual registrations (side-effect on import). Tier-1 stays
 * ≤20 min/week: F39 daily radio (14) + F46 weekly quiz (5) = 19. F42/F53/F52
 * are Tier-2 (monthly — not in the weekly budget); F43/F51/F44/F45/F55 Tier-3.
 */

import { registerRitual } from './rituals.js';

let registered = false;
export function registerN1Rituals(): void {
  if (registered) return;
  registered = true;

  registerRitual({
    id: 'quiz-the-brain', featureIds: ['F46'], tier: 1, cadence: 'weekly', minutes: 5,
    clickPath: 'Generate flashcards from the cockpit corpus → answer; every wrong card = wrong memory',
    pasteBack: 'file an F6 comment on the atlas entry prefixed "F46:" (source-tagged, countable)',
  });
  registerRitual({
    id: 'architecture-explainer', featureIds: ['F42'], tier: 2, cadence: 'monthly', minutes: 5,
    clickPath: 'Refresh the architecture pack sources → generate Video Overview + flashcards',
    pasteBack: 'explanation gaps → F42.doc-gaps.<date>.md in returns/',
    degradesTo: 'no fresh doc-gap tasks (docs still accurate; just no auto-audit)',
  });
  registerRitual({
    id: 'topology-map', featureIds: ['F53'], tier: 2, cadence: 'monthly', minutes: 3,
    clickPath: 'Generate the Mind Map over the cockpit corpus → download image → ops/reports/topology/<month>.png',
    pasteBack: 'note "did the silhouette change?" (the self-diff links the map)',
    degradesTo: 'self-diff topology slot stays "(no map this month)"',
  });
  registerRitual({
    id: 'research-desk', featureIds: ['F52'], tier: 2, cadence: 'per-cycle', minutes: 5,
    clickPath: 'Open daily/research-target → run Deep Research on the top open question',
    pasteBack: 'briefing → F52.research.<date>.md in returns/ (→ external tier)',
    degradesTo: 'open questions stay open longer (no auto-research)',
  });
  registerRitual({
    id: 'incident-theater', featureIds: ['F43'], tier: 3, cadence: 'per-incident', minutes: 5,
    clickPath: 'notebooklm export-incident <bundleId> → notebook → Audio postmortem → interrogate',
    pasteBack: 'conclusions → F43.postmortem.<id>.md (→ dead-end candidate)',
    degradesTo: 'incidents lack a narrated postmortem (bundle still recorded)',
  });
  registerRitual({
    id: 'video-comprehension', featureIds: ['F51'], tier: 3, cadence: 'as-needed', minutes: 5,
    clickPath: 'Add YouTube/talk URLs to a scratch notebook → briefing via template',
    pasteBack: 'F51.video-brief.<date>.md (→ external tier, URL provenance)',
    degradesTo: 'no video-derived knowledge',
  });
  registerRitual({
    id: 'curation-distillery', featureIds: ['F44'], tier: 3, cadence: 'as-needed', minutes: 5,
    clickPath: 'Research in NotebookLM → distill to a briefing via the template',
    pasteBack: 'save the briefing to knowledge/inbox/ (standard F1 pipeline, principal tier)',
    degradesTo: 'manual research goes through the normal inbox instead',
  });
  registerRitual({
    id: 'living-readme', featureIds: ['F55'], tier: 3, cadence: 'monthly', minutes: 5,
    clickPath: 'Tick the F7 consent cell → refresh the public README pack → share the notebook publicly',
    pasteBack: 'none',
    degradesTo: 'public explainer goes stale (exporter refuses without consent anyway)',
  });
  registerRitual({
    id: 'study-pack', featureIds: ['F45'], tier: 3, cadence: 'as-needed', minutes: 5,
    clickPath: 'notebooklm export-studypack <questionId> → notebook → discovery + chat',
    pasteBack: 'briefing → F52 return route (external tier)',
    degradesTo: 'open questions researched ad-hoc',
  });
}
