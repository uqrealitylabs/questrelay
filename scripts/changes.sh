#!/usr/bin/env bash
set -euo pipefail

mode=${1:-event}
if (( $# > 1 )) || [[ $mode != event && $mode != --all && $mode != --paths ]]; then
  echo 'Usage: scripts/changes.sh [--all|--paths]' >&2
  exit 2
fi

web=false backend=false quest=false deploy=false npm_audit=false rust_audit=false

if [[ $mode == --all || ${GITHUB_REF:-} == refs/tags/* || ${GITHUB_EVENT_NAME:-} == schedule || ${GITHUB_EVENT_NAME:-} == workflow_dispatch ]]; then
  web=true backend=true quest=true deploy=true npm_audit=true rust_audit=true
elif [[ $mode == event ]]; then
  if [[ -n ${PR_BASE:-} && -n ${PR_HEAD:-} ]]; then
    range="$PR_BASE...$PR_HEAD"
  elif [[ -n ${BEFORE:-} && ! ${BEFORE} =~ ^0+$ ]]; then
    range="$BEFORE..${GITHUB_SHA:?}"
  else
    web=true backend=true quest=true deploy=true npm_audit=true rust_audit=true
  fi

  if [[ -n ${range:-} ]]; then
    changed=$(mktemp)
    trap 'rm -f "$changed"' EXIT
    if git diff --name-only -z "$range" > "$changed"; then
      exec 3< "$changed"
    else
      echo 'Could not compare commits; running every check' >&2
      web=true backend=true quest=true deploy=true npm_audit=true rust_audit=true
    fi
  fi
else
  exec 3<&0
fi

if [[ $web == false && $backend == false && $quest == false && $deploy == false && $npm_audit == false && $rust_audit == false ]]; then
  while IFS= read -r -d '' -u 3 path; do
    case "$path" in
      .github/workflows/check.yml|scripts/changes.sh)
        web=true backend=true quest=true deploy=true npm_audit=true rust_audit=true ;;
      .github/workflows/security.yml)
        npm_audit=true rust_audit=true ;;
      package.json|package-lock.json|frontend/package.json|frontend/*/package.json|quest/prototype-server/package.json)
        web=true npm_audit=true ;;
      backend/Cargo.toml|backend/Cargo.lock)
        backend=true rust_audit=true ;;
      backend/Dockerfile)
        backend=true deploy=true ;;
      frontend/Dockerfile)
        web=true deploy=true ;;
      backend/*)
        backend=true ;;
      frontend/*|quest/prototype-server/*|quest/scripts/*|biome.json|biome.jsonc)
        web=true ;;
      quest/app/*)
        quest=true ;;
      .dockerignore|.gitignore|.env.example|compose.yaml|deploy/*|scripts/*|.github/workflows/release.yml)
        deploy=true ;;
    esac
  done
fi

printf 'web=%s\nbackend=%s\nquest=%s\ndeploy=%s\nnpm_audit=%s\nrust_audit=%s\n' \
  "$web" "$backend" "$quest" "$deploy" "$npm_audit" "$rust_audit"
