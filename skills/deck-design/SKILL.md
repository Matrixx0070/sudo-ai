---
name: deck-design
version: 1.0.0
description: Visual design doctrine for slide decks — bold content-informed palettes, type pairing, varied layouts, and the assume-there-are-problems QA loop. Condensed from grok's pptx design guidance; pairs with the pptx.* tools. Full doc in references/.
author: matrixx0070
tags: [slides, presentation, deck, design, visual-qa]
triggers:
  - design a deck
  - design the slides
  - make a pitch deck
  - build a pitch deck
  - create a presentation
  - make a presentation
  - make slides
  - build a deck
  - slide design
  - pick a color palette for
  - make these slides look good
  - improve the deck
---

# Deck design — don't ship boring slides

Full doc: `skills/deck-design/references/FULL_SKILL.md`. Mechanics:
`pptx.find_template` (start from one of 193 professional templates),
`pptx.create`, the unpack/set_text/check_overlaps/pack workflow, and
`pptx.render_slides` for QA. Color accessibility: `media.color-check`.

## Before starting

- **Bold, content-informed palette.** It should feel designed for THIS topic —
  if swapping the colors into an unrelated deck would still "work," they aren't
  specific enough. Don't default to generic blue.
- **Dominance over equality.** One color carries 60–70% of the visual weight,
  1–2 supporting tones, one sharp accent. Never weight all colors equally.
- **Dark/light sandwich.** Dark title + conclusion, light content — or commit
  to dark throughout for a premium feel.
- **One repeated motif** (rounded image frames, icons in colored circles, a
  thick single-side border) carried across every slide.

## Every slide

- **Needs a visual element** — image, chart, icon, or shape. Text-only slides
  are forgettable.
- **Vary layouts**: two-column, icon+text rows, 2×2/2×3 grids, half-bleed image
  with overlay, big-stat callouts, comparison columns, timelines. Never repeat
  the same text-heavy layout every slide.
- **Left-align body**; center only titles. Size contrast: titles 36pt+ vs body
  14–16pt.

## Type

Pick a header font with personality + a clean body font (Georgia/Calibri,
Cambria/Calibri, Arial Black/Arial…) — don't default to Arial for both.
Title 36–44 bold · section header 20–24 bold · body 14–16 · caption 10–12 muted.

## Never (AI-slide tells)

- Accent line under a title (the #1 AI-generated tell — use whitespace or a
  background block instead).
- Low-contrast text/icons (verify pairs with `media.color-check`).
- Centered paragraphs; random inconsistent gaps; one styled slide among plain
  ones; leftover `xxxx`/lorem placeholder text.

## QA loop (required — assume there are problems)

1. Render with `pptx.render_slides` (or `pptx.thumbnail` for an overview).
2. **Read the images back with vision** and hunt: overlaps, text overflow/
   clipping, decorative lines under wrapped titles, footers colliding with
   content, gaps <0.3", margins <0.5", misaligned columns, low contrast,
   leftover placeholders. Also run `pptx.check_overlaps` for geometric issues.
3. Fix, then **re-verify the affected slides** — one fix often creates another.
4. Grep the extracted text for `xxxx|lorem|ipsum` before declaring done.

Do not declare success until at least one fix-and-verify cycle has run.
