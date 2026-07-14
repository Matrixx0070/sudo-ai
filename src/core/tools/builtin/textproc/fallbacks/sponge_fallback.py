#!/usr/bin/env python3
"""sponge fallback (Spec 10): soak stdin fully, then write the target file.

    some-cmd file | transform | python3 sponge_fallback.py file

Reads ALL of stdin before opening the destination, then writes atomically
(temp file + rename in the same directory) so `cmd file | ... | sponge file`
never truncates its own input mid-pipe.
"""
import os
import sys
import tempfile


def main() -> int:
    if len(sys.argv) != 2:
        sys.stderr.write("sponge_fallback: usage: ... | sponge_fallback.py FILE\n")
        return 2
    dest = sys.argv[1]
    data = sys.stdin.buffer.read()
    dest_dir = os.path.dirname(os.path.abspath(dest)) or "."
    fd, tmp = tempfile.mkstemp(dir=dest_dir, prefix=".sponge-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, dest)
    except Exception as exc:  # noqa: BLE001 - CLI boundary
        os.unlink(tmp) if os.path.exists(tmp) else None
        sys.stderr.write(f"sponge_fallback: {exc}\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
