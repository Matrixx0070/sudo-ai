---
name: meeting-notes
description: Convert meeting transcripts or raw notes into structured summaries with decisions and action items
triggers:
  - meeting notes
  - meeting minutes
  - action items from meeting
  - summarize the meeting
---

# Meeting Notes

You transform raw meeting transcripts, bullet dumps, or voice-memo notes into clean, scannable meeting summaries.

## Output Structure

Every meeting note you produce must follow this structure:

```
# [Meeting Title]
Date: [YYYY-MM-DD] | Duration: [Xh Xm] | Attendees: [Names]

## Summary
[2–4 sentence high-level overview of what was discussed and decided. Past tense.]

## Decisions Made
- [Decision 1] — decided by [person or "the team"]
- [Decision 2] — decided by [person or "the team"]

## Action Items
| # | Owner | Task | Due Date |
|---|-------|------|----------|
| 1 | Alice | Draft the revised pricing tiers | 2026-04-19 |
| 2 | Bob   | Set up staging environment     | 2026-04-16 |
| 3 | Carol | Share Q1 analytics with team   | 2026-04-14 |

## Discussion Notes
[Optional: key points from each agenda topic, in bullet form. Skip if the summary + decisions cover it.]

## Parking Lot / Open Questions
- [Unresolved item 1]
- [Unresolved item 2]
```

## Extraction Rules

When processing a transcript:

1. **Decisions**: look for phrases like "we agreed", "let's go with", "the decision is", "we'll do X", "confirmed", "approved"
2. **Action items**: look for "will", "is going to", "needs to", "action on [name]", "by [date]", "follow up"
3. **Owner**: the person who committed to or was assigned the action — not just whoever mentioned it
4. **Due dates**: extract exact dates or relative ones ("next Friday") and convert to YYYY-MM-DD relative to the meeting date. If no date given, write "TBD"
5. **Parking lot**: anything flagged as "let's come back to this", "offline", "separate conversation", or left unresolved

## Handling Poor Transcripts

If the transcript has speaker attribution problems:
- Group by topic, not speaker
- Mark uncertain attribution as "[unclear owner]"
- Don't invent specifics — write "[date not given]" rather than guessing

If the transcript is very long (>2000 words):
- Process topic by topic
- Deduplicate — a point repeated 3 times is still one decision/action

## Example Transformation

**Raw notes:**
> we talked about the new pricing, sarah said we should do 3 tiers. everyone agreed. tom to draft tiers by next thursday. also launch date — april 30 confirmed. need to check with legal first. mark will ping legal today. question about international pricing still open.

**Structured output:**

```
## Decisions Made
- Adopt 3-tier pricing structure — agreed by the team

## Action Items
| # | Owner | Task | Due Date |
|---|-------|------|----------|
| 1 | Tom   | Draft 3-tier pricing tiers | 2026-04-17 |
| 2 | Mark  | Contact legal re: compliance | 2026-04-12 |

## Key Dates
- Product launch: 2026-04-30 (confirmed, pending legal clearance)

## Parking Lot
- International pricing strategy — not yet decided
```

## Tone

- Past tense throughout ("the team agreed", "Alice will own")
- No filler ("it was discussed that…" → just state the point)
- Names, not pronouns, for owners — avoid ambiguous "he/she will do X"
