/**
 * TDD seams for @vr-livestream/server (confirmed against Quest LAN plan):
 *
 * 1. DeviceRegistry — persist/load/upsert/clear favorites (data/devices.json)
 * 2. AdbClient — shell boundary for adb commands (mocked in tests)
 * 3. DeviceDiscovery — hybrid subnet scan + adb devices + saved merge
 * 4. Pairing / UsbWirelessHelper — pair, connect, tcpip bootstrap
 * 5. StreamManager — max 2 sessions, start/stop, subscriber fan-out
 * 6. HTTP API — REST for devices/settings/connect/clear-cache
 */
export {};
