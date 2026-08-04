---
name: imagemagick
version: 1.0.0
description: Safety rules and decision logic for image processing with ImageMagick via shell — resize, crop, convert, watermark, composite, annotate, montage, batch. Condensed from grok's imagemagick skill; full recipes in references/.
author: matrixx0070
tags: [imagemagick, images, image-processing, batch]
triggers:
  - merge images into one
  - combine images side by side
  - create image strip
  - image grid
  - resize image
  - resize this image
  - crop image
  - crop this image
  - convert png to jpg
  - convert jpg to png
  - add watermark
  - image collage
  - montage
  - batch convert images
  - compress image
  - rotate image
  - overlay images
  - annotate image
  - imagemagick
---

# ImageMagick — agent safety rules + decision logic

Full recipes: `skills/imagemagick/references/recipes.md` (compositing,
montages, batch, color adjustments). Extended doc:
`skills/imagemagick/references/FULL_SKILL.md`.

**This host runs ImageMagick 6**: the commands are `convert`, `identify`,
`montage`, `composite` (not the v7 `magick` prefix).

## Safety policy (always)

- **Never overwrite the input**: write to a new output path unless the user
  explicitly asks for in-place.
- Quote every path. Local files only — never pass user-supplied URLs.
- Verify output after processing:
  `identify -format "%f  %wx%h  %m  %b\n" "$OUTPUT"`
- `-limit memory 256MiB -limit disk 512MiB` on large batch runs.
- PDF/PS/EPS coders may be policy-restricted; on a policy error, don't bypass
  — use the document.* pdf tools instead.

## Inspect first

```bash
identify -format "%f  %wx%h  %m  %[colorspace]  %b\n" "$INPUT"
```

## Core moves

```bash
# Resize to width 800 (aspect kept, never upscale):
convert "$INPUT" -resize '800x>' "$OUTPUT"

# Crop 400x300 starting at (50,20):
convert "$INPUT" -crop 400x300+50+20 +repage "$OUTPUT"

# Convert format (quality for jpg):
convert "$INPUT" -quality 90 "$OUTPUT.jpg"

# Horizontal strip / side-by-side (use -append for vertical):
convert a.png b.png c.png +append "$OUTPUT"

# Grid montage, 3 across, small gaps:
montage *.png -tile 3x -geometry +4+4 "$OUTPUT"

# Text watermark bottom-right:
convert "$INPUT" -gravity southeast -pointsize 24 -fill 'rgba(255,255,255,0.6)' \
  -annotate +12+12 'watermark' "$OUTPUT"

# Overlay logo at top-left with offset:
composite -gravity northwest -geometry +10+10 logo.png "$INPUT" "$OUTPUT"

# Batch convert (mogrify writes to -path, inputs untouched):
mkdir -p out && mogrify -path out -format jpg -quality 88 *.png
```

## Common failure modes

- Cropped image keeps old canvas offset → add `+repage` after `-crop`.
- Blurry upscales → use `>` in resize geometry so images only shrink.
- Transparent PNG → JPG gets black background → add
  `-background white -flatten` before writing.
- Odd colors after ops → check colorspace (`-colorspace sRGB`).

## Agent behavior

- State the transformation in one line before running it.
- Chain operations in ONE convert call rather than multiple lossy passes.
- sudo-ai also has `media.image-edit-advanced` (resize/crop/rotate/watermark
  via sharp) — prefer it for single-image basics; use ImageMagick for
  montages, strips, batches, and anything sharp doesn't cover. For color/
  accessibility checks use `media.color-audit`.
