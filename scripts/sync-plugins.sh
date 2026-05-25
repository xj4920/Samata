#!/usr/bin/env bash
#
# Sync plugin source code from otcclaw/plugins/ to samata-plugins/
#
# Usage:
#   ./scripts/sync-plugins.sh              # sync all plugins, show diff
#   ./scripts/sync-plugins.sh --apply      # sync all plugins, actually copy
#   ./scripts/sync-plugins.sh csv-export   # sync one plugin, show diff
#   ./scripts/sync-plugins.sh csv-export --apply
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_ROOT="$(dirname "$SCRIPT_DIR")/plugins"
DST_ROOT="$(dirname "$SCRIPT_DIR")/../samata-plugins"

# Parse args
APPLY=false
PLUGINS=()
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    --help|-h)
      echo "Usage: $0 [plugin-name...] [--apply]"
      echo "  Without --apply: dry-run, shows what would change"
      echo "  With --apply:    copies files and shows git diff"
      exit 0
      ;;
    *) PLUGINS+=("$arg") ;;
  esac
done

if [ ! -d "$DST_ROOT" ]; then
  echo "ERROR: samata-plugins repo not found at $DST_ROOT"
  exit 1
fi

# Source files to sync (everything except npm publish artifacts)
# These are the files we NEVER overwrite in dst (managed by samata-plugins repo):
#   package.json, tsconfig.build.json, tsconfig.json, dist/, node_modules/
EXCLUDE_PATTERNS="package.json|tsconfig.build.json|tsconfig.json|dist|node_modules"

if [ ${#PLUGINS[@]} -eq 0 ]; then
  for d in "$SRC_ROOT"/*/; do
    [ -d "$d" ] && PLUGINS+=("$(basename "$d")")
  done
fi

changed=0
synced=0

for name in "${PLUGINS[@]}"; do
  src="$SRC_ROOT/$name"
  dst="$DST_ROOT/$name"

  if [ ! -d "$src" ]; then
    echo "SKIP: $name — not found in $SRC_ROOT"
    continue
  fi

  if [ ! -d "$dst" ]; then
    echo "NEW:  $name — does not exist in samata-plugins yet"
    if $APPLY; then
      mkdir -p "$dst"
      echo "  Created $dst (you need to add package.json + tsconfig.build.json manually)"
    fi
  fi

  # Collect source files to sync
  files_to_sync=()
  while IFS= read -r -d '' f; do
    rel="${f#$src/}"
    base="$(basename "$rel")"
    # Skip npm-managed files
    if echo "$base" | grep -qE "^($EXCLUDE_PATTERNS)$"; then
      continue
    fi
    # Skip directories named dist or node_modules
    if echo "$rel" | grep -qE "(^|/)dist(/|$)|(^|/)node_modules(/|$)"; then
      continue
    fi
    files_to_sync+=("$rel")
  done < <(find "$src" -type f -print0 | sort -z)

  plugin_changed=false

  for rel in "${files_to_sync[@]}"; do
    src_file="$src/$rel"
    dst_file="$dst/$rel"

    if [ ! -f "$dst_file" ]; then
      echo "  ADD: $name/$rel"
      plugin_changed=true
      if $APPLY; then
        mkdir -p "$(dirname "$dst_file")"
        cp "$src_file" "$dst_file"
      fi
    elif ! diff -q "$src_file" "$dst_file" >/dev/null 2>&1; then
      echo "  MOD: $name/$rel"
      if ! $APPLY; then
        diff -u "$dst_file" "$src_file" --label "samata-plugins/$name/$rel" --label "otcclaw/plugins/$name/$rel" 2>/dev/null || true
      fi
      plugin_changed=true
      if $APPLY; then
        cp "$src_file" "$dst_file"
      fi
    fi
  done

  # Check for files in dst that no longer exist in src (excluding npm-managed)
  if [ -d "$dst" ]; then
    while IFS= read -r -d '' f; do
      rel="${f#$dst/}"
      base="$(basename "$rel")"
      if echo "$base" | grep -qE "^($EXCLUDE_PATTERNS)$"; then
        continue
      fi
      if echo "$rel" | grep -qE "(^|/)dist(/|$)|(^|/)node_modules(/|$)"; then
        continue
      fi
      if [ ! -f "$src/$rel" ]; then
        echo "  DEL: $name/$rel (exists in samata-plugins but not in otcclaw)"
        plugin_changed=true
        if $APPLY; then
          rm "$dst/$rel"
        fi
      fi
    done < <(find "$dst" -type f -print0 | sort -z)
  fi

  if $plugin_changed; then
    ((changed++)) || true
  fi
  ((synced++)) || true
done

echo ""
echo "--- Summary ---"
echo "Scanned: $synced plugins"
echo "Changed: $changed plugins"
if ! $APPLY && [ $changed -gt 0 ]; then
  echo ""
  echo "This was a dry run. To apply changes, run:"
  echo "  $0 ${PLUGINS[*]} --apply"
fi
