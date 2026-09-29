#!/usr/bin/env bash
set -euo pipefail

if (( $# < 2 || $# > 3 )); then
  echo "Usage: scripts/deploy.sh <ssh-target> <release-archive> [env-file]" >&2
  exit 2
fi

remote=$1
archive=$2
name=$(basename "$archive")
if [[ ! $name =~ ^questrelay-server-[A-Za-z0-9._-]+\.tar\.gz$ || ! -f $archive ]]; then
  echo "Pass an archive created by scripts/distribute.sh" >&2
  exit 2
fi

if [[ -f $archive.sha256 ]]; then
  (cd "$(dirname "$archive")" && shasum -a 256 -c "$name.sha256")
fi

ssh "$remote" 'mkdir -p "$HOME/questrelay/incoming" "$HOME/questrelay/releases"'
scp "$archive" "$remote:questrelay/incoming/$name"

if (( $# == 3 )); then
  [[ -f $3 ]] || { echo "Environment file not found: $3" >&2; exit 2; }
  scp "$3" "$remote:questrelay/.env.new"
  ssh "$remote" 'chmod 600 "$HOME/questrelay/.env.new" && mv "$HOME/questrelay/.env.new" "$HOME/questrelay/.env"'
fi

ssh "$remote" bash -s -- "$name" <<'REMOTE'
set -euo pipefail

name=$1
base=$HOME/questrelay
release="$base/releases/${name%.tar.gz}"
[[ -f $base/.env ]] || { echo "Create $base/.env before deploying" >&2; exit 1; }
command -v docker >/dev/null || { echo "Docker is required on the server" >&2; exit 1; }

if [[ ! -d $release ]]; then
  temporary=$(mktemp -d "$base/releases/.unpack.XXXXXX")
  trap 'rm -rf "$temporary"' EXIT
  tar -xzf "$base/incoming/$name" -C "$temporary" --strip-components=1
  mv "$temporary" "$release"
  trap - EXIT
fi

ln -sfn "$base/.env" "$release/.env"
cd "$release"
docker compose --project-name questrelay config --quiet
docker compose --project-name questrelay up -d --build --wait --wait-timeout 180
ln -sfnT "$release" "$base/current"
printf 'QuestRelay deployed from %s\n' "$release"
REMOTE
