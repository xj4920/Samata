#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<'USAGE'
Usage: bash scripts/docker-samata.sh [up|build|push|prune]

Build tags are derived from package.json:
  samata:<version>-<git-sha>
  samata:<version>
  samata:latest

Environment overrides:
  SAMATA_IMAGE_REPO   Image repository name, default: samata
  SAMATA_IMAGE_TAG    Primary image tag, default: <version>-<git-sha>[-dirty-YYYYMMDDHHMMSS]
  SAMATA_DEPLOY_ROOT  Runtime config/data/log root, default: /opt/samata

Push to a remote registry:
  docker login <code-registry-host>
  SAMATA_IMAGE_REPO=<code-registry-host>/<namespace>/samata bash scripts/docker-samata.sh push
USAGE
}

command="${1:-up}"
case "$command" in
  up|build|push|prune) ;;
  -h|--help|help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

image_repo="${SAMATA_IMAGE_REPO:-samata}"
deploy_root="${SAMATA_DEPLOY_ROOT:-/opt/samata}"
version="$(node -e "const fs=require('fs'); const pkg=JSON.parse(fs.readFileSync('package.json','utf8')); if (!pkg.version) throw new Error('package.json missing version'); process.stdout.write(pkg.version)")"
commit="$(git rev-parse --short=12 HEAD 2>/dev/null || printf 'nogit')"

dirty_suffix=""
if ! git diff --quiet --ignore-submodules -- 2>/dev/null || ! git diff --cached --quiet --ignore-submodules -- 2>/dev/null; then
  dirty_suffix="-dirty-$(date +%Y%m%d%H%M%S)"
fi

primary_tag="${SAMATA_IMAGE_TAG:-${version}-${commit}${dirty_suffix}}"

export SAMATA_IMAGE_REPO="$image_repo"
export SAMATA_IMAGE_TAG="$primary_tag"
export SAMATA_VERSION="$version"
export SAMATA_COMMIT="$commit"
export SAMATA_DEPLOY_ROOT="$deploy_root"

compose=(docker compose --env-file /dev/null)

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
  if [[ -z "${SAMATA_IMAGE_REPO:-}" || "$image_repo" == "samata" ]]; then
    cat >&2 <<'EOF'
Refusing to push the default local image name "samata".

Set SAMATA_IMAGE_REPO to the Code artifact registry repository first, for example:
  SAMATA_IMAGE_REPO=<code-registry-host>/<namespace>/samata bash scripts/docker-samata.sh push

Make sure docker login has already succeeded for <code-registry-host>.
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
fi

if [[ "$command" == "build" || "$command" == "push" ]]; then
  "${compose[@]}" build samata
else
  ensure_deploy_root
  "${compose[@]}" up -d --build samata
fi

docker image inspect "${image_repo}:${primary_tag}" >/dev/null
docker tag "${image_repo}:${primary_tag}" "${image_repo}:${version}"
docker tag "${image_repo}:${primary_tag}" "${image_repo}:latest"

if [[ "$command" == "push" ]]; then
  docker push "${image_repo}:${primary_tag}"
  docker push "${image_repo}:${version}"
  docker push "${image_repo}:latest"
fi

cat <<EOF
Samata image tags:
  ${image_repo}:${primary_tag}
  ${image_repo}:${version}
  ${image_repo}:latest
EOF
