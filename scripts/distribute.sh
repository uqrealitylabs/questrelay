#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"

if [[ -n $(git status --porcelain) ]]; then
  echo "Commit the working tree before packaging a release" >&2
  exit 1
fi

version=${1:-$(git describe --tags --exact-match HEAD 2>/dev/null || git rev-parse --short HEAD)}
if [[ ! $version =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  echo "Invalid release version: $version" >&2
  exit 1
fi

mkdir -p dist
archive="dist/questrelay-server-$version.tar.gz"
temporary=$(mktemp "$archive.XXXXXX")
trap 'rm -f "$temporary"' EXIT

git archive --format=tar --prefix=questrelay/ HEAD -- \
  .dockerignore .env.example backend compose.yaml deploy/Caddyfile frontend \
  package.json package-lock.json quest/prototype-server/package.json \
  scripts/deploy.sh | gzip -n > "$temporary"

mv "$temporary" "$archive"
trap - EXIT
(cd dist && shasum -a 256 "$(basename "$archive")" > "$(basename "$archive").sha256")
printf '%s\n' "$archive"
