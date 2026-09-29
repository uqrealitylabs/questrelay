import {
  type DeviceSettings,
  defaultDeviceSettings,
  deviceIdFromHostPort,
  type SavedDevice,
} from "@questrelay/shared";
import cors from "cors";
import express, { type Express, type Request, type Response } from "express";
import type { AdbClient } from "./adb-client.js";
import { DeviceDiscovery, type PortProbe } from "./device-discovery.js";
import type { DeviceRegistry } from "./device-registry.js";
import type { StreamManager } from "./stream-manager.js";

export type AppContext = {
  registry: DeviceRegistry;
  adb: AdbClient;
  streamManager: StreamManager;
  probe: PortProbe;
  subnetHosts: () => Promise<string[]> | string[];
};

function parseDeviceId(raw: string): string {
  return decodeURIComponent(raw);
}

export function createApp(ctx: AppContext): Express {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/devices", async (_req, res) => {
    try {
      const hosts = await ctx.subnetHosts();
      const scanner = new DeviceDiscovery({
        registry: ctx.registry,
        adb: ctx.adb,
        probe: ctx.probe,
        subnetHosts: hosts,
        ports: [5555, 5556, 37000, 37001, 37100, 37101],
        streamingIds: () => ctx.streamManager.activeIds(),
      });
      const devices = await scanner.scan();
      res.json({ devices });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.put("/api/devices/:deviceId", async (req, res) => {
    try {
      const id = parseDeviceId(req.params.deviceId);
      const body = req.body as {
        host?: string;
        port?: number;
        serial?: string;
        settings?: Partial<DeviceSettings>;
      };
      const existing = ctx.registry.get(id);
      const host = body.host ?? existing?.host ?? id.split(":")[0];
      const port =
        body.port ?? existing?.port ?? Number(id.split(":")[1] || 5555);
      const device: SavedDevice = {
        id: deviceIdFromHostPort(host, port),
        host,
        port,
        serial: body.serial ?? existing?.serial,
        settings: defaultDeviceSettings({
          ...existing?.settings,
          ...body.settings,
        }),
      };
      const saved = await ctx.registry.upsert(device);
      res.json({ device: saved });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.delete("/api/devices/cache", async (_req, res) => {
    try {
      await ctx.registry.clearCache();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/streams", (_req, res) => {
    res.json({ streams: ctx.streamManager.listActive() });
  });

  app.post("/api/streams", async (req, res) => {
    try {
      const { deviceId, serial, label, settings } = req.body as {
        deviceId: string;
        serial?: string;
        label?: string;
        settings?: Partial<DeviceSettings>;
      };
      if (!deviceId) {
        res.status(400).json({ error: "deviceId required" });
        return;
      }
      const saved = ctx.registry.get(deviceId);
      const resolvedSerial = serial ?? saved?.serial ?? deviceId;
      const resolvedSettings = defaultDeviceSettings({
        ...saved?.settings,
        ...settings,
      });
      const stream = await ctx.streamManager.start({
        deviceId,
        serial: resolvedSerial,
        label: label ?? resolvedSettings.label,
        settings: resolvedSettings,
      });
      res.json({ stream });
    } catch (err) {
      const message = (err as Error).message;
      const status = /max concurrent/i.test(message) ? 409 : 500;
      res.status(status).json({ error: message });
    }
  });

  app.delete("/api/streams/:deviceId", async (req, res) => {
    try {
      const id = parseDeviceId(req.params.deviceId);
      await ctx.streamManager.stop(id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/adb/pair", async (req, res) => {
    try {
      const { host, port, code } = req.body as {
        host: string;
        port: number;
        code: string;
      };
      const result = await ctx.adb.pair(host, Number(port), String(code));
      res.status(result.ok ? 200 : 400).json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/adb/connect", async (req, res) => {
    try {
      const { host, port } = req.body as { host: string; port: number };
      const result = await ctx.adb.connect(host, Number(port));
      if (result.ok) {
        const id = deviceIdFromHostPort(host, Number(port));
        const existing = ctx.registry.get(id);
        await ctx.registry.upsert({
          id,
          host,
          port: Number(port),
          serial: id,
          settings: existing?.settings ?? defaultDeviceSettings({ label: id }),
        });
      }
      res.status(result.ok ? 200 : 400).json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/adb/enable-wireless", async (req, res) => {
    try {
      const { serial } = req.body as { serial: string };
      const result = await ctx.adb.enableWirelessAdb(serial);
      if (result.ok) {
        const id = deviceIdFromHostPort(result.host, result.port);
        const existing = ctx.registry.get(id);
        await ctx.registry.upsert({
          id,
          host: result.host,
          port: result.port,
          serial: id,
          settings:
            existing?.settings ?? defaultDeviceSettings({ label: result.host }),
        });
        await ctx.adb.connect(result.host, result.port);
      }
      res.status(result.ok ? 200 : 400).json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.use((err: Error, _req: Request, res: Response, _next: () => void) => {
    res.status(500).json({ error: err.message });
  });

  return app;
}
