#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<'USAGE'
Usage: bash scripts/deploy-otcclaw.sh [render|pull|up|deploy]

Renders the production docker-compose.yml template and operates only on the
generated file. The source template is never overwritten.

Inputs:
  SAMATA_ENV_FILE           Samata render input, default: <repo>/.env
  LANGFUSE_ENV_FILE         Langfuse render input, default: <repo>/.env.langfuse
  DOCKER_REPO               Overrides .env DOCKER_REPO
  IMAGE_VERSION             Overrides .env IMAGE_VERSION

Examples:
  bash scripts/deploy-otcclaw.sh render
  IMAGE_VERSION=v3.0.31-release bash scripts/deploy-otcclaw.sh deploy
  # Read-only inspection of the generated runtime file:
  cd /opt/samata && docker compose --env-file /dev/null config --quiet
USAGE
}

command="${1:-deploy}"
case "$command" in
  render|pull|up|deploy) ;;
  -h|--help|help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

deploy_root="${SAMATA_DEPLOY_ROOT:-/opt/samata}"
if [[ "$deploy_root" != "/opt/samata" ]]; then
  printf 'SAMATA_DEPLOY_ROOT must be /opt/samata because production mounts are fixed in docker-compose.yml\n' >&2
  exit 2
fi
compose_file="$deploy_root/docker-compose.yml"
samata_env_file="${SAMATA_ENV_FILE:-$ROOT_DIR/.env}"
langfuse_env_file="${LANGFUSE_ENV_FILE:-$ROOT_DIR/.env.langfuse}"

require_file() {
  local path="$1"
  local help="$2"
  if [[ ! -f "$path" ]]; then
    printf 'Missing required file: %s\n%s\n' "$path" "$help" >&2
    exit 1
  fi
}

prepare_runtime_root() {
  require_file "$samata_env_file" "Copy .env.example to .env and fill production values."
  require_file "$langfuse_env_file" "Copy .env.langfuse.example to .env.langfuse and fill production values."
  require_file "$deploy_root/mcp-servers.json" \
    "Copy config/mcp-servers.example.json to $deploy_root/mcp-servers.json."
  mkdir -p "$deploy_root/data" "$deploy_root/logs" "$deploy_root/ssh"
}

acquire_deploy_lock() {
  command -v flock >/dev/null 2>&1 || {
    printf 'flock is required for deployment coordination\n' >&2
    exit 1
  }
  [[ -d "$deploy_root" && ! -L "$deploy_root" ]] || {
    printf 'Trusted deployment root is missing or is a symlink: %s\n' "$deploy_root" >&2
    exit 1
  }
  exec 9<"$deploy_root"
  flock -n 9 || {
    printf 'Another Samata deployment or PostgreSQL migration is active\n' >&2
    exit 1
  }
}

require_postgres_data_directory() {
  local postgres_data="$deploy_root/data/postgres"
  if [[ ! -d "$postgres_data" || -L "$postgres_data" ]]; then
    cat >&2 <<EOF
PostgreSQL bind directory is not ready: $postgres_data

Existing deployment with wind_sync_pg/samata:
  bash scripts/migrate-samata-postgres.sh --execute

Brand-new deployment with no Samata business data to migrate:
  sudo install -d -m 0700 -o 999 -g 999 "$postgres_data"

Then rerun this command. Do not recursively chown $deploy_root/data after the
PostgreSQL directory has been created.
EOF
    exit 1
  fi

  local ownership
  ownership="$(stat -c '%u:%g:%a' "$postgres_data")"
  if [[ "$ownership" != "999:999:700" ]]; then
    printf 'PostgreSQL bind directory must be 999:999 mode 0700; got %s for %s\n' \
      "$ownership" "$postgres_data" >&2
    exit 1
  fi
}

render_compose() {
  prepare_runtime_root
  acquire_deploy_lock
  local args=(
    node scripts/render-local-compose.mjs
    --source "$ROOT_DIR/docker-compose.yml"
    --output "$compose_file"
    --env-file "$samata_env_file"
    --env-file "$langfuse_env_file"
  )
  if [[ -n "${DOCKER_REPO:-}" ]]; then args+=(--docker-repo "$DOCKER_REPO"); fi
  if [[ -n "${IMAGE_VERSION:-}" ]]; then args+=(--image-version "$IMAGE_VERSION"); fi
  "${args[@]}"
}

render_compose

case "$command" in
  render)
    ;;
  pull)
    docker compose --env-file /dev/null --file "$compose_file" pull
    ;;
  up)
    require_postgres_data_directory
    docker compose --env-file /dev/null --file "$compose_file" up -d --no-build
    ;;
  deploy)
    docker compose --env-file /dev/null --file "$compose_file" pull
    require_postgres_data_directory
    docker compose --env-file /dev/null --file "$compose_file" up -d --no-build
    ;;
esac

cat <<EOF
Generated production compose:
  $compose_file

Read-only generated-config inspection:
  cd $deploy_root
  docker compose --env-file /dev/null config --quiet

For later starts, run this repository entrypoint again with "up" so it acquires
the shared deployment lock. Direct Compose is reserved for an exclusive
maintenance window and must never overlap a migration or repository deploy.
EOF
