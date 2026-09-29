# QuestRelay

**Meta Quest livestreams you can watch together in a browser**

QuestRelay is a self-hosted Meta Quest livestreaming system for sharing headset video and supported game audio in a browser. The wearer starts sharing in the companion app and approves capture; viewers open a link. Put several headsets in one room for a playtest or demo, or share a short `/livestream/<id>` link for one feed

The browser lets each viewer pin a feed, change the layout, mute audio and choose a theme. Admins get a separate control room for public or private access, passkeys, headset video and audio controls, and the connection stats that help when a stream goes wrong. The room's animated capybara has a name, mood and accessory you can customise

Under the hood, a Rust relay forwards H.264 video and Opus audio to WebRTC viewers without recomposing the feeds. The design aims to keep delay low; [measured latency and multi-headset capacity are still open work](#current-status)

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

With JDK 17, Gradle 9.6, Android SDK platform 35 and ADB installed, run this from the repository root:

```bash
gradle -p quest/app :app:testDebugUnitTest :app:assembleDebug
adb install -r quest/app/app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:8788 tcp:8788
```

In the debug app, set the relay URL to `ws://127.0.0.1:8788/ws/relay` and enter the publisher key printed earlier. Start sharing and approve the Quest's capture prompts. A normal user install will need a signed app distributed through a supported [Meta release channel](https://developers.meta.com/horizon/resources/publish-release-channels/); the USB route is for development

</details>

## Where to work

| If you're changing… | Start here |
| --- | --- |
| The public room or admin experience | [`frontend/src`](frontend/src/) |
| Room access, signalling or media forwarding | [`backend/src`](backend/src/) |
| Headset capture or app settings | [`quest/app`](quest/app/) |
| Deployment and release tooling | [`tools/config`](tools/config/) and [`tools/scripts`](tools/scripts/) |

The older ADB/scrcpy experiment lives in [`quest/prototype-server`](quest/prototype-server/) and is outside the current media path. [How QuestRelay works](docs/ARCHITECTURE.md) follows a feed from the headset to the browser and explains the trust boundaries

## Build and check

Run `npm run build` for the web app and Rust relay, or `npm test` for the shared, web, prototype and Rust tests. The Quest app has its own Gradle build in the expandable setup above. For a pull request, see the focused checks in the [contribution guide](docs/CONTRIBUTING.md)

## Put it on a server

QuestRelay needs a Linux host with a public address, HTTPS and a direct WebRTC media port. The [deployment guide](docs/DEPLOY.md) covers Docker Compose, DNS and firewall rules, keys, updates and backups. It also explains the current limits of a single relay and why some networks need a TURN service

## Current status

One Quest has sent 1280 × 720 video at 30 fps and an Opus audio track through the Rust relay to a local browser. Audible game audio, sync, several headsets at once, internet NAT traversal, normal release-channel installation and glass-to-glass latency still need live testing. The latency numbers in the architecture notes are targets, not measured results; “zero latency” is not a promise

QuestRelay is maintained by UQ Reality Labs. Before contributing, read the [contribution guide](docs/CONTRIBUTING.md), [Code of Conduct](docs/CODE_OF_CONDUCT.md) and [security policy](docs/SECURITY.md). The project uses a [custom modified MIT-style licence](LICENSE), not standard MIT; commercial use and AI training require separate permission
