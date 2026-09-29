import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_CONCURRENT_STREAMS,
  QUEST3_ONE_EYE_DEFAULTS,
} from "@questrelay/shared";
import express from "express";
import { type WebSocket, WebSocketServer } from "ws";
import { AdbClient } from "./adb-client.js";
import { createAdbCommandRunner } from "./adb-runner.js";
import { createApp } from "./app.js";
import { DeviceRegistry } from "./device-registry.js";
import { createTcpPortProbe, localSubnetHosts } from "./network.js";
import { createScrcpySessionFactory } from "./scrcpy-session.js";
import { StreamManager } from "./stream-manager.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../../..");
const dataDir = join(root, "quest", "prototype-server", "data");
const serverJarPath = join(root, "quest", "vendor", "scrcpy-server");
const SCRCPY_VERSION = process.env.SCRCPY_VERSION ?? "3.1";
const PORT = Number(process.env.PORT ?? 8787);

async function main() {
  const registry = new DeviceRegistry(join(dataDir, "devices.json"));
  await registry.load();

  const adb = new AdbClient(
    createAdbCommandRunner(process.env.ADB_PATH ?? "adb"),
  );
  const streamManager = new StreamManager({
    maxSessions: MAX_CONCURRENT_STREAMS,
    factory: createScrcpySessionFactory({
      adb,
      serverJarPath,
      scrcpyVersion: SCRCPY_VERSION,
      adbPath: process.env.ADB_PATH ?? "adb",
    }),
  });

  const app = createApp({
    registry,
    adb,
    streamManager,
    probe: createTcpPortProbe(150),
    subnetHosts: () => localSubnetHosts(),
  });

  app.get("/api/defaults", (_req, res) => {
    res.json({ defaults: QUEST3_ONE_EYE_DEFAULTS });
  });

  const webDist = join(root, "frontend/dist");
  app.use(express.static(webDist));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api") || req.path.startsWith("/ws")) {
      next();
      return;
    }
    res.sendFile(join(webDist, "index.html"), (err) => {
      if (err) next();
    });
  });

  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const match = /^\/ws\/stream\/(.+)$/.exec(url.pathname);
    if (!match) {
      socket.destroy();
      return;
    }
    const deviceId = decodeURIComponent(match[1]);
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleStreamSocket(ws, deviceId, streamManager);
    });
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`QuestRelay server on http://0.0.0.0:${PORT}`);
    console.log(`Audience:  http://<host-lan-ip>:${PORT}/`);
    console.log(`Operator:  http://<host-lan-ip>:${PORT}/operator`);
  });

  const shutdown = () => {
    server.close();
    void streamManager.stopAll();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function handleStreamSocket(
  ws: WebSocket,
  deviceId: string,
  streamManager: StreamManager,
) {
  try {
    const unsubscribe = streamManager.subscribe(deviceId, {
      send: (chunk) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(chunk);
        }
      },
    });
    ws.on("close", unsubscribe);
    ws.on("error", unsubscribe);
  } catch (err) {
    ws.send(JSON.stringify({ error: (err as Error).message }));
    ws.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
