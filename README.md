# QuestRelay

**Live video and audio from multiple Meta Quest headsets, together in one browser**

QuestRelay's target scope is simultaneous viewing of N headset feeds with synchronised device audio, over local networks and the internet, without requiring headset owners to enable Developer Mode

**Current status:** the active backend is Rust and can authenticate multiple publishers and viewers, then coordinate H.264 video and Opus audio through mediasoup; the Quest companion app and browser WebRTC player are not connected yet, while the older two-feed ADB prototype is kept separately

## Product scope

- Support N simultaneous headset feeds, with deployment capacity determined by measured network bandwidth, relay throughput and viewer decoding limits
- Replace the fixed two-feed product limit with configurable capacity and clear admission errors when a deployment is full
- Provide a responsive feed grid and a focused view, with per-feed mute and volume controls; start playback muted and let the viewer choose which feed to hear
- Capture device/game audio alongside video; microphone capture is a separate permission and product decision
- Let the wearer explicitly start, approve and stop sharing without ADB pairing, USB debugging or Developer Mode in the end-user workflow
- Recover from disconnects and explain permission denial, capture interruption and unsupported content
- Support local and internet viewers through private sessions, with authenticated operators, expiring viewer access and revocation
- Use a QuestRelay companion app on each headset to publish consented video and device audio

## Latency requirements

Design for the lowest practical capture-to-display delay; literal zero latency is impossible and must not be used as a performance claim

Initial engineering targets, pending the first hardware measurements:

| Measure | Target and conditions |
|---|---|
| Local video delay | p95 at or below 150 ms with a local relay and an uncongested network |
| Internet video delay | p95 at or below 300 ms with a nearby relay and measured publisher-to-relay and viewer-to-relay RTT each at or below 50 ms |
| Audio/video alignment | Absolute offset at or below 50 ms during steady playback |
| Local control feedback | Visible response within 100 ms, independently of network completion |

These are proposed test budgets, not measured results or guarantees; publish the supported feed count, resolution, frame rate, hardware and network conditions alongside every result

