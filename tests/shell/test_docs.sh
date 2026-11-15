#!/bin/bash
# test_docs.sh — the documentation set (F-32). The one fat INSTALL.md was split into several
# documents that must stay consistent, so this checks:
#   - the documents of the set exist and are not empty
#   - every relative link between them points at an existing file, and at an existing
#     heading anchor in that file (with GitHub's anchor rule: lowercase; symbols and emoji
#     dropped; every space a '-')
#   - the README's map still names every document
#   - no code file still sends the reader to INSTALL.md — since the split it is only a
#     pointer page, so a topic reference in a comment or error message would be stale
# Pure text checks, no setup, no network. Usage: tests/shell/test_docs.sh   Exit code: 0 if all pass.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DOCS=(README.md ASSEMBLY.md SETUP.md MANUAL.md DEPLOY.md DEVELOP.md MISC.md INSTALL.md)
pass=0; fail=0
check() {   # check "name" <condition exit code>
    if [ "$2" -eq 0 ]; then pass=$((pass + 1)); echo "[PASS] $1"; else fail=$((fail + 1)); echo "[FAIL] $1"; fi
}

# GitHub's heading anchor: lowercase; drop everything that is not an ASCII letter, digit,
# '_' or '-'; every space becomes one '-'. (A dropped symbol leaves the spaces around it,
# so "bar → ALL" becomes "bar---all".) Byte-wise, so UTF-8 symbols drop cleanly.
slugify() {
    printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | awk '
        { for (i = 1; i <= length($0); i++) {
            c = substr($0, i, 1)
            if (c ~ /[a-z0-9_-]/) printf "%s", c
            else if (c == " ") printf "-"
        } }'
}

# Every heading anchor of a Markdown file, one per line.
heading_anchors() {
    grep -E '^#{1,6} ' "$1" 2>/dev/null | sed -E 's/^#{1,6} //; s/[[:space:]]+$//' | while IFS= read -r h; do
        slugify "$h"; printf '\n'
    done
}

# %XX escapes in a URL fragment -> the characters (anchors hold no other escapes).
urldecode() {
    printf '%b' "${1//%/\\x}"
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ── the documents exist ──────────────────────────────────────────────────
for doc in "${DOCS[@]}"; do
    if [ -s "$ROOT/$doc" ]; then check "$doc exists and is not empty" 0; else check "$doc exists and is not empty" 1; fi
done

# ── the README map names every document ──────────────────────────────────
missing_map=0
for doc in "${DOCS[@]}"; do
    # README.md itself is the map; it need not link to itself
    [ "$doc" = "README.md" ] && continue
    grep -q "($doc)" "$ROOT/README.md" || missing_map=1
done
check "README.md links every document of the set" $missing_map

# ── every relative link resolves (file + heading anchor) ─────────────────
bad_files=0
bad_anchors=0
for doc in "${DOCS[@]}"; do
    anchors_of() { heading_anchors "$ROOT/$1" > "$TMP/anchors"; }
    # markdown link targets: ...](target) — skip http(s)/mailto; a target with no file part links this file
    grep -oE '\]\([^)]+\)' "$ROOT/$doc" | sed -E 's/^\]\(//; s/\)$//' | while IFS= read -r target; do
        case "$target" in
            http://*|https://*|mailto:*) continue ;;
        esac
        file="${target%%#*}"
        anchor=""
        case "$target" in
            *"#"*) anchor="$(urldecode "${target#*#}")" ;;
        esac
        if [ -z "$file" ]; then file="$doc"; fi
        if [ ! -f "$ROOT/$file" ]; then
            echo "[FAIL] $doc links '$target' — the file does not exist" >&2
            exit 31
        fi
        if [ -n "$anchor" ]; then
            anchors_of "$file"
            target_slug="$(slugify "$anchor")"
            if [ -z "$target_slug" ] || ! grep -qxF "$target_slug" "$TMP/anchors"; then
                echo "[FAIL] $doc links '$target' — no heading with that anchor in $file" >&2
                exit 32
            fi
        fi
    done || rc=$?
    # the subshell signals the first bad link through its exit code
    rc=${rc:-0}
    if [ "$rc" -eq 31 ]; then bad_files=1; elif [ "$rc" -eq 32 ]; then bad_anchors=1; fi
    unset rc
done
check "every relative link points at an existing document" $bad_files
check "every link anchor matches a heading in the target document" $bad_anchors

# ── no code file still points at INSTALL.md ──────────────────────────────
stale=$(grep -rln "INSTALL\.md" "$ROOT" \
            --include='*.js' --include='*.sh' --include='*.php' --include='*.h' \
            --include='*.ino' --include='*.conf' --include='*.py' --include='*.cpp' \
            --exclude-dir=node_modules \
            | grep -v "tests/shell/test_docs.sh" || true)
check "no code file references INSTALL.md (it is only a pointer page)" $([ -n "$stale" ] && echo 1 || echo 0)
if [ -n "$stale" ]; then
    echo "  stale references:" >&2
    printf '%s\n' "$stale" | sed 's/^/    /' >&2
fi

printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
