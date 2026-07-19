# Quest LAN Livestream — domain vocabulary

Use these terms in tests and APIs:

- **Device** — a Quest headset addressable by `host:port` (wireless ADB) or USB serial
- **Registry / favorites** — persisted entries in `data/devices.json`
- **Discovery / scan** — hybrid merge of saved devices, subnet ADB port probe, and `adb devices`
- **Pair** — `adb pair` Wireless debugging bootstrap
- **Enable wireless ADB** — USB `adb tcpip 5555` helper
- **Stream session** — one scrcpy-server capture (max 2 concurrent)
- **Audience** — view-only UI at `/`
- **Operator** — control UI at `/operator` (no login in v1)
- **Accept step** — headset “Allow USB debugging?” prompt
