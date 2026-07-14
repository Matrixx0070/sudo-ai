#!/usr/bin/env python3
"""html fallback (Spec 10): CSS-selector-lite extraction via html.parser.

    python3 html_fallback.py --select 'div.item'          # outer text of matches
    python3 html_fallback.py --select '#main' --attr href

Selector subset: tag, .class, #id, tag.class, tag#id — single simple
selector only (no combinators/descendants). This is deliberately minimal:
when htmlq/hxselect are missing this beats nothing, and the capability
manifest reports it honestly as via:'python' with limited selectors.
"""
import sys
from html.parser import HTMLParser


def parse_selector(sel):
    tag, cls, ident = None, None, None
    rest = sel.strip()
    if "#" in rest:
        rest, _, ident = rest.partition("#")
    if "." in rest:
        rest, _, cls = rest.partition(".")
    tag = rest or None
    return tag, cls, ident


class Extractor(HTMLParser):
    def __init__(self, tag, cls, ident, attr):
        super().__init__(convert_charrefs=True)
        self.want = (tag, cls, ident)
        self.attr = attr
        self.depth = 0
        self.capture_stack = []
        self.results = []

    def matches(self, tag, attrs):
        want_tag, want_cls, want_id = self.want
        if want_tag and tag != want_tag:
            return False
        a = dict(attrs)
        if want_cls and want_cls not in (a.get("class") or "").split():
            return False
        if want_id and a.get("id") != want_id:
            return False
        return True

    def handle_starttag(self, tag, attrs):
        if self.matches(tag, attrs):
            if self.attr:
                self.results.append(dict(attrs).get(self.attr) or "")
            else:
                self.capture_stack.append({"tag": tag, "depth": 0, "text": []})
        for cap in self.capture_stack:
            if cap["tag"] == tag:
                cap["depth"] += 1

    def handle_endtag(self, tag):
        done = []
        for cap in self.capture_stack:
            if cap["tag"] == tag:
                cap["depth"] -= 1
                if cap["depth"] == 0:
                    done.append(cap)
        for cap in done:
            self.capture_stack.remove(cap)
            self.results.append(" ".join("".join(cap["text"]).split()))

    def handle_data(self, data):
        for cap in self.capture_stack:
            cap["text"].append(data)


def arg(name, default=None):
    argv = sys.argv[1:]
    return argv[argv.index(name) + 1] if name in argv and argv.index(name) + 1 < len(argv) else default


def main() -> int:
    sel = arg("--select")
    if not sel:
        sys.stderr.write("html_fallback: --select 'tag|.class|#id' required\n")
        return 2
    tag, cls, ident = parse_selector(sel)
    ex = Extractor(tag, cls, ident, arg("--attr"))
    ex.feed(sys.stdin.read())
    for r in ex.results:
        sys.stdout.write(r + "\n")
    return 0 if ex.results else 1


if __name__ == "__main__":
    sys.exit(main())
