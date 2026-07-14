#!/usr/bin/env python3
"""gron fallback (Spec 10): flatten JSON to greppable assignments and back.

    python3 gron_fallback.py           # JSON stdin -> gron lines stdout
    python3 gron_fallback.py --ungron  # gron lines stdin -> JSON stdout

Output matches gron's shape (json.a.b[0] = 1;) closely enough for
gron | rg | ungron round-trips of well-formed input. Pure stdlib.
"""
import json
import re
import sys

IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def flatten(prefix, value, out):
    if isinstance(value, dict):
        out.append(f"{prefix} = {{}};")
        for k, v in value.items():
            key = f"{prefix}.{k}" if IDENT.match(str(k)) else f"{prefix}[{json.dumps(str(k))}]"
            flatten(key, v, out)
    elif isinstance(value, list):
        out.append(f"{prefix} = [];")
        for i, v in enumerate(value):
            flatten(f"{prefix}[{i}]", v, out)
    else:
        out.append(f"{prefix} = {json.dumps(value)};")


TOKEN = re.compile(r"\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]|\[\"((?:[^\"\\]|\\.)*)\"\]")


def assign(root, path, value):
    keys = []
    for m in TOKEN.finditer(path):
        if m.group(1) is not None:
            keys.append(m.group(1))
        elif m.group(2) is not None:
            keys.append(int(m.group(2)))
        else:
            keys.append(json.loads(f'"{m.group(3)}"'))
    cur = root
    for i, k in enumerate(keys):
        last = i == len(keys) - 1
        if last:
            if isinstance(k, int):
                while len(cur) <= k:
                    cur.append(None)
                cur[k] = value
            else:
                cur[k] = value
        else:
            nxt_is_int = isinstance(keys[i + 1], int)
            if isinstance(k, int):
                while len(cur) <= k:
                    cur.append(None)
                if cur[k] is None:
                    cur[k] = [] if nxt_is_int else {}
                cur = cur[k]
            else:
                if k not in cur or cur[k] is None or cur[k] == {} and nxt_is_int:
                    cur[k] = [] if nxt_is_int else cur.get(k) or {}
                cur = cur[k]


def ungron(lines):
    root = {}
    for line in lines:
        line = line.strip().rstrip(";")
        if not line or "=" not in line:
            continue
        path, _, raw = line.partition(" = ")
        raw = raw.strip()
        if raw == "{}" or raw == "[]":
            value = {} if raw == "{}" else []
        else:
            value = json.loads(raw)
        if path == "json":
            if isinstance(value, (dict, list)):
                root = value
            continue
        if not path.startswith("json"):
            continue
        assign(root, path[len("json"):], value)
    return root


def main() -> int:
    try:
        if "--ungron" in sys.argv[1:] or "-u" in sys.argv[1:]:
            json.dump(ungron(sys.stdin.readlines()), sys.stdout, indent=2)
            sys.stdout.write("\n")
        else:
            out = []
            flatten("json", json.load(sys.stdin), out)
            sys.stdout.write("\n".join(out) + "\n")
    except Exception as exc:  # noqa: BLE001 - CLI boundary
        sys.stderr.write(f"gron_fallback: {exc}\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
