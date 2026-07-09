#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<'USAGE'
Usage: bash scripts/docker-samata.sh [up|build|push|prune]

Build tags are derived from package.json:
  otcclaw:v<version>-<MMddHHmmssSSS>

Environment overrides:
  OTCCLAW_IMAGE_REPO      Image repository name, default: otcclaw
  OTCCLAW_IMAGE_TAG       Primary image tag, default: v<version>-<MMddHHmmssSSS>
  SAMATA_IMAGE_REPO       Backward-compatible alias for OTCCLAW_IMAGE_REPO
  SAMATA_IMAGE_TAG        Backward-compatible alias for OTCCLAW_IMAGE_TAG
  SAMATA_DEPLOY_ROOT      Runtime config/data/log root, default: /opt/samata
  OTCCLAW_SQLITE_BASELINE SQLite baseline template, default: docker-baseline/samata.db
  OTCCLAW_DATA_FILES_BASELINE
                           Data files baseline archive, default: docker-baseline/data-files.tar.gz
  OTCCLAW_PUSH_ALIASES    Push <version> and latest compatibility tags when set to 1/true/yes/on
  SAMATA_PUSH_ALIASES     Backward-compatible alias for OTCCLAW_PUSH_ALIASES

Push to a remote registry:
  docker login <code-registry-host>
  npm run baseline:refresh
  OTCCLAW_IMAGE_REPO=dockertest.gf.com.cn/titans/otcclaw bash scripts/docker-samata.sh push
USAGE
}

command="${1:-up}"
case "$command" in
  up|build|push|prune) ;;
  -h|--help|help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

image_repo="${OTCCLAW_IMAGE_REPO:-${SAMATA_IMAGE_REPO:-otcclaw}}"
service_name="${OTCCLAW_COMPOSE_SERVICE:-${SAMATA_COMPOSE_SERVICE:-otcclaw}}"
deploy_root="${SAMATA_DEPLOY_ROOT:-/opt/samata}"
sqlite_baseline="${OTCCLAW_SQLITE_BASELINE:-docker-baseline/samata.db}"
data_files_baseline="${OTCCLAW_DATA_FILES_BASELINE:-docker-baseline/data-files.tar.gz}"
version="$(node -e "const fs=require('fs'); const pkg=JSON.parse(fs.readFileSync('package.json','utf8')); if (!pkg.version) throw new Error('package.json missing version'); process.stdout.write(pkg.version)")"
build_stamp="$(node -e "const d=new Date(); const p=(n,w=2)=>String(n).padStart(w,'0'); process.stdout.write(p(d.getMonth()+1)+p(d.getDate())+p(d.getHours())+p(d.getMinutes())+p(d.getSeconds())+p(d.getMilliseconds(),3));")"
default_tag="v${version}-${build_stamp}"
primary_tag="${OTCCLAW_IMAGE_TAG:-${SAMATA_IMAGE_TAG:-${default_tag}}}"
push_aliases="${OTCCLAW_PUSH_ALIASES:-${SAMATA_PUSH_ALIASES:-0}}"

export OTCCLAW_IMAGE_REPO="$image_repo"
export OTCCLAW_IMAGE_TAG="$primary_tag"
export SAMATA_IMAGE_REPO="$image_repo"
export SAMATA_IMAGE_TAG="$primary_tag"
export SAMATA_VERSION="$version"
export SAMATA_DEPLOY_ROOT="$deploy_root"

compose=(docker compose --env-file /dev/null)

is_truthy() {
  local value="${1,,}"
  [[ "$value" =~ ^(1|true|yes|on)$ ]]
}

ensure_deploy_root() {
  if [[ ! -f "$deploy_root/.env" ]]; then
    cat >&2 <<EOF
Missing Samata deployment env file: $deploy_root/.env

Prepare the runtime directory before starting:
  sudo mkdir -p "$deploy_root/data" "$deploy_root/logs"
  sudo chown -R "$(id -un):$(id -gn)" "$deploy_root"
  cp .env.example "$deploy_root/.env"
  chmod 600 "$deploy_root/.env"

Then edit $deploy_root/.env with production values and rerun this command.
EOF
    exit 1
  fi

  if [[ ! -f "$deploy_root/mcp-servers.json" ]]; then
    cat >&2 <<EOF
Missing Samata MCP server config: $deploy_root/mcp-servers.json

Prepare the runtime MCP config before starting:
  cp config/mcp-servers.example.json "$deploy_root/mcp-servers.json"
  chmod 600 "$deploy_root/mcp-servers.json"

Then edit $deploy_root/mcp-servers.json for this environment if needed.
Keep real credentials in $deploy_root/.env; the MCP config should reference environment variables only.
EOF
    exit 1
  fi

  if ! mkdir -p "$deploy_root/data" "$deploy_root/logs"; then
    cat >&2 <<EOF
Failed to create runtime directories under $deploy_root.

Check ownership or prepare them manually:
  sudo mkdir -p "$deploy_root/data" "$deploy_root/logs"
  sudo chown -R "$(id -un):$(id -gn)" "$deploy_root"
EOF
    exit 1
  fi
}

ensure_remote_image_repo() {
  if [[ -z "${OTCCLAW_IMAGE_REPO:-${SAMATA_IMAGE_REPO:-}}" || "$image_repo" == "otcclaw" || "$image_repo" == "samata" ]]; then
    cat >&2 <<'EOF'
Refusing to push a default local image name.

Set OTCCLAW_IMAGE_REPO to the Code artifact registry repository first, for example:
  OTCCLAW_IMAGE_REPO=dockertest.gf.com.cn/titans/otcclaw bash scripts/docker-samata.sh push

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
  "${compose[@]}" up -d --build "$service_name"
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
