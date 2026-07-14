#!/usr/bin/env python3
"""xml fallback (Spec 10): xpath-lite extraction via xml.etree (stdlib).

    python3 xml_fallback.py --path ./items/item          # print matching elements
    python3 xml_fallback.py --path ./items/item --text   # text content only
    python3 xml_fallback.py --path ./item --attr id      # one attribute per match
    python3 xml_fallback.py                              # pretty-print whole doc

Supports ElementTree's limited XPath subset (tags, /, //, [@attr], [n]).
Namespaced documents need the {uri}tag form. Honest limits: this is a
fallback, not lxml — the manifest reports it as via:'python'.
"""
import sys
import xml.etree.ElementTree as ET


def arg(name, default=None):
    argv = sys.argv[1:]
    return argv[argv.index(name) + 1] if name in argv and argv.index(name) + 1 < len(argv) else default


def main() -> int:
    try:
        root = ET.fromstring(sys.stdin.read())
    except ET.ParseError as exc:
        sys.stderr.write(f"xml_fallback: parse error: {exc}\n")
        return 1
    path = arg("--path")
    if not path:
        ET.indent(root)
        sys.stdout.write(ET.tostring(root, encoding="unicode") + "\n")
        return 0
    attr = arg("--attr")
    text_only = "--text" in sys.argv[1:]
    matches = root.findall(path)
    for el in matches:
        if attr is not None:
            sys.stdout.write((el.get(attr) or "") + "\n")
        elif text_only:
            sys.stdout.write("".join(el.itertext()).strip() + "\n")
        else:
            sys.stdout.write(ET.tostring(el, encoding="unicode").strip() + "\n")
    if not matches:
        sys.stderr.write(f"xml_fallback: no matches for {path}\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
