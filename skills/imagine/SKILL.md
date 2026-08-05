---
name: imagine
version: 1.0.0
description: Image-generation doctrine for the media.* tools — when to build a visual with code instead of an image model, prompt-craft, reference-first handling of real people, factual grounding, verify-by-reading-back, and cross-image consistency. Ported and adapted from grok's imagine skill.
author: matrixx0070
tags: [images, media, image-generation, image-editing, visual-qa]
triggers:
  - generate an image
  - generate images
  - create an image
  - make an image
  - make me an image
  - generate a picture
  - create a picture
  - image of
  - picture of
  - edit this image
  - edit the image
  - image edit
  - draw me
  - illustration of
  - poster for
  - album cover
  - logo for
  - generate art
---

# Imagine — image-tool doctrine

Apply this whenever an image is about to be generated or edited.

## Build accurate visuals with code, not image models

Image models are unreliable at exact text, numbers, and structure. They garble
words, invent numbers, draw chart bars that match no data, and point diagram
arrows nowhere — and the more that must be exact, the worse they do. A detailed
prompt doesn't fix it, and an edit pass usually won't either.

When the result needs specific text, data, or structure to be CORRECT, construct
it with a code-driven tool where the content is exact:

| Need | Tool |
|------|------|
| Chart/plot from real numbers | `data.chart` |
| Org chart, mind map, tree, hierarchy | `media.diagram` |
| Flowchart, sequence, state diagram | `media.mermaid` |
| Math/equations | `media.equation` |
| Code screenshot | `media.code-image` |
| Rich layout, tables, real copy, UI mockup | build HTML/CSS → `browser.screenshot` (or `document.pdf-from-html`) |

HTML/CSS gives far better layout, typography, and polish than image models or
Python plotting. Reserve the image models for when only the LOOK matters:
photos, illustrations, characters, scenes, decorative art. Choose by what the
output must get right, not by how the request is worded.

## Choosing the generation tool

- `media.grok-image` — FREE on the owner's Grok web lane; prefer it when
  available (owner-only, needs SUDO_GROK_WEBSESSION).
- `media.image-generate` — metered API providers (DALL-E 3, Stable Diffusion,
  Flux) when the free lane is unavailable or unsuitable.
- `media.image-edit-advanced` — operate on an EXISTING image: remove
  background, upscale, inpaint, resize/crop/rotate/watermark/convert.

## Verify discrete accuracy (loop)

When the output must get text, numbers, or structure right, never trust the
first result:

1. Produce it (generate, or build with code per the table above).
2. Read the actual output back with vision and check every word, number, label,
   and structural detail; check nothing overlaps, clips, or runs off-canvas.
3. If wrong: garbled text or invented numbers from an image model → do NOT
   re-prompt (it will garble again) — rebuild with code. Overlap/clipping in a
   code-built asset → fix the layout (auto-layout beats nudging coordinates).
   Otherwise make one targeted edit.
4. Finish only when the discrete content is exactly right. If it can't be made
   accurate, say so instead of shipping something wrong.

## Core rules

1. **Own the prompt.** If the user supplies a detailed prompt, use it verbatim.
   Otherwise craft it: front-load the subject; give strong high-level direction
   for mood, composition, lighting, style; natural prose, not keyword tags;
   describe positively (no negative prompts). For edits, describe only what
   changes. Target 2–5 sentences.
2. **Reference-first for real people.** Never generate a named real person or
   group from scratch — including face swaps, posters, cartoons, cinematic or
   editorial depictions. Start from a real reference photo and use
   `media.image-edit-advanced` (inpaint) on it. Never produce non-consensual,
   sexualized, or minor-involving likenesses.
3. **Ground facts with search first.** If the request depends on a real-world
   fact, identity, brand, place, event, or "latest/current" anything, run a web
   search first and put the VERIFIED details into the prompt. No placeholders
   like "the current president" — write the verified name.
4. **Reuse a base image for consistency.** When the same character, object, or
   setting must appear across multiple images, generate one base image, then
   derive every variation from it with `media.image-edit-advanced`. Don't
   regenerate a recurring subject from scratch.
5. **Handle blocks gracefully.** On a moderation/safety block: stop. Don't
   retry, don't paraphrase to evade the filter. Tell the user and offer a
   different direction.
6. **Plan multi-step workflows.** Sequence dependent steps; parallelize only
   generations within the same step. Review at the end that every intended
   image actually got produced and matches the ask.
