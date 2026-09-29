# QuestRelay

QuestRelay brings multiple Meta Quest screen and game-audio feeds into one browser lounge. Each wearer starts sharing from the Quest companion app, and viewers choose which feeds to watch and hear. The Rust backend uses mediasoup for WebRTC forwarding

The current hardware check has confirmed that a Quest publishes rising H.264 video and Opus audio packet counts to the relay, and a local browser rendered real Quest video at 1280 × 720 and 30 fps while receiving an Opus track. Audible game-audio quality and sync, internet NAT traversal, end-to-end latency, release-channel installation without Developer Mode, and multi-headset capacity still need live validation. There is no measured zero-latency claim

## What is where

| Path | Purpose |
|---|---|
| `frontend/` | Public lounge at `/livestream/<id>` and separate `/admin` control room |
| `backend/` | Rust signalling, access control, room settings and mediasoup relay |
| `quest-mod/app/` | Native Quest companion app for consented video and device audio capture |
| `quest-mod/prototype-server/` | Archived ADB/scrcpy prototype, outside the current media path |

The public page supports multiple feed tiles, per-feed audio, a focused view and optional viewer stats. Each Quest also gets a separate `/livestream/<id>` room when it first connects. The gear on public and admin pages holds personal appearance settings; signed-in admins can also edit each room's defaults, access and capybara there. The admin page shows room links, a per-headset diagnostic row and a 15-minute availability graph. The Quest app has Live, Settings and Stats views. The stats label transport and packet measurements clearly; glass-to-glass delay has not been measured

## Deploy on one Linux server with Docker Compose

You need a public DNS name pointed at the server, Docker with Compose, and inbound TCP 80/443 plus UDP and TCP 44444. The Quest app uses `wss://` for release builds; Caddy obtains and renews the HTTPS certificate when the name resolves publicly. UDP 443 is optional for HTTP/3

1. Copy `.env.example` to `.env` and set `QUESTRELAY_DOMAIN` and `QUESTRELAY_RTC_ANNOUNCED_ADDRESS` to the public DNS name
2. Run `openssl rand -hex 32` three times and put the distinct results in `QUESTRELAY_PUBLISH_KEY`, `QUESTRELAY_VIEW_KEY` and `QUESTRELAY_ADMIN_KEY` in `.env`
3. Start the stack and check its health

```bash
docker compose up -d --build
docker compose ps
curl https://your-domain.example/health
```

Open `https://your-domain.example/admin` and sign in with the admin key. Use the gear to set lounge defaults, including its name, theme and either public link access or a private access code. The Rooms section lists each headset's own short link after it has connected; the same gear lets you customise that room independently. Viewers can also use the gear to choose a personal theme without changing room defaults. On each Quest, use `wss://your-domain.example/ws/relay` and the publisher key in Settings, then press Start sharing and accept the screen and audio prompts

The relay state and Caddy certificates live in named Docker volumes. Back up the `relay_data` volume before moving servers because it holds the room URL and access settings. Keep `.env` private. The media path needs port 44444 reachable directly from both headsets and viewers; the HTTPS proxy does not relay WebRTC media. TURN fallback is not integrated, so restrictive networks may fail even when the page loads

The Compose file has been syntax-checked locally. A full container build and internet deployment have not been run on this Mac because its Docker daemon is unavailable

## Run without Docker

Build the web app and Rust server on a Linux host with Node.js 22+, Rust, a C++ toolchain, Python 3 with pip, and the [mediasoup worker build requirements](https://mediasoup.org/documentation/v3/mediasoup/installation/)

```bash
npm ci
npm run build -w @questrelay/shared
npm run build -w @questrelay/web
cargo build --manifest-path backend/Cargo.toml --release --locked
```

Load the three distinct keys from a private environment file or service manager. Set `QUESTRELAY_SIGNAL_HOST=127.0.0.1`, `QUESTRELAY_RTC_LISTEN_IP=0.0.0.0`, `QUESTRELAY_RTC_ANNOUNCED_ADDRESS` to the public DNS name, and `QUESTRELAY_STATE_PATH` to a writable persistent path, then run `backend/target/release/questrelay-backend` under your service manager

Serve `frontend/dist` with Caddy using `deploy/Caddyfile`, `QUESTRELAY_DOMAIN` set to the DNS name and `QUESTRELAY_UPSTREAM=127.0.0.1:8788`. Open the same ports as the Compose deployment. Run the backend as a dedicated unprivileged account and give it write access only to its state directory

## Local development with a Quest

Use separate, random keys of at least 32 characters for publisher, viewer and admin roles. Start the Rust backend on its default local ports and Vite in another terminal

```bash
npm ci
export QUESTRELAY_PUBLISH_KEY="$(openssl rand -hex 32)"
export QUESTRELAY_VIEW_KEY="$(openssl rand -hex 32)"
export QUESTRELAY_ADMIN_KEY="$(openssl rand -hex 32)"
cargo run --manifest-path backend/Cargo.toml
```

In another terminal:

```bash
npm run dev:web
```

Build the Quest debug APK with JDK 17+, Gradle and Android SDK platform 35. Developer Mode and ADB are for development testing only

```bash
cd quest-mod/app
gradle :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:8788 tcp:8788
```

In this debug setup, use `ws://127.0.0.1:8788/ws/relay` in the Quest app. The release build accepts only secure `wss://` relay URLs. The app encrypts the saved publisher key with Android Keystore, keeps capture behind per-session system consent, and stops sharing from its notification or when the headset sleeps

A release APK still needs signing and a supported Meta distribution channel. ADB installation is not evidence that installation works with Developer Mode disabled. [Meta release channels](https://developers.meta.com/horizon/resources/publish-release-channels/) and [app review](https://developers.meta.com/horizon/resources/publish-app-review/) are the remaining distribution path

## Latency and diagnostics

QuestRelay forwards encoded H.264 and Opus through mediasoup, with no server-side decode or composite. The current Quest ingest leg uses authenticated WebSocket over TCP, which can delay newer media behind lost packets. WebRTC/SRTP ingest or a suitable transport change may be needed if end-to-end tests miss the target

The engineering targets remain p95 at or below 150 ms on an uncongested LAN and 300 ms over a nearby internet relay, with audio/video alignment within 50 ms. These are targets, not results. To substantiate them, measure capture-to-display with a shared visual clock and test multiple simultaneous Quest publishers, increasing viewer counts, packet loss and TURN-restricted networks

Admin control RTT is WebSocket ping round trip, not capture-to-display delay. Packet bitrate is a recent relay sample; the availability graph samples every five seconds and resets when the server restarts. The Quest Stats view shows video/audio packets and bitrate, queue bytes, reconnects, sample age and capture profile, and copies diagnostics without the publisher key

## Checks

```bash
npm run test -w @questrelay/web
npm run build -w @questrelay/web
cargo test --manifest-path backend/Cargo.toml --locked
cargo clippy --manifest-path backend/Cargo.toml --locked -- -D warnings
```

The previous ADB prototype remains in `quest-mod/prototype-server/` for comparison, but it does not serve the current app or public page
