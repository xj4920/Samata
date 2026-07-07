#!/usr/bin/env bash
set -euo pipefail

DNS_SERVERS=("10.55.66.66" "10.80.66.66")
FALLBACK_DNS="${SAMATA_DNS_FALLBACK:-8.8.8.8}"
TEST_HOST="${SAMATA_DNS_TEST_HOST:-devops.gf.com.cn}"

RESOLVED_DROPIN_DIR="/etc/systemd/resolved.conf.d"
RESOLVED_DROPIN_FILE="${RESOLVED_DROPIN_DIR}/10-samata-enterprise-dns.conf"
RESOLVCONF_HEAD="/etc/resolvconf/resolv.conf.d/head"
BACKUP_DIR="/etc/samata/dns-backups"

MANAGED_BEGIN="# BEGIN Samata enterprise DNS"
MANAGED_END="# END Samata enterprise DNS"

usage() {
  cat <<'USAGE'
Usage: sudo bash scripts/configure-system-dns.sh [apply|check|rollback]

Commands:
  apply     Configure systemd-resolved and the system resolver entrypoint.
  check     Print DNS status without changing the system.
  rollback  Remove the Samata DNS drop-in and managed resolvconf block.

Environment:
  SAMATA_DNS_FALLBACK   Fallback DNS server, default: 8.8.8.8
  SAMATA_DNS_TEST_HOST  Hostname used for getent verification, default: devops.gf.com.cn
USAGE
}

command="${1:-apply}"
case "$command" in
  apply|check|rollback) ;;
  -h|--help|help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

require_root() {
  if [[ "$(id -u)" != "0" ]]; then
    echo "This command writes system DNS config and must be run with sudo." >&2
    exit 1
  fi
}

backup_file() {
  local file="$1"
  [[ -e "$file" || -L "$file" ]] || return 0

  mkdir -p "$BACKUP_DIR"
  local stamp safe_name
  stamp="$(date +%Y%m%d%H%M%S)"
  safe_name="${file#/}"
  safe_name="${safe_name//\//_}"
  cp -a "$file" "${BACKUP_DIR}/${safe_name}.${stamp}.bak"
}

strip_managed_block() {
  local input="$1"
  local output="$2"

  if [[ ! -f "$input" ]]; then
    : > "$output"
    return
  fi

  awk -v begin="$MANAGED_BEGIN" -v end="$MANAGED_END" '
    $0 == begin { skipping = 1; next }
    $0 == end { skipping = 0; next }
    !skipping { print }
  ' "$input" > "$output"
}

write_resolved_dropin() {
  mkdir -p "$RESOLVED_DROPIN_DIR"
  backup_file "$RESOLVED_DROPIN_FILE"

  local tmp
  tmp="$(mktemp)"
  cat > "$tmp" <<EOF
[Resolve]
DNS=${DNS_SERVERS[*]}
FallbackDNS=${FALLBACK_DNS}
Domains=~.
EOF
  install -m 0644 "$tmp" "$RESOLVED_DROPIN_FILE"
  rm -f "$tmp"
}

configure_resolver_entrypoint() {
  local target
  target="$(readlink -f /etc/resolv.conf 2>/dev/null || true)"

  if [[ "$target" == "/run/resolvconf/resolv.conf" && -f "$RESOLVCONF_HEAD" ]]; then
    backup_file "$RESOLVCONF_HEAD"

    local clean next
    clean="$(mktemp)"
    next="$(mktemp)"
    strip_managed_block "$RESOLVCONF_HEAD" "$clean"
    {
      echo "$MANAGED_BEGIN"
      echo "# Route libc DNS lookups through systemd-resolved first."
      echo "nameserver 127.0.0.53"
      echo "$MANAGED_END"
      cat "$clean"
    } > "$next"
    install -m 0644 "$next" "$RESOLVCONF_HEAD"
    rm -f "$clean" "$next"

    if command -v resolvconf >/dev/null 2>&1; then
      resolvconf -u
    fi
    return
  fi

  if [[ "$target" == "/run/systemd/resolve/stub-resolv.conf" ]]; then
    return
  fi

  backup_file /etc/resolv.conf
  ln -sfn ../run/systemd/resolve/stub-resolv.conf /etc/resolv.conf
}

restart_resolved() {
  if command -v systemctl >/dev/null 2>&1; then
    systemctl restart systemd-resolved
  else
    service systemd-resolved restart
  fi
}

remove_managed_resolvconf_block() {
  [[ -f "$RESOLVCONF_HEAD" ]] || return 0
  backup_file "$RESOLVCONF_HEAD"

  local next
  next="$(mktemp)"
  strip_managed_block "$RESOLVCONF_HEAD" "$next"
  install -m 0644 "$next" "$RESOLVCONF_HEAD"
  rm -f "$next"

  if command -v resolvconf >/dev/null 2>&1; then
    resolvconf -u
  fi
}

rollback() {
  rm -f "$RESOLVED_DROPIN_FILE"
  remove_managed_resolvconf_block
  restart_resolved
}

print_status() {
  echo "== /etc/resolv.conf =="
  ls -l /etc/resolv.conf || true
  sed -n '1,12p' /etc/resolv.conf || true
  echo

  if command -v resolvectl >/dev/null 2>&1; then
    echo "== resolvectl DNS =="
    resolvectl dns || true
    echo
    echo "== resolved status summary =="
    resolvectl status | sed -n '1,45p' || true
    echo
  fi

  echo "== getent ${TEST_HOST} =="
  getent hosts "$TEST_HOST" || true
}

verify() {
  local first_ns
  first_ns="$(awk '/^nameserver / { print $2; exit }' /etc/resolv.conf 2>/dev/null || true)"
  if [[ "$first_ns" != "127.0.0.53" ]]; then
    echo "Warning: first nameserver in /etc/resolv.conf is '${first_ns:-<none>}', expected 127.0.0.53." >&2
  fi

  if command -v resolvectl >/dev/null 2>&1; then
    local dns_output
    dns_output="$(resolvectl dns 2>/dev/null || true)"
    for server in "${DNS_SERVERS[@]}"; do
      if ! grep -q "$server" <<<"$dns_output"; then
        echo "Warning: resolvectl dns does not show ${server}." >&2
      fi
    done
  fi
}

case "$command" in
  check)
    print_status
    verify
    ;;
  apply)
    require_root
    write_resolved_dropin
    configure_resolver_entrypoint
    restart_resolved
    print_status
    verify
    ;;
  rollback)
    require_root
    rollback
    print_status
    ;;
esac
