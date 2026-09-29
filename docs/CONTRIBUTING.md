# Contributing to QuestRelay

Thanks for helping make QuestRelay easier to watch, run or debug. Please follow our [Code of Conduct](CODE_OF_CONDUCT.md) in issues, pull requests and other project spaces

## Find your way around

The [README](../README.md#get-it-running-locally) gets the relay and web app running. If you need to change how a feed travels from a Quest to a browser, read the [architecture guide](ARCHITECTURE.md) first. The web UI lives in `frontend/src`, the Rust service in `backend/src`, and the headset app in `quest/app`. Deployment files live in `tools/config` and `tools/scripts`

## Make a change

1. Pick an open issue, or open one describing the result you want before starting a larger change
2. Create a branch with a clear name, such as `fix-camera-tracking`
3. Keep the diff focused and leave generated builds, local state and secrets out of it
4. Check the path you touched, then open a pull request linked to the issue with a short explanation of the change and the checks you ran

You should be able to explain and maintain what you submit, including code written with AI assistance. If you're blocked, ask in the project channel before adding a workaround you don't trust

## Build and test

After `npm ci`, these commands cover the web and Rust code from the repository root:

```bash
npm test
npm run build
```

For a Quest app change, use JDK 17, Gradle 9.6 and Android SDK platform 35:

```bash
gradle -p quest/app :app:testDebugUnitTest :app:assembleDebug --no-daemon
```

For release or deployment script changes, run `shellcheck tools/scripts/*.sh`, `bash tools/scripts/changes.test.sh` and `docker compose -f tools/config/compose.yaml --project-directory . config --quiet` after preparing `.env` as shown in the [deployment guide](DEPLOY.md). GitHub Actions runs the checks relevant to the files changed in each pull request
