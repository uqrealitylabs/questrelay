import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultDeviceSettings,
  MAX_CONCURRENT_STREAMS,
} from "@questrelay/shared";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { AdbClient } from "./adb-client.js";
import { type AppContext, createApp } from "./app.js";
import { DeviceRegistry } from "./device-registry.js";
import { StreamManager } from "./stream-manager.js";

async function buildTestApp() {
  const dir = await mkdtemp(join(tmpdir(), "vr-api-"));
  const registry = new DeviceRegistry(join(dir, "devices.json"));
  await registry.load();

  const streamManager = new StreamManager({
    maxSessions: MAX_CONCURRENT_STREAMS,
    factory: async ({ onVideo }) => {
      const timer = setInterval(() => onVideo(Buffer.from([0, 0, 0, 1])), 20);
      return {
        stop: async () => clearInterval(timer),
      };
    },
  });

  const adb = new AdbClient(async (args) => {
    const key = args.join(" ");
    if (key === "devices -l") {
      return {
        stdout:
          "List of devices attached\n192.168.1.10:5555    device model:Quest_3\n",
        stderr: "",
        code: 0,
      };
    }
    if (key.startsWith("pair ")) {
      return { stdout: "Successfully paired", stderr: "", code: 0 };
    }
    if (key.startsWith("connect ")) {
      return { stdout: `connected to ${args[1]}`, stderr: "", code: 0 };
    }
    if (key.includes("tcpip")) {
      return {
        stdout: "restarting in TCP mode port: 5555",
        stderr: "",
        code: 0,
      };
    }
    if (key.includes("addr show wlan0")) {
      return {
        stdout: "inet 192.168.1.77/24 scope global wlan0\n",
        stderr: "",
        code: 0,
      };
    }
    return { stdout: "", stderr: "", code: 0 };
  });

  const ctx: AppContext = {
    registry,
    adb,
    streamManager,
    probe: async () => false,
    subnetHosts: async () => ["192.168.1.10"],
  };

  return { app: createApp(ctx), registry, streamManager };
}

describe("HTTP API", () => {
  let streamManager: StreamManager | undefined;

  afterEach(async () => {
    await streamManager?.stopAll();
  });

  it("lists devices from discovery", async () => {
    const built = await buildTestApp();
    streamManager = built.streamManager;

    const res = await request(built.app).get("/api/devices");
    expect(res.status).toBe(200);
    expect(
      res.body.devices.some(
        (d: { id: string }) => d.id === "192.168.1.10:5555",
      ),
    ).toBe(true);
  });

  it("saves device settings and clears cache", async () => {
    const built = await buildTestApp();
    streamManager = built.streamManager;

    const save = await request(built.app)
      .put("/api/devices/192.168.1.10:5555")
      .send({
        host: "192.168.1.10",
        port: 5555,
        settings: defaultDeviceSettings({ label: "Floor 1" }),
      });
    expect(save.status).toBe(200);
    expect(save.body.device.settings.label).toBe("Floor 1");

    const cleared = await request(built.app).delete("/api/devices/cache");
    expect(cleared.status).toBe(200);
    expect(cleared.body.ok).toBe(true);

    const list = await request(built.app).get("/api/devices");
    expect(
      list.body.devices.filter((d: { presence: string[] }) =>
        d.presence.includes("saved"),
      ),
    ).toHaveLength(0);
  });

  it("starts and stops a stream with max-2 enforcement via API", async () => {
    const built = await buildTestApp();
    streamManager = built.streamManager;

    const a = await request(built.app)
      .post("/api/streams")
      .send({ deviceId: "192.168.1.10:5555" });
    expect(a.status).toBe(200);
    expect(a.body.stream.state).toBe("streaming");

    const b = await request(built.app)
      .post("/api/streams")
      .send({ deviceId: "192.168.1.11:5555", serial: "192.168.1.11:5555" });
    expect(b.status).toBe(200);

    const c = await request(built.app)
      .post("/api/streams")
      .send({ deviceId: "192.168.1.12:5555", serial: "192.168.1.12:5555" });
    expect(c.status).toBe(409);

    const active = await request(built.app).get("/api/streams");
    expect(active.body.streams).toHaveLength(2);

    const stop = await request(built.app).delete(
      "/api/streams/192.168.1.10%3A5555",
    );
    expect(stop.status).toBe(200);
  });

  it("pairs and enables wireless ADB", async () => {
    const built = await buildTestApp();
    streamManager = built.streamManager;

    const pair = await request(built.app).post("/api/adb/pair").send({
      host: "192.168.1.30",
      port: 37100,
      code: "123456",
    });
    expect(pair.status).toBe(200);
    expect(pair.body.ok).toBe(true);

    const wifi = await request(built.app)
      .post("/api/adb/enable-wireless")
      .send({ serial: "USBSERIAL" });
    expect(wifi.status).toBe(200);
    expect(wifi.body).toMatchObject({
      ok: true,
      host: "192.168.1.77",
      port: 5555,
    });
  });
});
