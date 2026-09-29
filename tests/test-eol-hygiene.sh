#!/usr/bin/env bash
# EOL hygiene: no tracked text file may be CRLF or mixed in the index.
# The .gitattributes pin (* text=auto eol=lf) makes violations impossible on
# normal adds; this test catches tooling that bypasses the pin.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
bad="$(git ls-files --eol | awk '$1 == "i/crlf" || $1 == "i/mixed" {print}')"
if [ -n "$bad" ]; then
  echo "eol-hygiene: CRLF/mixed tracked files found:" >&2
  echo "$bad" >&2
  exit 1
fi
echo "eol-hygiene: OK — all tracked text files are LF"
