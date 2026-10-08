#!/usr/bin/env bash
set -euo pipefail

script=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/changes.sh

expect() {
  expected=$(printf 'web=%s\nbackend=%s\nedge=%s\nquest=%s\ndeploy=%s\nnpm_audit=%s\nrust_audit=%s' \
    "$1" "$2" "$3" "$4" "$5" "$6" "$7")
  shift 7
  actual=$(printf '%s\0' "$@" | "$script" --paths)
  if [[ $actual != "$expected" ]]; then
    printf 'Wrong checks for %s\nExpected:\n%s\nActual:\n%s\n' "$*" "$expected" "$actual" >&2
    exit 1
  fi
}

expect false false false false false false false README.md
expect true false false false false false false frontend/src/main.tsx
expect false true false false false false false backend/src/main.rs
expect false false true false false false false backend/edge/src/lib.rs
expect false false true false false false true backend/edge/Cargo.lock
expect false false false true false false false quest/app/app/build.gradle
expect false false false true false false false quest/transport/transport.go
expect false false false true false false false tools/scripts/build-transport.sh
expect true true true true true false false tools/scripts/deploy.sh
expect false false false false true false false tools/config/compose.yaml
expect true false false false false false false tools/config/tsconfig.base.json
expect true true false false false true true package-lock.json backend/Cargo.lock
expect true true true true true true true .github/workflows/check.yml

GITHUB_REF=refs/tags/v0.8.0 expect false false false false false false false README.md

actual=$($script --all)
expected=$(printf 'web=true\nbackend=true\nedge=true\nquest=true\ndeploy=true\nnpm_audit=true\nrust_audit=true')
[[ $actual == "$expected" ]]
