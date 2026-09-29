# QuestRelay

QuestRelay puts a Meta Quest's screen and game audio in a browser room. The wearer opens the companion app and approves capture; everyone else joins with a link. One room can show several headsets, and each headset gets its own short link when you only want to share that feed

The viewer can pin, focus and mute feeds, choose a layout and theme, and open Stats for nerds. The separate control room lets admins manage room access, appearance, passkeys, headset media controls and diagnostics

> [!IMPORTANT]
> **What we have actually tested:** one Quest sent H.264 video and Opus audio to the Rust relay. A local browser showed 1280 × 720 video at 30 fps and received an audio track. Audible game audio, sync, multiple headsets, internet NAT traversal, normal release-channel installation and end-to-end latency still need live testing. “Zero latency” is not a physical or measured claim

| If you want to… | Go to… |
| --- | --- |
| Understand the media path and trust boundaries | [Architecture](ARCHITECTURE.md) |
| Run a local web and relay build | [Develop locally](#develop-locally) |
| Put the server on a Linux VM | [Deploy](#deploy) |
| Help with the project | [Contributing](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md) |

## Develop locally

You need Node.js 22+, Rust with the [mediasoup build prerequisites](https://mediasoup.org/documentation/v3/mediasoup/installation/), and three different keys of at least 32 characters. Start the relay in one terminal:

```bash
npm ci
export QUESTRELAY_PUBLISH_KEY="$(openssl rand -hex 32)"
export QUESTRELAY_VIEW_KEY="$(openssl rand -hex 32)"
export QUESTRELAY_ADMIN_KEY="$(openssl rand -hex 32)"
cargo run --manifest-path backend/Cargo.toml
```

Start the web app in another terminal:

```bash
npm run dev:web
```

Open the address printed by Vite. The browser requests `/api/*` and `/ws/*` through its local proxy to the Rust relay. Sign in at `/admin` with the admin key from the first terminal. You can make a room public by link or give it a private access code; new rooms start private

<details>
<summary>Build the Quest app for a USB development test</summary>

Use JDK 17, Gradle 9.6, Android SDK platform 35 and ADB:

```bash
cd quest/app
gradle :app:testDebugUnitTest :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:8788 tcp:8788
```

In the debug app, set the relay URL to `ws://127.0.0.1:8788/ws/relay` and enter the publisher key. Start sharing and accept the headset's screen and audio prompts. Developer Mode and ADB are only part of this development path; a normal install needs a signed build through a supported [Meta release channel](https://developers.meta.com/horizon/resources/publish-release-channels/)

</details>

## Deploy

QuestRelay needs a long-running Linux server with a public IP. An [OCI Always Free A1 VM](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) can be a starting point, subject to regional capacity and its free-tier limits. It is one bounded server, so test real headset and viewer load before increasing the limits in `.env`

1. Choose a VM close to your viewers, point a DNS name to its public IP, and [install Docker Engine with Compose](https://docs.docker.com/engine/install/ubuntu/)
2. In the cloud network rules and host firewall, allow TCP 80 and 443 plus UDP/TCP 44444. Restrict SSH to your own IP. WebRTC media goes directly to 44444; the HTTPS proxy alone cannot carry it
3. Copy `.env.example` to `.env`, replace both sample domain values, and generate **different** publisher, viewer and admin keys with `openssl rand -hex 32`
4. Commit the source to release, then package and deploy it:

```bash
archive=$(scripts/distribute.sh)
scripts/deploy.sh ubuntu@PUBLIC_IP "$archive" .env
curl https://your-domain.example/health
```

The deployment script copies `.env` on the first run; omit that argument later to keep the server's keys. It builds on the VM, waits for relay health, and keeps earlier release directories. The fixed Compose project name preserves the `relay_data` and Caddy certificate volumes. Back up `relay_data` before moving servers

Then open `https://your-domain.example/admin`. Set the main room's access and theme, and copy the publisher key to each Quest. In the headset app, use `wss://your-domain.example/ws/relay`, start sharing and approve capture

<details>
<summary>Run from a checkout without the deploy script</summary>

With a valid `.env`, run `docker compose up -d --build --wait` on the Linux host. For a non-Docker install, build the web app with Node.js and the relay with Rust, serve `frontend/dist` through `deploy/Caddyfile`, and keep the relay under an unprivileged account with a writable state directory

</details>

## What the system does and does not measure

The Rust service forwards encoded video and audio through mediasoup without decoding or compositing them. The Quest sends its RTP packets over authenticated WSS/TCP; a lost TCP packet can delay newer media. Browser playback uses WebRTC with direct UDP when available and TCP fallback. TURN is not integrated, so restrictive networks may show the page but fail to play media

The current engineering targets are p95 capture-to-display delay at or below **150 ms on an uncongested LAN** and **300 ms through a nearby internet relay**, with audio and video within 50 ms. They are targets, not results. Admin control RTT and browser network RTT are useful diagnostics, but neither measures glass-to-glass delay. [Architecture](ARCHITECTURE.md#latency-and-scale) explains the bottlenecks and test plan

Pushes and pull requests run checks for the code they change; release tags run the full set. The [security workflow](.github/workflows/security.yml) checks dependency changes and runs weekly. A `v*` tag publishes a server archive and checksum, **not** a signed Quest APK. [Dependabot](.github/dependabot.yml) groups routine dependency updates

## Project and rights

The active pieces are in [frontend](frontend/), [backend](backend/) and [quest/app](quest/app/). The old ADB/scrcpy experiment remains in [quest/prototype-server](quest/prototype-server/) for reference and is outside the live media path

Read the [security policy](SECURITY.md) before reporting a vulnerability or leaked key. Original QuestRelay material uses a [custom modified MIT-style licence](LICENSE), which requires separate permission for commercial use and AI training. The archived [streamer-tools component](quest/streamer-tools/) keeps its own licence
