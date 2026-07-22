#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<'USAGE'
Usage: bash scripts/docker-samata.sh [up|build|push|prune]

Build tags are derived from package.json:
  <docker-repo>/titans/otcclaw:v<version>-<MMddHHmmssSSS>

Environment overrides:
  DOCKER_REPO             Registry root, default: local
  IMAGE_VERSION           Primary image tag override
  OTCCLAW_IMAGE_REPO      Full legacy repository override
  OTCCLAW_IMAGE_TAG       Primary image tag, default: v<version>-<MMddHHmmssSSS>
  SAMATA_IMAGE_REPO       Backward-compatible alias for OTCCLAW_IMAGE_REPO
  SAMATA_IMAGE_TAG        Backward-compatible alias for OTCCLAW_IMAGE_TAG
  SAMATA_DEPLOY_ROOT      Must remain /opt/samata (production mounts are fixed)
  OTCCLAW_SQLITE_BASELINE SQLite baseline template, default: docker-baseline/samata.db
  OTCCLAW_DATA_FILES_BASELINE
                           Data files baseline archive, default: docker-baseline/data-files.tar.gz
  OTCCLAW_PUSH_ALIASES    Push <version> and latest compatibility tags when set to 1/true/yes/on
  SAMATA_PUSH_ALIASES     Backward-compatible alias for OTCCLAW_PUSH_ALIASES

Push to a remote registry:
  docker login <code-registry-host>
  npm run baseline:refresh
  DOCKER_REPO=dockertest.gf.com.cn bash scripts/docker-samata.sh push
USAGE
}

command="${1:-up}"
case "$command" in
  up|build|push|prune) ;;
  -h|--help|help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

docker_repo="${DOCKER_REPO:-}"
if [[ -z "$docker_repo" && "$command" == "up" && -f "$ROOT_DIR/.env" ]]; then
  docker_repo="$(node -e "
    const fs = require('node:fs');
    const dotenv = require('dotenv');
    const value = dotenv.parse(fs.readFileSync(process.argv[1], 'utf8')).DOCKER_REPO;
    if (value) process.stdout.write(value);
  " "$ROOT_DIR/.env")"
fi
docker_repo="${docker_repo:-local}"
legacy_image_repo="${OTCCLAW_IMAGE_REPO:-${SAMATA_IMAGE_REPO:-}}"
if [[ -n "$legacy_image_repo" ]]; then
  if [[ "$legacy_image_repo" != */titans/otcclaw ]]; then
    printf 'OTCCLAW_IMAGE_REPO must end with /titans/otcclaw for the production template: %s\n' \
      "$legacy_image_repo" >&2
    exit 2
  fi
  image_repo="$legacy_image_repo"
  docker_repo="${legacy_image_repo%/titans/otcclaw}"
else
  image_repo="${docker_repo}/titans/otcclaw"
fi
service_name="${OTCCLAW_COMPOSE_SERVICE:-${SAMATA_COMPOSE_SERVICE:-otcclaw}}"
deploy_root="${SAMATA_DEPLOY_ROOT:-/opt/samata}"
if [[ "$deploy_root" != "/opt/samata" ]]; then
  printf 'SAMATA_DEPLOY_ROOT must be /opt/samata because production mounts are fixed in docker-compose.yml\n' >&2
  exit 2
fi
sqlite_baseline="${OTCCLAW_SQLITE_BASELINE:-docker-baseline/samata.db}"
data_files_baseline="${OTCCLAW_DATA_FILES_BASELINE:-docker-baseline/data-files.tar.gz}"
version="$(node -e "const fs=require('fs'); const pkg=JSON.parse(fs.readFileSync('package.json','utf8')); if (!pkg.version) throw new Error('package.json missing version'); process.stdout.write(pkg.version)")"
build_stamp="$(node -e "const d=new Date(); const p=(n,w=2)=>String(n).padStart(w,'0'); process.stdout.write(p(d.getMonth()+1)+p(d.getDate())+p(d.getHours())+p(d.getMinutes())+p(d.getSeconds())+p(d.getMilliseconds(),3));")"
default_tag="v${version}-${build_stamp}"
primary_tag="${IMAGE_VERSION:-${OTCCLAW_IMAGE_TAG:-${SAMATA_IMAGE_TAG:-${default_tag}}}}"
push_aliases="${OTCCLAW_PUSH_ALIASES:-${SAMATA_PUSH_ALIASES:-0}}"

export OTCCLAW_IMAGE_REPO="$image_repo"
export OTCCLAW_IMAGE_TAG="$primary_tag"
export SAMATA_IMAGE_REPO="$image_repo"
export SAMATA_IMAGE_TAG="$primary_tag"
export SAMATA_VERSION="$version"
export SAMATA_DEPLOY_ROOT="$deploy_root"
export DOCKER_REPO="$docker_repo"
export IMAGE_VERSION="$primary_tag"

compose=(docker compose --env-file /dev/null -f docker-compose.local.yml)

is_truthy() {
  local value="${1,,}"
  [[ "$value" =~ ^(1|true|yes|on)$ ]]
}

