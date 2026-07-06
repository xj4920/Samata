#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<'USAGE'
Usage: bash scripts/deploy-otcclaw.sh [deploy|pull|up]

Deploy OtcClaw with the self-hosted Langfuse stack from dockertest images.

Required:
  OTCCLAW_IMAGE_TAG       OtcClaw image tag, for example v3.0.21-0706151315996

Common overrides:
  OTCCLAW_IMAGE_REPO      OtcClaw image repository, default: dockertest.gf.com.cn/titans/otcclaw
  SAMATA_DEPLOY_ROOT      Runtime config/data/log root, default: /opt/samata
  LANGFUSE_ENV_FILE       Langfuse env file, default: .env.langfuse
  LANGFUSE_IMAGE_PREFIX   Langfuse image prefix, default: dockertest.gf.com.cn/titans/otcclaw-langfuse
  LANGFUSE_IMAGE_TAG      Langfuse web/worker tag, default: 3
  OTCCLAW_WITH_WIND_SYNC  Add docker-compose.wind-sync.yml when set to 1/true/yes/on

Examples:
  docker login dockertest.gf.com.cn
  OTCCLAW_IMAGE_TAG=v3.0.21-0706151315996 bash scripts/deploy-otcclaw.sh deploy
  OTCCLAW_IMAGE_TAG=v3.0.21-0706151315996 OTCCLAW_WITH_WIND_SYNC=1 bash scripts/deploy-otcclaw.sh up
USAGE
}

command="${1:-deploy}"
case "$command" in
  deploy|pull|up) ;;
  -h|--help|help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

is_truthy() {
  local value="${1,,}"
  [[ "$value" =~ ^(1|true|yes|on)$ ]]
}

require_file() {
  local path="$1"
  local help="$2"
  if [[ ! -f "$path" ]]; then
    printf 'Missing required file: %s\n\n%s\n' "$path" "$help" >&2
    exit 1
  fi
}

otcclaw_repo="${OTCCLAW_IMAGE_REPO:-dockertest.gf.com.cn/titans/otcclaw}"
otcclaw_tag="${OTCCLAW_IMAGE_TAG:-}"
deploy_root="${SAMATA_DEPLOY_ROOT:-/opt/samata}"
langfuse_env_file="${LANGFUSE_ENV_FILE:-.env.langfuse}"
langfuse_prefix="${LANGFUSE_IMAGE_PREFIX:-dockertest.gf.com.cn/titans/otcclaw-langfuse}"
langfuse_tag="${LANGFUSE_IMAGE_TAG:-3}"

if [[ -z "$otcclaw_tag" ]]; then
  cat >&2 <<'EOF'
OTCCLAW_IMAGE_TAG is required.

Use the exact tag published by scripts/docker-samata.sh, for example:
  OTCCLAW_IMAGE_TAG=v3.0.21-0706151315996 bash scripts/deploy-otcclaw.sh deploy
EOF
  exit 1
fi

export OTCCLAW_IMAGE_REPO="$otcclaw_repo"
export OTCCLAW_IMAGE_TAG="$otcclaw_tag"
export SAMATA_IMAGE_REPO="$otcclaw_repo"
export SAMATA_IMAGE_TAG="$otcclaw_tag"
export SAMATA_DEPLOY_ROOT="$deploy_root"
export LANGFUSE_ENV_FILE="$langfuse_env_file"

export LANGFUSE_WEB_IMAGE="${LANGFUSE_WEB_IMAGE:-${langfuse_prefix}:${langfuse_tag}}"
export LANGFUSE_WORKER_IMAGE="${LANGFUSE_WORKER_IMAGE:-${langfuse_prefix}-worker:${langfuse_tag}}"
export LANGFUSE_CLICKHOUSE_IMAGE="${LANGFUSE_CLICKHOUSE_IMAGE:-${langfuse_prefix}-clickhouse-server:latest}"
export LANGFUSE_MINIO_IMAGE="${LANGFUSE_MINIO_IMAGE:-${langfuse_prefix}-minio:latest}"
export LANGFUSE_REDIS_IMAGE="${LANGFUSE_REDIS_IMAGE:-${langfuse_prefix}-redis:7}"
export LANGFUSE_POSTGRES_IMAGE="${LANGFUSE_POSTGRES_IMAGE:-${langfuse_prefix}-postgres:16}"

compose=(docker compose --env-file "$langfuse_env_file" -f docker-compose.yml -f docker-compose.langfuse.yml)
if is_truthy "${OTCCLAW_WITH_WIND_SYNC:-0}"; then
  compose+=(-f docker-compose.wind-sync.yml)
fi

pull_images=(
  "${OTCCLAW_IMAGE_REPO}:${OTCCLAW_IMAGE_TAG}"
  "$LANGFUSE_WEB_IMAGE"
  "$LANGFUSE_WORKER_IMAGE"
  "$LANGFUSE_CLICKHOUSE_IMAGE"
  "$LANGFUSE_MINIO_IMAGE"
  "$LANGFUSE_REDIS_IMAGE"
  "$LANGFUSE_POSTGRES_IMAGE"
)

pull_all_images() {
  for image in "${pull_images[@]}"; do
    echo "==> docker pull $image"
    docker pull "$image"
  done
}

validate_runtime_files() {
  require_file "$deploy_root/.env" "Prepare it from .env.example, then fill production secrets."
  require_file "$deploy_root/mcp-servers.json" "Prepare it from config/mcp-servers.example.json."
  require_file "$langfuse_env_file" "Prepare it from .env.langfuse.example, then fill Langfuse secrets."
  mkdir -p "$deploy_root/data" "$deploy_root/logs"
}

start_services() {
  validate_runtime_files
  "${compose[@]}" up -d --no-build \
    langfuse-postgres \
    langfuse-clickhouse \
    langfuse-redis \
    langfuse-minio \
    langfuse-worker \
    langfuse-web \
    otcclaw
}

case "$command" in
  pull)
    pull_all_images
    ;;
  up)
    start_services
    ;;
  deploy)
    pull_all_images
    start_services
    ;;
esac

cat <<EOF
OtcClaw deployment images:
  ${OTCCLAW_IMAGE_REPO}:${OTCCLAW_IMAGE_TAG}
  ${LANGFUSE_WEB_IMAGE}
  ${LANGFUSE_WORKER_IMAGE}
  ${LANGFUSE_CLICKHOUSE_IMAGE}
  ${LANGFUSE_MINIO_IMAGE}
  ${LANGFUSE_REDIS_IMAGE}
  ${LANGFUSE_POSTGRES_IMAGE}
EOF
