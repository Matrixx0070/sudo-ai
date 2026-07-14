#!/usr/bin/env python3
"""ts (moreutils) fallback (Spec 10): prefix each stdin line with a timestamp.

    long-running-cmd | python3 ts_fallback.py            # %Y-%m-%d %H:%M:%S
    long-running-cmd | python3 ts_fallback.py '%H:%M:%S'

Streaming line-by-line, flushed per line so it works on live pipes.
"""
import sys
import time


def main() -> int:
    fmt = sys.argv[1] if len(sys.argv) > 1 else "%Y-%m-%d %H:%M:%S"
    for line in sys.stdin:
        sys.stdout.write(f"{time.strftime(fmt)} {line}")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
