"""Inspect an existing PPTX presentation (read-only).

First-party companion to the vendored grok pptx skill scripts: the skill reads
decks via markitdown (not installed here), so this reports the same information
with python-pptx instead.

Usage: python inspect_pptx.py <pptx_file> [--text] [--notes] [--media]

Default report: slide size, slide count, per-slide layout + title + shape count.
  --text   also dump every text frame per slide
  --notes  also dump speaker notes per slide
  --media  also list embedded media files (from the zip)
"""

import argparse
import sys
import zipfile
from pathlib import Path

from pptx import Presentation
from pptx.util import Emu


def slide_title(slide) -> str:
    try:
        if slide.shapes.title is not None and slide.shapes.title.has_text_frame:
            return slide.shapes.title.text_frame.text.strip().replace("\n", " ")
    except (KeyError, AttributeError):
        pass
    return ""


def iter_text_frames(shapes):
    for shape in shapes:
        if shape.shape_type == 6 and hasattr(shape, "shapes"):  # group
            yield from iter_text_frames(shape.shapes)
        elif getattr(shape, "has_text_frame", False):
            text = shape.text_frame.text.strip()
            if text:
                yield text


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pptx_file")
    parser.add_argument("--text", action="store_true", help="dump text frames per slide")
    parser.add_argument("--notes", action="store_true", help="dump speaker notes per slide")
    parser.add_argument("--media", action="store_true", help="list embedded media files")
    args = parser.parse_args()

    path = Path(args.pptx_file)
    if not path.is_file():
        print(f"Error: {path} not found", file=sys.stderr)
        return 1

    prs = Presentation(str(path))

    width_in = Emu(prs.slide_width).inches if prs.slide_width else 0
    height_in = Emu(prs.slide_height).inches if prs.slide_height else 0
    print(f"Presentation: {path.name}")
    print(f"Slide size: {width_in:.2f} x {height_in:.2f} in")
    print(f"Slides: {len(prs.slides)}")
    layouts = [layout.name for master in prs.slide_masters for layout in master.slide_layouts]
    print(f"Layouts available: {', '.join(layouts) if layouts else '(none)'}")
    print()

    for idx, slide in enumerate(prs.slides, start=1):
        layout_name = slide.slide_layout.name if slide.slide_layout is not None else "?"
        title = slide_title(slide)
        n_shapes = len(slide.shapes)
        line = f"slide{idx}.xml  [layout: {layout_name}, shapes: {n_shapes}]"
        if title:
            line += f"  title: {title}"
        print(line)
        if args.text:
            for text in iter_text_frames(slide.shapes):
                for tline in text.splitlines():
                    print(f"    | {tline}")
        if args.notes and slide.has_notes_slide:
            notes = slide.notes_slide.notes_text_frame.text.strip()
            if notes:
                for nline in notes.splitlines():
                    print(f"    (notes) {nline}")

    if args.media:
        print()
        print("Media:")
        with zipfile.ZipFile(path) as zf:
            media = [i for i in zf.infolist() if i.filename.startswith("ppt/media/")]
            if not media:
                print("  (none)")
            for info in media:
                print(f"  {info.filename}  ({info.file_size} bytes)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
