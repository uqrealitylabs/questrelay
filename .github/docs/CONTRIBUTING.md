# Contributing to QuestRelay

Thanks for helping make QuestRelay easier to watch, run or debug. Please follow our [Code of Conduct](CODE_OF_CONDUCT.md) in issues, pull requests and other project spaces

## Find your way around

The [README](../../README.md#get-it-running-locally) gets the relay and web app running. If you need to change how a feed travels from a Quest to a browser, read the [architecture guide](../../docs/ARCHITECTURE.md) first. The web UI lives in `frontend/src`, the single-host Rust service in `backend/src`, the Cloudflare Worker in `backend/edge`, and the headset app in `quest/app`. The headset's WebRTC transport lives in `quest/transport`. Deployment files live in `tools/config` and `tools/scripts`

## Make a change

1. Pick an open issue, or open one describing the result you want before starting a larger change
2. Create a branch with a clear name, such as `fix-camera-tracking`
3. Keep the diff focused and leave generated builds, local state and secrets out of it
4. Check the path you touched, then open a pull request linked to the issue with a short explanation of the change and the checks you ran

You should be able to explain and maintain what you submit, including code written with AI assistance. If you're blocked, ask in the project channel before adding a workaround you don't trust

## Build and test

After `npm ci`, these commands cover the web app from the repository root:

```bash
npm test
npm run build
```

For the Cloudflare Worker and headset transport, run:

```bash
cargo test --manifest-path backend/edge/Cargo.toml --locked
cargo clippy --manifest-path backend/edge/Cargo.toml --locked --target wasm32-unknown-unknown -- -D warnings
cd quest/transport && go test ./...
```

For a Quest app change, use JDK 17, Go 1.26, Gradle 9.6, Android SDK platform 35 and NDK `27.2.12479018`. Build the transport AAR before the APK:

```bash
bash tools/scripts/build-transport.sh
gradle -p quest/app :app:testDebugUnitTest :app:assembleDebug --no-daemon
```

For release or deployment script changes, run `shellcheck tools/scripts/*.sh` and `docker compose -f tools/config/compose.yaml --project-directory . config --quiet` after preparing `.env` as shown in the [local deployment guide](../../docs/LOCAL.md). GitHub Actions runs every project check for each pull request
