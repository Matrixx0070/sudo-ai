#!/usr/bin/env python3
"""datamash fallback (Spec 10): column aggregation over whitespace/TSV input.

    python3 datamash_fallback.py sum 1              # aggregate column 1 (1-based)
    python3 datamash_fallback.py mean 2 min 2 max 2 # several ops in one pass
    python3 datamash_fallback.py groupby 1 mean 2   # grouped aggregation

Columns are 1-based like datamash. Whitespace-delimited by default,
tab-only with --tsv. Streaming: aggregates accumulate, rows are not kept
(median keeps its column's values, matching datamash semantics).
"""
import statistics
import sys

OPS = {"sum": sum, "mean": statistics.fmean, "median": statistics.median,
       "min": min, "max": max, "count": len}


def die(msg, code=2):
    sys.stderr.write(f"datamash_fallback: {msg}\n")
    sys.exit(code)


def parse_args(argv):
    tsv = "--tsv" in argv
    argv = [a for a in argv if a != "--tsv"]
    group = None
    ops = []
    i = 0
    while i < len(argv):
        word = argv[i]
        if word == "groupby":
            group = int(argv[i + 1]) - 1
            i += 2
        elif word in OPS:
            ops.append((word, int(argv[i + 1]) - 1))
            i += 2
        else:
            die(f"unknown op: {word} (have: groupby, {', '.join(OPS)})")
    if not ops:
        die("no operations given")
    return tsv, group, ops


def main() -> int:
    tsv, group, ops = parse_args(sys.argv[1:])
    sep = "\t" if tsv else None
    acc = {}
    for line in sys.stdin:
        parts = line.rstrip("\n").split(sep)
        key = parts[group] if group is not None and group < len(parts) else ""
        bucket = acc.setdefault(key, [[] for _ in ops])
        for j, (_, col) in enumerate(ops):
            if col < len(parts):
                try:
                    bucket[j].append(float(parts[col]))
                except ValueError:
                    pass
    delim = "\t"
    for key in sorted(acc):
        cells = [] if group is None else [key]
        for j, (name, _) in enumerate(ops):
            vals = acc[key][j]
            if not vals:
                cells.append("nan")
                continue
            result = OPS[name](vals)
            cells.append(f"{result:g}" if isinstance(result, float) else str(result))
        sys.stdout.write(delim.join(cells) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
