#!/usr/bin/env python3
"""csv fallback (Spec 10): minimal mlr/xsv replacement, streaming, stdlib-only.

    python3 csv_fallback.py cut --cols name,age            # project columns
    python3 csv_fallback.py filter --col status --eq 500   # row filter (string equality)
    python3 csv_fallback.py stats --col latency            # count/sum/mean/median/min/max
    python3 csv_fallback.py groupby --key host --col ms --op mean
    python3 csv_fallback.py freq --col status              # value frequency table
    python3 csv_fallback.py to-json                        # CSV -> JSON lines
    python3 csv_fallback.py from-json                      # JSON array/lines -> CSV

Input on stdin (first row = header), output on stdout. cut/filter/to-json
stream row-by-row; stats/groupby accumulate aggregates only (O(1) memory
except median, which keeps the single numeric column).
"""
import csv
import json
import statistics
import sys


def arg(name, default=None):
    argv = sys.argv[1:]
    return argv[argv.index(name) + 1] if name in argv and argv.index(name) + 1 < len(argv) else default


def die(msg, code=2):
    sys.stderr.write(f"csv_fallback: {msg}\n")
    sys.exit(code)


def main() -> int:
    if len(sys.argv) < 2:
        die("usage: csv_fallback.py cut|filter|stats|groupby|freq|to-json|from-json ...")
    cmd = sys.argv[1]
    out = csv.writer(sys.stdout, lineterminator="\n")

    if cmd == "from-json":
        raw = sys.stdin.read().strip()
        rows = json.loads(raw) if raw.startswith("[") else [json.loads(l) for l in raw.splitlines() if l.strip()]
        if not rows:
            return 0
        header = list(rows[0].keys())
        out.writerow(header)
        for r in rows:
            out.writerow([r.get(h, "") for h in header])
        return 0

    reader = csv.reader(sys.stdin)
    try:
        header = next(reader)
    except StopIteration:
        return 0
    idx = {h: i for i, h in enumerate(header)}

    def col_index(name):
        if name not in idx:
            die(f"no such column: {name} (have: {', '.join(header)})")
        return idx[name]

    if cmd == "cut":
        cols = (arg("--cols") or "").split(",")
        positions = [col_index(c) for c in cols if c]
        out.writerow([header[p] for p in positions])
        for row in reader:
            out.writerow([row[p] if p < len(row) else "" for p in positions])
    elif cmd == "filter":
        p = col_index(arg("--col") or die("filter needs --col"))
        want = arg("--eq")
        if want is None:
            die("filter needs --eq VALUE")
        out.writerow(header)
        for row in reader:
            if p < len(row) and row[p] == want:
                out.writerow(row)
    elif cmd == "to-json":
        for row in reader:
            sys.stdout.write(json.dumps(dict(zip(header, row))) + "\n")
    elif cmd == "stats":
        p = col_index(arg("--col") or die("stats needs --col"))
        values = []
        for row in reader:
            if p < len(row) and row[p] != "":
                try:
                    values.append(float(row[p]))
                except ValueError:
                    pass
        if not values:
            die("no numeric values", 1)
        result = {
            "count": len(values), "sum": sum(values), "mean": statistics.fmean(values),
            "median": statistics.median(values), "min": min(values), "max": max(values),
        }
        sys.stdout.write(json.dumps(result) + "\n")
    elif cmd == "freq":
        p = col_index(arg("--col") or die("freq needs --col"))
        counts = {}
        for row in reader:
            if p < len(row):
                counts[row[p]] = counts.get(row[p], 0) + 1
        out.writerow(["value", "count"])
        for value, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])):
            out.writerow([value, n])
    elif cmd == "groupby":
        k = col_index(arg("--key") or die("groupby needs --key"))
        p = col_index(arg("--col") or die("groupby needs --col"))
        op = arg("--op", "mean")
        groups = {}
        for row in reader:
            if k < len(row) and p < len(row) and row[p] != "":
                try:
                    groups.setdefault(row[k], []).append(float(row[p]))
                except ValueError:
                    pass
        fns = {"mean": statistics.fmean, "sum": sum, "min": min, "max": max,
               "count": len, "median": statistics.median}
        if op not in fns:
            die(f"unknown --op {op} (have: {', '.join(fns)})")
        out.writerow(["key", op])
        for key in sorted(groups):
            out.writerow([key, fns[op](groups[key])])
    else:
        die(f"unknown subcommand: {cmd}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
