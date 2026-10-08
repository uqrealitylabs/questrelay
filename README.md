# QuestRelay

**Meta Quest livestreams you can watch together in a browser**

QuestRelay shares Meta Quest video and supported game audio in a browser. The wearer starts sharing in the companion app and approves capture; viewers open a link. Put several headsets in one room for a playtest or demo, or share a short `/livestream/<id>` link for one feed

The browser lets each viewer pin a feed, change the layout, mute audio and choose a theme. Admins get a separate control room for public or private access, headset video and audio controls, and the connection stats that help when a stream goes wrong. The room's animated capybara has a name, mood and accessory you can customise

The Cloudflare path uses a Rust Worker and Cloudflare Realtime SFU to forward H.264 and Opus over WebRTC. A single-host Rust relay remains available for local and Docker deployments. Both paths aim to keep delay low; [measured latency and multi-headset capacity are still open work](#current-status)

## Host on Cloudflare

The [Cloudflare guide](docs/CLOUDFLARE.md) walks through the free-tier setup, secrets, deployment and Quest APK. The hosted site is [questrelay.iamkeys-1111.workers.dev](https://questrelay.iamkeys-1111.workers.dev). Run `tools/scripts/deploy.sh cloudflare` for later updates

The free Realtime allowance is 1,000 GB of combined SFU and TURN egress per month, not a hard usage cap. Check usage in Cloudflare during tests

## Get it running locally

You need Node.js 22+, Rust and the [mediasoup build prerequisites](https://mediasoup.org/documentation/v3/mediasoup/installation/). Clone the repository and install the web dependencies:

```bash
git clone https://github.com/uqrealitylabs/questrelay.git
cd questrelay
npm ci
```

In your first terminal, make three different local keys and start the relay:

```bash
export QUESTRELAY_PUBLISH_KEY="$(openssl rand -hex 32)"
export QUESTRELAY_VIEW_KEY="$(openssl rand -hex 32)"
export QUESTRELAY_ADMIN_KEY="$(openssl rand -hex 32)"
printf 'Admin key: %s\nPublisher key: %s\n' "$QUESTRELAY_ADMIN_KEY" "$QUESTRELAY_PUBLISH_KEY"
npm run dev:server
```

Keep those printed keys private. In a second terminal, run `npm run dev:web` and open the address Vite prints. Sign in at `/admin` with the admin key, then make the room public by link or set a private access code. New rooms start private

<details>
<summary>Connect a Quest for a USB development test</summary>

With JDK 17, Go 1.26, Gradle 9.6, Android SDK platform 35, NDK `27.2.12479018` and ADB installed, set `ANDROID_HOME` and `ANDROID_NDK_HOME`, then run this from the repository root:

```bash
tools/scripts/deploy.sh adb devices
tools/scripts/deploy.sh adb send YOUR_ADB_ID
adb -s YOUR_ADB_ID reverse tcp:8788 tcp:8788
```

Repeat `adb send` with each Quest's ADB ID. In each debug app, set the relay URL to `ws://127.0.0.1:8788/ws/relay` and enter the publisher key printed earlier. Give each headset a distinct name, start sharing and approve the Quest's capture prompts. A normal user install will need a signed app distributed through a supported [Meta release channel](https://developers.meta.com/horizon/resources/publish-release-channels/); the USB route is for development

</details>

## Where to work

| If you're changing… | Start here |
| --- | --- |
| The public room or admin experience | [`frontend/src`](frontend/src/) |
| Cloudflare room access and signalling | [`backend/edge`](backend/edge/) |
| Single-host relay and local WebRTC | [`backend/src`](backend/src/) |
| Headset capture, app settings or Cloudflare transport | [`quest/app`](quest/app/) and [`quest/transport`](quest/transport/) |
| Deployment and release tooling | [`tools/config`](tools/config/) and [`tools/scripts`](tools/scripts/) |

The older ADB/scrcpy experiment lives in [`quest/prototype-server`](quest/prototype-server/) and is outside the current media path. [How QuestRelay works](docs/ARCHITECTURE.md) follows a feed from the headset to the browser and explains the trust boundaries

## Build and check

Run `npm run build` for the web app and single-host Rust relay, or `npm test` for their checks. The Cloudflare Worker has separate `cargo test --manifest-path backend/edge/Cargo.toml` and Wasm Clippy checks. The Quest transport runs `go test ./...` in `quest/transport`; its APK build is in the expandable setup above and the [Cloudflare guide](docs/CLOUDFLARE.md). For a pull request, see the focused checks in the [contribution guide](docs/CONTRIBUTING.md)

## Put it on a server

Use [Cloudflare](docs/CLOUDFLARE.md) for the hosted test without a VM. The [single-host guide](docs/DEPLOY.md) covers Docker Compose, DNS, firewall rules and backups when you want to operate your own relay

## Current status

Two Quest 3 headsets have connected individually to the deployed Cloudflare relay. Safari received H.264 video and an Opus audio track from the first. In Beat Saber, a 60 fps capture target produced about 29–30 encoded fps at both 1080p and 720p, even while the game renderer reported 90 fps. The 720p profile used less bandwidth and one receiver sample showed 0% recent video loss. Stable 60 fps, zero packet loss, audible game audio, simultaneous headset capacity, release-channel installation and glass-to-glass latency have not been verified. The Cloudflare control room currently uses an admin key because passkeys and multi-admin management have not yet been ported from the single-host backend

QuestRelay is maintained by UQ Reality Labs. Before contributing, read the [contribution guide](docs/CONTRIBUTING.md), [Code of Conduct](docs/CODE_OF_CONDUCT.md) and [security policy](docs/SECURITY.md). The project uses a [custom modified MIT-style licence](LICENSE), not standard MIT; commercial use and AI training require separate permission

The [release history](docs/CHANGELOG.md) and [GitHub releases](https://github.com/uqrealitylabs/questrelay/releases) show what changed in each version and which builds you can download
