#!/usr/bin/env bash
# Rewrites the table in docs/SETTINGS_KEYS.md from docs/settings_keys.tsv (old name -> stored key -> label).
# With --check, changes nothing and fails if the table is out of date (run_tests.sh does this).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOC="$ROOT/docs/SETTINGS_KEYS.md"
TSV="$ROOT/docs/settings_keys.tsv"
BEGIN='<!-- BEGIN GENERATED TABLE (tools/gen_settings_keys_doc.sh) -->'
END='<!-- END GENERATED TABLE -->'
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
grep -qxF "$BEGIN" "$DOC" && grep -qxF "$END" "$DOC" || { echo "FAIL: the markers are missing in $DOC" >&2; exit 1; }
{
    awk -v b="$BEGIN" '{ print } $0 == b { exit }' "$DOC"
    echo
    echo '| Old name | Stored key | Label | Sketch | Origin | Tasks |'
    echo '| --- | --- | --- | --- | --- | --- |'
    awk -F'\t' '!/^#/ && NF >= 5 { printf "| `%s` | `%s` | %s | %s | %s | %s |\n", $3, $4, $5, $2, $1, $6 }' "$TSV"
    echo
    awk -v e="$END" '$0 == e { p = 1 } p { print }' "$DOC"
} > "$TMP"
if [ "${1:-}" = "--check" ]; then
    if cmp -s "$TMP" "$DOC"; then echo "SETTINGS_KEYS.md is up to date"; exit 0; fi
    echo "FAIL: docs/SETTINGS_KEYS.md is out of date — run tools/gen_settings_keys_doc.sh" >&2
    exit 1
fi
cp "$TMP" "$DOC"
echo "wrote $DOC"
