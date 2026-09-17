#!/usr/bin/env bash
# regression-gate — baseline-parity contract, mechanically enforced.
# Runs the transferred regression suite from the app root under baseline conditions
# (env -u OW_HOME), extracts assertion-level FAIL lines, and fails iff any FAIL line
# is not present in tests/regression/baseline.txt OR any script produces no output
# (crash/hang detection — a silent suite shrink is a gate failure). Spike-a stays
# diagnostic and is deliberately NOT here (fork scripts/test-runner precedent).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT

empty_scripts=0
for t in tests/regression/test-*.mjs; do
  before=$(wc -l < "$OUT")
  echo "=== $t ===" >> "$OUT"
  timeout 120 env -u OW_HOME node "$t" 2>&1 >> "$OUT" || true
  after=$(wc -l < "$OUT")
  if [ "$((after - before))" -le 1 ]; then
    echo "regression-gate: script produced no output: $t" >&2
    empty_scripts=1
  fi
done

# assertion-level FAIL lines: exact "  FAIL: <text>" shape recorded in the baseline
fails=$(grep -E '^  FAIL:' "$OUT" | sort -u || true)
new=$(comm -13 <(sort -u tests/regression/baseline.txt) <(echo "$fails"))

if [ -n "$new" ]; then
  echo "regression-gate: NEW assertion-level failures vs baseline:" >&2
  echo "$new" >&2
  exit 1
fi

if [ "$empty_scripts" -ne 0 ]; then
  echo "regression-gate: one or more scripts produced no output (see above)" >&2
  exit 1
fi

echo "regression-gate: no new assertion-level failures (baseline contract holds)"
