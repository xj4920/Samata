#!/usr/bin/env bash
set -euo pipefail

MODE="${1:---dry-run}"
BACKUP_ROOT="${SAMATA_SESSION_AUDIT_CRON_BACKUP_ROOT:-/opt/samata/backups/session-audit-crontab}"

usage() {
  cat <<'USAGE'
Usage: bash scripts/migrate-session-audit-crontab.sh [--dry-run|--execute]

Removes only the two legacy analyze-log host cron entries after the
otcclaw-session-audit container is healthy. --execute saves the complete
current user crontab under /opt/samata/backups/session-audit-crontab first.
USAGE
}

case "$MODE" in
  --dry-run|--execute) ;;
  -h|--help|help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

command -v crontab >/dev/null 2>&1 || {
  printf 'crontab command not found\n' >&2
  exit 1
}
if [[ "$MODE" == "--execute" ]]; then
  command -v docker >/dev/null 2>&1 || {
    printf 'docker command not found\n' >&2
    exit 1
  }
fi

current="$(mktemp)"
filtered="$(mktemp)"
trap 'rm -f -- "$current" "$filtered"' EXIT
chmod 0600 "$current" "$filtered"
crontab -l >"$current" 2>/dev/null || :

awk '
  function legacy(line) {
    return line !~ /^[[:space:]]*#/ &&
      line ~ /scripts\/analyze-log\.ts/ &&
      (line ~ /--channel=wework[[:space:]]+--source=telemetry[[:space:]]+--pg/ ||
       line ~ /--channel=feishu[[:space:]]+--source=telemetry[[:space:]]+--pg/)
  }
  !legacy($0) { print }
' "$current" >"$filtered"

if cmp -s "$current" "$filtered"; then
  printf 'No legacy session-audit cron entries found.\n'
  exit 0
fi

if [[ "$MODE" == "--dry-run" ]]; then
  printf 'Legacy entries that would be removed:\n'
  diff --unchanged-line-format='' --old-line-format='%L' --new-line-format='' \
    "$current" "$filtered" || [[ $? -eq 1 ]]
  exit 0
fi

status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
  otcclaw-session-audit 2>/dev/null || true)"
if [[ "$status" != "healthy" ]]; then
  printf 'Refusing to change crontab: otcclaw-session-audit is not healthy (%s).\n' \
    "${status:-missing}" >&2
  exit 1
fi
if ! docker exec otcclaw-session-audit node -e '
  const fs = require("node:fs");
  const heartbeat = JSON.parse(fs.readFileSync(
    "/app/samata/logs/daily_usage/.session-audit-heartbeat.json", "utf8"
  ));
  process.exit(heartbeat.status === "completed" ? 0 : 1);
'; then
  printf 'Refusing to change crontab: initial session audit has not completed.\n' >&2
  exit 1
fi

[[ "$BACKUP_ROOT" == /* && "$BACKUP_ROOT" != "/" && ! -L "$BACKUP_ROOT" ]] || {
  printf 'Unsafe crontab backup root: %s\n' "$BACKUP_ROOT" >&2
  exit 1
}
umask 077
mkdir -p "$BACKUP_ROOT"
backup="$(mktemp "$BACKUP_ROOT/crontab-$(date +%Y%m%d-%H%M%S).XXXXXX.txt")"
cp -- "$current" "$backup"
crontab "$filtered"
printf 'Legacy session-audit cron entries removed; backup: %s\n' "$backup"
