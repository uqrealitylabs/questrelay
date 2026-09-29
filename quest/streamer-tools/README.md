# Streamer Tools (Quest 1.40.8 port)

Verify-phase port of [EnderdracheLP/streamer-tools](https://github.com/EnderdracheLP/streamer-tools) (GPL-3.0).

HTTP only — no settings UI, no overlays, no multicast/socket client.

Target: Beat Saber **1.40.8_7379**, Scotland2, NDK 27.

## Build (Windows)

Toolchain once: PowerShell 7, CMake, QPM, `qpm download ninja`, `qpm ndk download 27`, set `ANDROID_NDK_HOME`.

```powershell
cd quest/streamer-tools
qpm restore
qpm s build
qpm s qmod   # or: pwsh ./scripts/createqmod.ps1
```

Output: `Streamer-Tools.qmod`

## Install + verify checklist

1. Headset on **1.40.8**, modded with ModsBeforeFriday (Scotland2).
2. Upload `Streamer-Tools.qmod` in MBF and enable it.
3. Same Wi‑Fi as this laptop. Note Quest LAN IP (MBF / wireless debugging / router).
4. Open Beat Saber; in menu then in a map, hit:

```text
http://<Quest-LAN-IP>:53502/data
```

Expected JSON fields (at least): `score`, `combo`, `missedNotes` — plus `goodCuts`, `badCuts`, `accuracy`, `paused`, `location`.

```powershell
curl http://<Quest-LAN-IP>:53502/data
```

Do **not** use `localhost` on the laptop — the HTTP server runs on the Quest.

5. If crash: `qpm s logcat` / tombstone; fix hooks before any Express ingest work.

## License / attribution

Based on Streamer Tools by EnderdracheLP et al., GNU GPL v3. See upstream `LICENSE`.
