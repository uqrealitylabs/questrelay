import {
  defaultDeviceSettings,
  deviceIdFromHostPort,
  type DeviceInfo,
  type DevicePresence,
  type DeviceSettings,
} from "@vr-livestream/shared";
import type { AdbClient } from "./adb-client.js";
import type { DeviceRegistry } from "./device-registry.js";

export type PortProbe = (host: string, port: number) => Promise<boolean>;

export type DeviceDiscoveryOptions = {
  registry: DeviceRegistry;
  adb: AdbClient;
  probe: PortProbe;
  subnetHosts: string[];
  ports: number[];
  streamingIds?: () => Set<string>;
};

function parseSerial(serial: string): { host?: string; port?: number; usb?: string } {
  if (serial.includes(":")) {
    const [host, portStr] = serial.split(":");
    return { host, port: Number(portStr) };
  }
  return { usb: serial };
}

export class DeviceDiscovery {
  constructor(private readonly opts: DeviceDiscoveryOptions) {}

  async scan(): Promise<DeviceInfo[]> {
    const byId = new Map<string, DeviceInfo>();
    const streaming = this.opts.streamingIds?.() ?? new Set<string>();

    const ensure = (
      id: string,
      base: {
        host: string;
        port: number;
        serial?: string;
        settings?: DeviceSettings;
      },
    ): DeviceInfo => {
      const existing = byId.get(id);
      if (existing) return existing;
      const created: DeviceInfo = {
        id,
        host: base.host,
        port: base.port,
        serial: base.serial,
        settings:
          base.settings ??
          this.opts.registry.get(id)?.settings ??
          defaultDeviceSettings({ label: id }),
        presence: [],
        online: false,
        streaming: streaming.has(id),
      };
      byId.set(id, created);
      return created;
    };

    const addPresence = (device: DeviceInfo, tag: DevicePresence) => {
      if (!device.presence.includes(tag)) device.presence.push(tag);
    };

    for (const saved of this.opts.registry.list()) {
      const device = ensure(saved.id, saved);
      device.settings = saved.settings;
      addPresence(device, "saved");
    }

    const probeResults = await Promise.all(
      this.opts.subnetHosts.flatMap((host) =>
        this.opts.ports.map(async (port) => {
          const open = await this.opts.probe(host, port);
          return open ? { host, port } : null;
        }),
      ),
    );

    for (const hit of probeResults) {
      if (!hit) continue;
      const id = deviceIdFromHostPort(hit.host, hit.port);
      const device = ensure(id, hit);
      device.online = true;
      addPresence(device, "scanned");
    }

    const adbDevices = await this.opts.adb.listDevices();
    for (const adbDev of adbDevices) {
      const parsed = parseSerial(adbDev.serial);
      if (parsed.usb) {
        const id = parsed.usb;
        const device = ensure(id, {
          host: "usb",
          port: 0,
          serial: parsed.usb,
          settings: defaultDeviceSettings({ label: adbDev.model ?? id }),
        });
        device.serial = parsed.usb;
        device.online = adbDev.state === "device" || adbDev.state === "unauthorized";
        device.state = adbDev.state;
        addPresence(device, "usb");
        if (adbDev.state === "device" || adbDev.state === "unauthorized") {
          addPresence(device, "connected");
        }
        continue;
      }

      if (parsed.host == null || parsed.port == null) continue;
      const id = deviceIdFromHostPort(parsed.host, parsed.port);
      const device = ensure(id, {
        host: parsed.host,
        port: parsed.port,
        serial: adbDev.serial,
        settings: defaultDeviceSettings({ label: adbDev.model ?? id }),
      });
      device.serial = adbDev.serial;
      device.online = true;
      device.state = adbDev.state;
      addPresence(device, "connected");
    }

    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}
