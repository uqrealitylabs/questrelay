import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADB_PORTS, defaultDeviceSettings } from "@questrelay/shared";
import { describe, expect, it } from "vitest";
import type { AdbClient, AdbDevice } from "./adb-client.js";
import { DeviceDiscovery, type PortProbe } from "./device-discovery.js";
import { DeviceRegistry } from "./device-registry.js";

function stubAdb(devices: AdbDevice[]): AdbClient {
  return {
    listDevices: async () => devices,
  } as unknown as AdbClient;
}

describe("DeviceDiscovery", () => {
  it("merges saved favorites with subnet scan hits and adb devices", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vr-disc-"));
    const registry = new DeviceRegistry(join(dir, "devices.json"));
    await registry.upsert({
      id: "192.168.1.10:5555",
      host: "192.168.1.10",
      port: 5555,
      settings: defaultDeviceSettings({ label: "Saved Quest" }),
    });

    const openPorts = new Set(["192.168.1.20:5555", "192.168.1.10:5555"]);
    const probe: PortProbe = async (host, port) =>
      openPorts.has(`${host}:${port}`);

    const adb = stubAdb([
      {
        serial: "192.168.1.20:5555",
        state: "device",
        transport: "tcp",
        model: "Quest_3",
      },
      {
        serial: "USBONLY01",
        state: "device",
        transport: "usb",
        model: "Quest_3",
      },
    ]);

    const discovery = new DeviceDiscovery({
      registry,
      adb,
      probe,
      subnetHosts: ["192.168.1.10", "192.168.1.20", "192.168.1.30"],
      ports: [...ADB_PORTS],
    });

    const devices = await discovery.scan();
    const byId = Object.fromEntries(devices.map((d) => [d.id, d]));

    expect(byId["192.168.1.10:5555"]).toMatchObject({
      settings: { label: "Saved Quest" },
      online: true,
      presence: expect.arrayContaining(["saved", "scanned"]),
    });
    expect(byId["192.168.1.20:5555"]).toMatchObject({
      online: true,
      presence: expect.arrayContaining(["scanned", "connected"]),
    });
    expect(byId.USBONLY01).toMatchObject({
      online: true,
      presence: expect.arrayContaining(["usb", "connected"]),
    });
    expect(byId["192.168.1.30:5555"]).toBeUndefined();
  });
});
