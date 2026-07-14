#!/usr/bin/env python3
"""yq fallback (Spec 10): YAML<->JSON bridge when yq is not installed.

    python3 yq_fallback.py            # YAML on stdin -> JSON on stdout
    python3 yq_fallback.py --back     # JSON on stdin -> YAML on stdout

Multi-document YAML streams emit a JSON array. Requires PyYAML (the one
non-stdlib dependency the fallback layer allows; present in the textproc
venv and the sandbox image via python3-yaml).
"""
import json
import sys

try:
    import yaml
except ImportError:
    sys.stderr.write("yq_fallback: PyYAML not installed — run scripts/provision-textproc.sh\n")
    sys.exit(3)


def main() -> int:
    back = "--back" in sys.argv[1:]
    raw = sys.stdin.read()
    try:
        if back:
            data = json.loads(raw)
            yaml.safe_dump(data, sys.stdout, default_flow_style=False, sort_keys=False)
        else:
            docs = list(yaml.safe_load_all(raw))
            out = docs[0] if len(docs) == 1 else docs
            json.dump(out, sys.stdout, indent=2, default=str)
            sys.stdout.write("\n")
    except Exception as exc:  # noqa: BLE001 - CLI boundary, report and exit
        sys.stderr.write(f"yq_fallback: {exc}\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
