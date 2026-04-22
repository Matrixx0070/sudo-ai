#!/bin/bash
export HOME=/root
export PATH=/usr/bin:/usr/local/bin:$PATH
# Read stdin to temp file, then pass to claude
TMPFILE=$(mktemp)
cat > "$TMPFILE"
claude -p < "$TMPFILE" 2>/dev/null
rm -f "$TMPFILE"
