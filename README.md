# QuestRelay

QuestRelay lets people watch several Meta Quest headsets in one room, with each headset's screen and game audio on its own tile. The wearer starts sharing in the Quest app; viewers open a room link in a browser. Admins can manage rooms, access, appearance and headset diagnostics from a separate control room

The hardware test so far used one Quest. It sent H.264 video and Opus audio to the Rust relay, and a local browser displayed the video at 1280 × 720 and 30 fps while receiving an audio track. Audible game-audio quality, sync, internet NAT traversal, multiple headsets, release-channel installation and end-to-end latency still need live testing. **Zero latency is not a measured or physically achievable claim**

## Where things live

| Path | Purpose |
| --- | --- |
| `frontend/` | Public lounge at `/livestream/<id>` and the separate `/admin` page |
| `backend/` | Rust signalling, room access, diagnostics and mediasoup forwarding |
| `quest/app/` | Quest companion app for consented screen and device-audio capture |
| `quest/prototype-server/` | Archived ADB/scrcpy experiment, outside the live media path |

The public lounge has feed tiles, per-feed audio, a focused view, layouts and optional viewer stats. Each connected headset also gets a short room link. Viewers can choose a personal theme from the gear button; admins use the same gear to set room defaults and can see per-headset diagnostics and an availability graph in the control room

## Put it on a Linux server

The relay needs a long-running host with a public IP and direct UDP. An [OCI Always Free A1 VM](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) is one possible starting point: its current free allowance is 2 OCPUs, 12 GB memory and 10 TB outbound transfer per month, subject to home-region capacity and idle-instance reclamation. It is a bounded single server, so measure how many feeds and viewers it can carry before raising the configured limits

Choose a VM near the people using it, point a DNS name at its public IP, and [install Docker Engine with the Compose plugin](https://docs.docker.com/engine/install/ubuntu/). In both the OCI network rules and the VM firewall, allow TCP 80/443 and UDP/TCP 44444 from the internet; restrict SSH to your own IP. Caddy handles HTTPS for the site and signalling. WebRTC media uses port 44444 directly, so an HTTPS proxy alone will not carry the streams. UDP 443 is optional for HTTP/3

Copy `.env.example` to `.env`, replace the sample domain in both domain fields, and generate **three different** publisher, viewer and admin keys with `openssl rand -hex 32`. Keep `.env` private. After committing the source you want to release, run:

```bash
archive=$(scripts/distribute.sh)
scripts/deploy.sh ubuntu@PUBLIC_IP "$archive" .env
curl https://your-domain.example/health
```

The third argument copies `.env` to `~/questrelay/.env` on the VM. Omit it on later deployments to keep the server's existing keys. `deploy.sh` builds on the VM's architecture, waits for relay health and retains earlier release directories. The Compose project name stays fixed, so room state and Caddy certificates remain in their named volumes. Back up the `relay_data` volume before moving servers or changing storage

Open `https://your-domain.example/admin` and sign in with the admin key. In room settings, choose public link access or a private code, set a theme and customise the capybara. On each Quest, enter `wss://your-domain.example/ws/relay` and the publisher key in Settings, then start sharing and accept the screen and audio prompts

For a direct checkout on a Linux host, `scripts/deploy.sh` is optional: create `.env` and run `docker compose up -d --build --wait`. If you run without Docker, build the web app with Node.js 22+ and the backend with Rust and the [mediasoup worker prerequisites](https://mediasoup.org/documentation/v3/mediasoup/installation/), then serve `frontend/dist` with `deploy/Caddyfile`. Keep the backend under an unprivileged service account with a writable state directory

## Release and Quest app

Pull requests and pushes to `main` run web, Rust and Quest checks. A `v*` tag runs those checks again and publishes a server archive and checksum through `release.yml`. The security workflow audits npm and Rust dependencies weekly and on changes; Dependabot proposes dependency updates

The release archive contains server source and deployment files, **not** `.env` or a signed Quest APK. A Quest release still needs a signing key, review and a supported [Meta release channel](https://developers.meta.com/horizon/resources/publish-release-channels/). ADB installation only tests development builds; it does not prove installation with Developer Mode disabled

## Work locally

Set three distinct keys of at least 32 characters, then start the backend and web app in separate terminals:

```bash
npm ci
export QUESTRELAY_PUBLISH_KEY="$(openssl rand -hex 32)"
export QUESTRELAY_VIEW_KEY="$(openssl rand -hex 32)"
export QUESTRELAY_ADMIN_KEY="$(openssl rand -hex 32)"
cargo run --manifest-path backend/Cargo.toml
```

```bash
npm run dev:web
```

For a Quest debug build, use JDK 17, Gradle 9.6, Android SDK platform 35 and ADB. Developer Mode and USB debugging are only needed for this development path:

```bash
cd quest/app
gradle :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:8788 tcp:8788
```

In that debug setup, enter `ws://127.0.0.1:8788/ws/relay` in the app. Release builds accept secure `wss://` URLs. The app stores its publisher key with Android Keystore, asks for capture consent for each session and stops sharing from its notification or when the headset sleeps

## Latency and limits

The relay forwards encoded H.264 and Opus without decoding or compositing. Quest ingest currently uses an authenticated WebSocket over TCP, so lost packets can hold newer media back. TURN fallback is not integrated; restrictive networks may load the page but fail to receive media. The current targets are p95 capture-to-display delay at or below 150 ms on an uncongested LAN and 300 ms through a nearby internet relay, with audio and video within 50 ms. These are engineering targets, **not test results**

To check them properly, measure capture-to-display with a shared visual clock, then repeat with several publishing Quests, more viewers, packet loss and restrictive networks. Admin control RTT is only WebSocket ping round trip. The availability graph samples every five seconds and resets when the server restarts; the Quest Stats view shows packet counts, bitrate, queue bytes, reconnects, capture profile and sample age without copying the publisher key

## Contributing and safety

Read the [contribution guide](CONTRIBUTING.md) and [Code of Conduct](CODE_OF_CONDUCT.md) before opening a pull request. Report vulnerabilities and leaked credentials through the [security policy](SECURITY.md). Original QuestRelay material uses a [custom modified MIT-style licence](LICENSE) that requires separate permission for commercial use and AI training; `quest/streamer-tools/` keeps its own licence
