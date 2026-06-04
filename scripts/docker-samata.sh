#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<'USAGE'
Usage: bash scripts/docker-samata.sh [up|build|prune]

Build tags are derived from package.json:
  samata:<version>-<git-sha>
  samata:<version>
  samata:latest

Environment overrides:
  SAMATA_IMAGE_REPO   Image repository name, default: samata
  SAMATA_IMAGE_TAG    Primary image tag, default: <version>-<git-sha>[-dirty-YYYYMMDDHHMMSS]
USAGE
}

command="${1:-up}"
case "$command" in
  up|build|prune) ;;
  -h|--help|help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

image_repo="${SAMATA_IMAGE_REPO:-samata}"
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

compose=(docker compose --env-file /dev/null)

if [[ "$command" == "prune" ]]; then
  docker image prune -f
  exit 0
fi

if [[ "$command" == "build" ]]; then
  "${compose[@]}" build samata
else
  "${compose[@]}" up -d --build samata
fi

docker image inspect "${image_repo}:${primary_tag}" >/dev/null
docker tag "${image_repo}:${primary_tag}" "${image_repo}:${version}"
docker tag "${image_repo}:${primary_tag}" "${image_repo}:latest"

cat <<EOF
Samata image tags:
  ${image_repo}:${primary_tag}
  ${image_repo}:${version}
  ${image_repo}:latest
EOF
