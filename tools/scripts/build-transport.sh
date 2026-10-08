#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
: "${ANDROID_HOME:=${ANDROID_SDK_ROOT:-}}"
: "${ANDROID_NDK_HOME:?Set ANDROID_NDK_HOME to the installed Android NDK}"
if [[ ! -d "$ANDROID_HOME" || ! -d "$ANDROID_NDK_HOME" ]]; then
  echo 'Android SDK or NDK directory is missing' >&2
  exit 1
fi

export ANDROID_HOME ANDROID_NDK_HOME
quest_go_path=$(go env GOPATH)
export PATH="$quest_go_path/bin:$PATH"
cd "$root/quest/transport"
go install golang.org/x/mobile/cmd/gomobile
go install golang.org/x/mobile/cmd/gobind
mkdir -p "$root/quest/app/app/libs"
gomobile bind -target android/arm64 -androidapi 32 -ldflags=-checklinkname=0 \
  -o "$root/quest/app/app/libs/transport.aar" .
