#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

env_value() {
  local value
  value=$(awk -v name="$1" 'index($0, name "=") == 1 { value = substr($0, length(name) + 2) } END { print value }' "$2")
  if [[ $value == \"*\" && $value == *\" ]] || [[ $value == \'*\' && $value == *\' ]]; then
    value=${value:1:${#value}-2}
  fi
  printf '%s' "$value"
}

install_headset() {
  local device=$1 relay_url=${2:-} publisher_key=${3:-}
  local adb_bin=${ADB:-adb}
  command -v "$adb_bin" >/dev/null || { echo "ADB not found: $adb_bin" >&2; exit 1; }
  if [[ $("$adb_bin" -s "$device" get-state 2>/dev/null) != device ]]; then
    echo "Quest $device is not connected and authorised; check adb devices" >&2
    exit 1
  fi
  command -v gradle >/dev/null || { echo 'Gradle not found; install it before sending the Quest app' >&2; exit 1; }
  bash "$root/tools/scripts/build-transport.sh"
  gradle -p "$root/quest/app" :app:assembleDebug --no-daemon
  "$adb_bin" -s "$device" install -r "$root/quest/app/app/build/outputs/apk/debug/app-debug.apk"
  if [[ -n $relay_url ]]; then
    "$adb_bin" -s "$device" shell am start -S \
      -n com.uqrealitylabs.questrelay/.MainActivity \
      --es relayUrl "$relay_url" --es publisherKey "$publisher_key"
    printf 'QuestRelay installed and configured on %s for %s\n' "$device" "$relay_url"
  else
    "$adb_bin" -s "$device" shell am start -S -n com.uqrealitylabs.questrelay/.MainActivity
    printf 'QuestRelay installed on %s. Set its relay URL and publisher key in Settings\n' "$device"
  fi
}

usage() {
  cat >&2 <<'USAGE'
Usage:
  tools/scripts/deploy.sh cf [--init-db]
  tools/scripts/deploy.sh dc
  tools/scripts/deploy.sh headset <adb-id>
  tools/scripts/deploy.sh server <ssh-target> <release-archive> [env-file]
  tools/scripts/deploy.sh adb devices
  tools/scripts/deploy.sh adb send <adb-id>

The send command installs the debug app only on the selected Quest; enter its
relay URL and publisher key in the app Settings
USAGE
  exit 2
}

(( $# > 0 )) || usage
case $1 in
  cf|cloudflare)
    shift
    if (( $# > 1 )) || [[ ${1:-} != '' && ${1:-} != --init-db ]]; then usage; fi
    if ! command -v worker-build >/dev/null; then
      echo 'Install worker-build 0.8.7 with cargo install worker-build --version 0.8.7 --locked' >&2
      exit 1
    fi
    cd "$root"
    npm run build -w @questrelay/shared
    npm run build -w @questrelay/web
    cd backend/edge
    if [[ ${1:-} == --init-db ]]; then
      npx --yes wrangler@4.144.0 d1 execute questrelay-edge --remote --file schema.sql
    fi
    npx --yes wrangler@4.144.0 deploy
    exit 0
    ;;
  dc)
    shift
    (( $# == 0 )) || usage
    env_file=$root/.env
    [[ -f $env_file ]] || {
      echo 'Create .env from tools/config/.env.example before deploying' >&2
      exit 2
    }
    command -v docker >/dev/null || {
      echo 'Docker with the Compose plugin is required' >&2
      exit 1
    }
    docker compose version >/dev/null
    compose=(
      docker compose
      --env-file "$env_file"
      -f "$root/tools/config/compose.yaml"
      --project-directory "$root"
    )
    "${compose[@]}" config --quiet
    "${compose[@]}" up -d --build --wait --wait-timeout 180

    environment=$("${compose[@]}" config --environment)
    domain=$(awk -F= '$1 == "QUESTRELAY_DOMAIN" {print substr($0, index($0, "=") + 1); exit}' <<<"$environment")
    tls=$(awk -F= '$1 == "QUESTRELAY_TLS" {print substr($0, index($0, "=") + 1); exit}' <<<"$environment")
    printf 'QuestRelay ready at https://%s\n' "$domain"
    printf 'Quest relay: wss://%s/ws/relay\n' "$domain"
    if [[ $tls == 'tls internal' ]]; then
      certificate=$root/questrelay-lan-ca.crt
      temporary=$(mktemp "$root/.questrelay-lan-ca.XXXXXX")
      trap 'rm -f "$temporary"' EXIT
      "${compose[@]}" cp \
        web:/data/caddy/pki/authorities/local/root.crt "$temporary"
      chmod 644 "$temporary"
      mv "$temporary" "$certificate"
      trap - EXIT
      printf 'Trust this CA on each client: %s\n' "$certificate"
    fi
    exit 0
    ;;
  headset)
    (( $# == 2 )) || usage
    env_file=$root/.env
    [[ -f $env_file ]] || {
      echo 'Create .env from tools/config/.env.example before provisioning a headset' >&2
      exit 2
    }
    publisher_key=$(env_value QUESTRELAY_PUBLISH_KEY "$env_file")
    [[ ${#publisher_key} -ge 32 ]] || {
      echo 'QUESTRELAY_PUBLISH_KEY in .env must be at least 32 characters' >&2
      exit 2
    }
    install_headset "$2" 'https://cast.uqrealitylabs.com' "$publisher_key"
    exit 0
    ;;
  adb)
    if [[ ${2:-} != devices || $# != 2 ]] && [[ ${2:-} != send || $# != 3 ]]; then usage; fi
    adb_bin=${ADB:-adb}
    command -v "$adb_bin" >/dev/null || { echo "ADB not found: $adb_bin" >&2; exit 1; }
    if [[ $2 == devices ]]; then
      exec "$adb_bin" devices -l
    fi
    install_headset "$3"
    exit 0
    ;;
  server)
    shift
    (( $# >= 2 && $# <= 3 )) || usage
    ;;
  *) usage ;;
esac

remote=$1
archive=$2
name=$(basename "$archive")
if [[ ! $name =~ ^questrelay-server-[A-Za-z0-9._-]+\.tar\.gz$ || ! -f $archive ]]; then
  echo "Pass an archive created by tools/scripts/distribute.sh" >&2
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
docker compose -f tools/config/compose.yaml --project-directory . --project-name questrelay config --quiet
docker compose -f tools/config/compose.yaml --project-directory . --project-name questrelay up -d --build --wait --wait-timeout 180
ln -sfnT "$release" "$base/current"
printf 'QuestRelay deployed from %s\n' "$release"
REMOTE
