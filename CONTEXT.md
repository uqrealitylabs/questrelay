# QuestRelay — scope and domain vocabulary

## Target product

Multiple Meta Quest video feeds with synchronised device audio in one browser over local networks and the internet, without Developer Mode for headset owners

- **Device** — a Meta Quest headset publishing a feed
- **Feed** — one headset's video and device audio, with independent playback controls
- **Session** — a group of feeds available to authorised viewers
- **Capacity** — a configurable deployment limit backed by measured bandwidth and decoding capacity, not a fixed two-feed product limit
- **Consent** — the wearer's approval to capture, plus the ability to stop sharing
- **Audience** — people watching the feeds
- **Operator** — the person organising the session and monitoring connections

The chosen approach is a QuestRelay companion app on each headset, using consented MediaProjection video and AudioPlaybackCapture device audio; the no-app browser casting bridge is outside the delivery plan

The active backend is Rust with mediasoup's native SFU worker, H.264 video and Opus audio signalling, and configurable publisher/viewer limits; private sessions, revocable access, internet NAT traversal, companion distribution with Developer Mode disabled and capture while another app runs still require implementation or real-headset validation

## Experience requirements

Optimise for the lowest practical capture-to-display latency; zero latency is an aspiration, never a literal promise

Use a Discord-style channel list, headset participants, central feed stage and persistent audio/session controls; two-way voice chat remains a separate scope decision

Support saved layouts, themes, density, text size, per-feed audio and quality preferences; personal settings stay separate from operator-controlled session configuration

The README defines provisional latency budgets and measurement conditions; no performance result has been measured yet

## Archived prototype

The optional prototype in `quest/prototype-server` still uses ADB/scrcpy, requires Developer Mode, carries video only and limits active streams to two

- **Registry / favourites** — persisted entries in `quest/prototype-server/data/devices.json`
- **Discovery / scan** — saved devices, subnet ADB probes and `adb devices`
- **Pair** — `adb pair` wireless-debugging bootstrap
- **Enable wireless ADB** — USB `adb tcpip 5555` helper
- **Stream session** — one scrcpy-server capture
- **Audience / operator routes** — `/` and `/operator`, currently without login
- **Accept step** — the headset's USB debugging prompt, distinct from the target capture-consent flow
