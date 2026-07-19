# Quest LAN Livestream

LAN livestream app for **Meta Quest 3 / 3S**: discover headsets via wireless ADB, stream up to **two** view-only feeds into a React UI (no Meta casting accounts).

## Architecture

| Path | Role |
|------|------|
| `apps/web` | Vite + React — audience `/`, operator `/operator` |
| `apps/server` | Node (Express + ws) — ADB, discovery, scrcpy-server, WebSocket H.264 fan-out |
| `packages/shared` | Shared types and Quest 3 defaults |
| `data/devices.json` | Saved device favorites / settings (created at runtime) |
| `vendor/scrcpy-server` | Genymobile scrcpy-server binary (downloaded) |

Video path: **ADB → scrcpy-server → Node → WebSocket → WebCodecs** (view-only, no audio in v1).

## One-time host setup

1. Install [Node.js 20+](https://nodejs.org/) and [Android platform-tools](https://developer.android.com/tools/releases/platform-tools) (`adb` on your `PATH`).
2. On each Quest: enable **Developer Mode** (Meta developer org + phone app toggle — one-time).
3. In this repo:

```bash
npm install
npm run download:scrcpy
```

## Run (development)

Terminal A — API / streams (listens on all interfaces for LAN viewers):

```bash
npm run dev:server
```

Terminal B — Vite UI (proxies `/api` and `/ws`):

```bash
npm run dev:web
```

- Audience: `http://localhost:5173/`
- Operator: `http://localhost:5173/operator`
- LAN clients: use the host PC’s LAN IP with the same ports (or build + `npm run start -w @vr-livestream/server` which serves the web build on port `8787`).

## Production-style on LAN

```bash
npm run build
npm run start -w @vr-livestream/server
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
- **Clear cached devices** — deletes `data/devices.json` and resets favorites (confirm dialog)

## Smoke-test checklist (real Quest 3 / 3S)

- [ ] `adb devices` shows the headset after pair/connect
- [ ] Operator **Scan now** lists the device
- [ ] **Start stream** → headset shows Allow USB debugging (first time) → audience tile shows video
- [ ] Second headset streams side-by-side; third start returns an error
- [ ] Stop tears down cleanly; start again works
- [ ] **Clear cached devices** removes saved entries; active stream behavior unchanged until stop
- [ ] Phone/tablet on same Wi‑Fi can open audience URL

## Tests

```bash
npm test
```

## Non-goals (v1)

Leaderboard overlays, audio, 4 concurrent streams, remote control, Meta casting, internet relay, operator login.