- Use hardware encoding where supported and forward encoded tracks through an SFU without server-side decoding, compositing or transcoding in the live path; [mediasoup documents this forwarding model](https://mediasoup.org/documentation/overview/)
- Keep application queues bounded and prevent stale video accumulating; preserve decoder dependencies and recover with keyframes where needed
- Adapt bitrate, resolution and subscriptions under congestion rather than growing playback delay; retain the jitter buffering needed for usable audio and video
- Offer a local relay for LAN sessions and a nearby relay for internet sessions; measure TURN fallback separately
- Prioritise the focused feed and explicitly selected audio; reduce or suspend hidden video subscriptions without silently muting selected audio
- Measure capture-to-display latency with a shared visual timing reference or calibrated clocks; report p50/p95, audio offset, packet loss, freezes and recovery at increasing feed counts
- Keep transport RTT distinct from end-to-end media delay in diagnostics; do not label an RTT reading as capture latency

## Interface direction

Use Discord voice-channel interaction patterns with QuestRelay's own visual identity: a compact channel list on the left, headset participants within the active channel, a central live-feed stage and persistent connection/audio/leave controls

The feed stage is the primary workspace; settings open in a collapsible panel and never displace the streams unnecessarily

- Support grid, focused-feed with filmstrip, and fullscreen layouts; preserve the viewer's pins and ordering when devices reconnect
- Show which headset is live, whose audio is selected, and whether a feed is reconnecting; keep detailed network statistics optional
- Use restrained dark and light themes, consistent spacing and clear type hierarchy; motion should explain state changes and respect reduced-motion settings
- Keep keyboard navigation, visible focus, accessible labels, contrast and non-colour status cues in every theme
- Collapse channel navigation and secondary settings on small screens while keeping audio and leave controls reachable

“Discord VC-like” defines the layout and interaction model; two-way microphone chat and push-to-talk are separate scope decisions, not implied implemented features

## Customisation

| Area | Viewer or operator controls |
|---|---|
| Layout | Grid density, tile size, drag ordering with keyboard alternatives, multiple pins, resizable panels and saved layout presets |
| Appearance | Dark/light/system theme, accent colour, interface density and text size with readable contrast |
| Audio | Per-feed mute and volume, solo, mute all and optional audio-follow-focus |
| Playback | Automatic quality by default, per-feed quality preference and latency-versus-smoothness presets within supported limits |
| Session | Operator-controlled channel/headset names, ordering, access and deployment capacity |
| Preferences | Saved personal settings, reset to defaults and validated preset import/export without credentials |

Personal viewing preferences must not change another viewer's mix or the headset's capture settings; shared session changes require operator authority

Provide useful defaults so joining a session needs no configuration; customisation must not add processing to every video frame or bypass safety and accessibility limits

## Companion app capture

The companion app is the chosen approach; the browser casting bridge is outside the delivery plan

Research checked on 29 September 2026; the complete app route has not yet been validated on real headsets in this project

`QuestRelay headset app → WebRTC relay → viewers`

[Meta's MediaProjection API](https://developers.meta.com/horizon/documentation/native/native-media-projection/) exposes headset video and device audio with user consent; the app uses MediaProjection plus AudioPlaybackCapture and publishes a separate video/audio feed for each headset

[Release channels](https://developers.meta.com/horizon/resources/publish-release-channels/) provide a testing distribution route, while [general distribution requires review](https://developers.meta.com/horizon/resources/publish-app-review/); prove installation and operation with Developer Mode disabled through the chosen channel, rather than relying on sideloading

- No receiver computer is required in the proposed media path; the headset needs network access to the relay
- Validate capture continuing while another immersive app runs, permissions, headset sleep, reconnects and resource cleanup
- Only one MediaProjection session can run per headset; another capture can end QuestRelay's session
- Some apps [block video capture](https://developers.meta.com/horizon/documentation/android-apps/features-overview/), and [source-app policy can block audio capture](https://developer.android.com/media/platform/av-capture)
- Validate headset encoding load, battery use and audio/video sync; this route offers more control but adds app development and distribution work

## Delivery sequence

1. Build and validate a single-headset capture app: supported installation with Developer Mode off, video and device audio from another running app, and cleanup when consent is revoked
2. Validate two headset publishers with independent audio controls, synchronised playback, interruption handling and reconnects
3. Connect publishers and viewers through an established WebRTC selective forwarding unit (SFU), with secure signalling, session-scoped access and TURN fallback; verify viewing from a separate internet connection
4. Build the channel-based viewing interface and saved customisation controls, verifying keyboard use, responsive layouts and preference persistence
5. Measure latency and audio/video alignment at increasing feed counts and publish the supported capacity for a stated headset, Wi-Fi, server and browser configuration

The first milestone is capture and distribution validation on real hardware; changing the existing stream-count constant alone cannot deliver this scope

## Target architecture

`QuestRelay companion app → WebRTC media relay → browser viewers`

Each publisher sends one headset video/audio feed to the relay; viewers subscribe to the feeds they need, with lower-quality tiles and a higher-quality focused feed where supported

The Rust backend uses [mediasoup-rust](https://mediasoup.org/documentation/v3/) to control its native C++ SFU worker; media packets bypass the Rust signalling path

- `frontend/` — feed grid, focused playback, audio controls and session management
- `backend/` — Rust authentication, publisher registration, WebRTC signalling and media relay coordination
- `quest-mod/` — future companion app and capture lifecycle, plus the archived ADB prototype

Keep Rust-based development tooling; use native Android APIs for headset capture and evaluate media dependencies on compatibility and measured behaviour

## Implemented audience interface

The audience page now has a channel sidebar, selectable stream tiles, focus and stop controls, plus browser-saved theme, accent and density preferences

Only selected feeds mount a player; the archived ADB source still provides video only, and the interface reports audio as unavailable and latency as unmeasured

## Rust backend

The Rust server accepts one H.264 video track and one Opus audio track per headset, gives each viewer its own receiving transport, and advertises feed changes over WebSocket

Install a Rust toolchain and the [native-worker build requirements](https://mediasoup.org/documentation/v3/mediasoup/installation/); the first build also needs Python Invoke for mediasoup's worker build

Set two distinct secrets of at least 32 bytes, then start the server:

```bash
export QUESTRELAY_PUBLISH_KEY="$(openssl rand -hex 32)"
export QUESTRELAY_VIEW_KEY="$(openssl rand -hex 32)"
cargo run --manifest-path backend/Cargo.toml
```

The defaults bind signalling to `127.0.0.1:8788` and WebRTC UDP/TCP to `127.0.0.1:44444`; `GET /health` reports whether the media worker is available and `/ws/relay` handles authenticated signalling

| Environment variable | Default | Purpose |
|---|---|---|
| `QUESTRELAY_SIGNAL_HOST` | `127.0.0.1` | Signalling bind IP |
| `QUESTRELAY_SIGNAL_PORT` | `8788` | HTTP/WebSocket port |
| `QUESTRELAY_RTC_LISTEN_IP` | `127.0.0.1` | Media bind IP |
| `QUESTRELAY_RTC_PORT` | `44444` | Media UDP and TCP port |
| `QUESTRELAY_RTC_ANNOUNCED_ADDRESS` | unset | Public or LAN address advertised to WebRTC clients, required for a wildcard media bind |
| `QUESTRELAY_MAX_HEADSETS` | `8` | Maximum simultaneous publishers |
| `QUESTRELAY_MAX_VIEWERS` | `64` | Maximum simultaneous viewers |

For a LAN test, set the signalling and media bind IPs to a reachable host address, or use `0.0.0.0` for media with `QUESTRELAY_RTC_ANNOUNCED_ADDRESS` set to the reachable address; open the media port for both UDP and TCP

For internet access, put signalling behind HTTPS/WSS and expose only the Rust service and the required media port, keeping the archived ADB service private; NAT traversal and TURN fallback have not been integrated or validated, so internet viewing is not yet reliable across networks

The WebSocket protocol uses JSON requests with a numeric `id` and a matching `{ id, ok, data }` response or `{ id, ok: false, error }`; the first request must be `join` within five seconds

| Action | Required fields | Result |
|---|---|---|
| `join` | `role` (`publisher` or `viewer`), `key`, and `headsetId` for publishers | Router RTP capabilities and current feeds |
| `listFeeds` | none | Current headset IDs and audio/video producer IDs |
| `createTransport` | `direction` (`send` for publisher, `recv` for viewer) | ICE and DTLS transport parameters |
| `connectTransport` | `transportId`, `dtlsParameters` | Connects the owned transport |
| `produce` | `transportId`, `kind`, `rtpParameters` | Publishes one audio or video track |
| `consume` | `transportId`, `producerId`, `rtpCapabilities` | Creates a paused consumer and returns its RTP parameters |
| `resumeConsumer`, `pauseConsumer`, `closeConsumer` | `consumerId` | Controls an owned subscription |
| `closeTransport` | `transportId` | Closes an owned transport and its tracks |

The server also sends `{ "event": "feeds", "feeds": [...] }` when a headset publishes, unpublishes or disconnects; viewers should close subscriptions whose producer IDs disappear and create their local consumer before sending `resumeConsumer`

Shared role keys are a first integration step, not session-scoped access or revocation; the server is not ready for an untrusted internet deployment, and no end-to-end headset latency has been measured

## Archived ADB prototype

| Path | Role |
|------|------|
| `frontend` | Vite + React — audience `/`, operator `/operator` |
| `quest-mod/prototype-server` | Optional Node service — ADB, discovery, scrcpy-server, WebSocket H.264 fan-out |
| `frontend/shared` | Frontend types and Quest 3 defaults |
| `quest-mod/prototype-server/data/devices.json` | Saved device favourites / settings (created at runtime) |
| `quest-mod/vendor/scrcpy-server` | Genymobile scrcpy-server binary (downloaded) |

Video path: **ADB → scrcpy-server → Node → WebSocket → WebCodecs** (view-only, no audio in v1).

## Current prototype setup

1. Install [Node.js 22+](https://nodejs.org/) and [Android platform-tools](https://developer.android.com/tools/releases/platform-tools) (`adb` on your `PATH`)
2. On each Quest, enable **Developer Mode** for this archived ADB path only
3. In this repo:

```bash
npm install
npm run download:scrcpy
```

## Run (development)

Terminal A — archived ADB API / streams (listens on all interfaces for LAN viewers):

```bash
npm run dev:prototype
```

Terminal B — Vite UI (proxies `/api` and `/ws`):

```bash
npm run dev:web
```

- Audience: `http://localhost:5173/`
- Operator: `http://localhost:5173/operator`
- LAN clients: use the host PC’s LAN IP with the same ports

## Built preview of the archived prototype on LAN

```bash
npm run build
npm run build -w @questrelay/prototype
npm run start -w @questrelay/prototype
```

Open `http://<host-lan-ip>:8787/` (audience) or `/operator`.

## Per-session headset bootstrap

After reboot, wireless ADB usually needs a kick:

1. **Wireless debugging (preferred):** on the Quest, enable Wireless debugging, note IP / pairing port / code. In **Operator**, use **Wireless debugging pair**, then **Manual connect** (or wait for scan) on the ADB port.
2. **USB fallback:** plug in USB, accept debugging, click **Enable wireless ADB** on the USB row — runs `adb tcpip 5555` and reads the WLAN IP.

When you **Start stream**, accept **“Allow USB debugging?”** on the headset if prompted (this is the accept step — not Meta cast).

## Operator features

- Hybrid device list (saved + subnet scan for ADB ports + `adb devices`)
- Start / stop streams (hard cap: 2)
- Per-device label, crop, angle, bitrate, FPS
- **Clear cached devices** — deletes `quest-mod/prototype-server/data/devices.json` and resets favourites (confirm dialog)

## Smoke-test checklist (real Quest 3 / 3S)

- [ ] `adb devices` shows the headset after pair/connect
- [ ] Operator **Scan now** lists the device
- [ ] **Start stream** → headset shows Allow USB debugging (first time) → audience tile shows video
- [ ] Second headset streams side-by-side; third start returns an error
- [ ] Stop tears down cleanly; start again works
- [ ] **Clear cached devices** removes saved entries; active stream behavior unchanged until stop
- [ ] Phone/tablet on same Wi‑Fi can open audience URL

## Development checks

Biome provides Rust-based formatting and linting across the workspaces

rustfmt and Clippy check the Rust backend

```bash
npm run check   # Check formatting, imports and lint rules
npm run lint    # Lint only
npm run format  # Apply formatting
```

## Tests

```bash
npm test
```

## Outside the current target

Remote headset control, leaderboard overlays and recording are outside the requested scope