ensure_deploy_root() {
  if [[ ! -f "$ROOT_DIR/.env" ]]; then
    cat >&2 <<EOF
Missing Samata render input: $ROOT_DIR/.env

Prepare the runtime directory before starting:
  sudo install -d -m 0775 -o "$(id -un)" -g "$(id -gn)" \
    "$deploy_root" "$deploy_root/data" "$deploy_root/logs"
  sudo install -d -m 0700 -o "$(id -un)" -g "$(id -gn)" "$deploy_root/ssh"
  cp .env.example .env
  chmod 600 .env

Then edit .env and .env.langfuse with production values and rerun this command.
EOF
    exit 1
  fi

  if [[ ! -f "$ROOT_DIR/.env.langfuse" ]]; then
    printf 'Missing Langfuse render input: %s/.env.langfuse\n' "$ROOT_DIR" >&2
    exit 1
  fi

  if [[ ! -f "$deploy_root/mcp-servers.json" ]]; then
    cat >&2 <<EOF
Missing Samata MCP server config: $deploy_root/mcp-servers.json

Prepare the runtime MCP config before starting:
  cp config/mcp-servers.example.json "$deploy_root/mcp-servers.json"
  chmod 600 "$deploy_root/mcp-servers.json"

Then edit $deploy_root/mcp-servers.json for this environment if needed.
Keep real credentials in the repository-local render inputs; the MCP config
should reference environment variables only.
EOF
    exit 1
  fi

  if ! mkdir -p "$deploy_root/data" "$deploy_root/logs" "$deploy_root/ssh"; then
    cat >&2 <<EOF
Failed to create runtime directories under $deploy_root.

Check ownership or prepare them manually:
  sudo install -d -m 0775 -o "$(id -un)" -g "$(id -gn)" \
    "$deploy_root" "$deploy_root/data" "$deploy_root/logs"
  sudo install -d -m 0700 -o "$(id -un)" -g "$(id -gn)" "$deploy_root/ssh"
EOF
    exit 1
  fi
}

require_postgres_data_directory() {
  local postgres_data="$deploy_root/data/postgres"
  if [[ ! -d "$postgres_data" || -L "$postgres_data" ]]; then
    cat >&2 <<EOF
PostgreSQL bind directory is not ready: $postgres_data

For a brand-new local-production deployment:
  sudo install -d -m 0700 -o 999 -g 999 "$postgres_data"

For an existing wind_sync_pg/samata deployment, render the production Compose
and run the reviewed migration instead:
  npm run compose:render
  bash scripts/migrate-samata-postgres.sh --execute
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

ensure_remote_image_repo() {
  if [[ "$docker_repo" == "local" || "$docker_repo" == "localhost" ]]; then
    cat >&2 <<'EOF'
Refusing to push a default local image name.

Set DOCKER_REPO to the Code artifact registry root first, for example:
  DOCKER_REPO=dockertest.gf.com.cn bash scripts/docker-samata.sh push

Make sure docker login has already succeeded for <code-registry-host>.
EOF
    exit 1
  fi
}

ensure_sqlite_baseline() {
  if [[ ! -s "$sqlite_baseline" ]]; then
    cat >&2 <<EOF
Missing SQLite baseline template: $sqlite_baseline

Refresh it from the current runtime database before pushing:
  npm run sqlite:baseline:refresh

The baseline contains the full runtime SQLite database and must only be pushed
to a controlled registry.
EOF
    exit 1
  fi
}

ensure_data_files_baseline() {
  if [[ ! -s "$data_files_baseline" ]]; then
    cat >&2 <<EOF
Missing data files baseline archive: $data_files_baseline

Refresh it from the current runtime data directory before pushing:
  npm run data:baseline:refresh

For a consistent first-start image, refresh both SQLite and file baselines:
  npm run baseline:refresh

The data files baseline contains documents, wiki, plugin data, and dreams. It
must only be pushed to a controlled registry.
EOF
    exit 1
  fi
}

if [[ "$command" == "prune" ]]; then
  docker image prune -f
  exit 0
fi

if [[ "$command" == "push" ]]; then
  ensure_remote_image_repo
  ensure_sqlite_baseline
  ensure_data_files_baseline
fi

if [[ "$command" == "build" || "$command" == "push" ]]; then
  "${compose[@]}" build "$service_name"
else
  ensure_deploy_root
  acquire_deploy_lock
  "${compose[@]}" build "$service_name"
  node scripts/render-local-compose.mjs \
    --output "$deploy_root/docker-compose.yml" \
    --docker-repo "$DOCKER_REPO" \
    --image-version "$IMAGE_VERSION"
  require_postgres_data_directory
  docker compose --env-file /dev/null --file "$deploy_root/docker-compose.yml" up -d --no-build
fi

docker image inspect "${image_repo}:${primary_tag}" >/dev/null

if [[ "$command" == "push" ]]; then
  docker push "${image_repo}:${primary_tag}"
  if is_truthy "$push_aliases"; then
    docker tag "${image_repo}:${primary_tag}" "${image_repo}:${version}"
    docker tag "${image_repo}:${primary_tag}" "${image_repo}:latest"
    docker push "${image_repo}:${version}"
    docker push "${image_repo}:latest"
  fi
fi

cat <<EOF
OtcClaw image tags:
  ${image_repo}:${primary_tag}
EOF

if is_truthy "$push_aliases"; then
  cat <<EOF
  ${image_repo}:${version}
  ${image_repo}:latest
EOF
fi
