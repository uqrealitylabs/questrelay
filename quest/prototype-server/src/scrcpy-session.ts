import { type ChildProcess, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import type { AdbClient } from "./adb-client.js";
import type { ScrcpySessionFactory } from "./stream-manager.js";

const REMOTE_JAR = "/data/local/tmp/scrcpy-server.jar";

export type ScrcpyLauncherOptions = {
  adb: AdbClient;
  serverJarPath: string;
  scrcpyVersion: string;
  /** Override adb binary used to spawn the shell process. */
  adbPath?: string;
};

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate port"));
        return;
      }
      const port = address.port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Starts Genymobile scrcpy-server in raw H.264 tunnel_forward mode and
 * pipes the TCP video bytes to onVideo (view-only, no control socket).
 */
export function createScrcpySessionFactory(
  opts: ScrcpyLauncherOptions,
): ScrcpySessionFactory {
  const adbPath = opts.adbPath ?? "adb";

  return async ({ serial, settings, onVideo, onState }) => {
    await access(opts.serverJarPath).catch(() => {
      throw new Error(
        `scrcpy-server not found at ${opts.serverJarPath}. Run npm run download:scrcpy`,
      );
    });

    await opts.adb.push(serial, opts.serverJarPath, REMOTE_JAR);

    const scid = Math.floor(Math.random() * 0x7fffffff)
      .toString(16)
      .padStart(8, "0");
    const abstract = `scrcpy_${scid}`;
    const localPort = await findFreePort();

    await opts.adb.forward(
      serial,
      `tcp:${localPort}`,
      `localabstract:${abstract}`,
    );

    const serverArgs = [
      opts.scrcpyVersion,
      "tunnel_forward=true",
      "audio=false",
      "control=false",
      "cleanup=true",
      "raw_stream=true",
      `max_size=${settings.maxSize}`,
      `video_bit_rate=${settings.bitRate}`,
      `max_fps=${settings.maxFps}`,
      `scid=${scid}`,
    ];
    if (settings.crop) serverArgs.push(`crop=${settings.crop}`);
    if (settings.angle) serverArgs.push(`angle=${settings.angle}`);

    const shellCmd = `CLASSPATH=${REMOTE_JAR} app_process / com.genymobile.scrcpy.Server ${serverArgs.join(" ")}`;

    let shellProc: ChildProcess | undefined = spawn(
      adbPath,
      ["-s", serial, "shell", shellCmd],
      { windowsHide: true },
    );

    shellProc.stderr?.on("data", (buf: Buffer) => {
      const text = buf.toString("utf8");
      if (/unauthorized|allow usb debugging/i.test(text)) {
        onState?.("waiting_auth");
      }
    });

    await sleep(500);

    let socket: Socket;
    try {
      socket = await new Promise<Socket>((resolve, reject) => {
        const s = createConnection({ host: "127.0.0.1", port: localPort });
        const timer = setTimeout(() => {
          s.destroy();
          reject(new Error("Timed out connecting to scrcpy video socket"));
        }, 8000);
        s.once("connect", () => {
          clearTimeout(timer);
          resolve(s);
        });
        s.once("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
    } catch (err) {
      shellProc.kill();
      try {
        await opts.adb.forward(serial, "--remove", `tcp:${localPort}`);
      } catch {
        // ignore
      }
      throw err;
    }

    let stopped = false;
    onState?.("streaming");

    socket.on("data", (chunk) => {
      if (!stopped) onVideo(chunk);
    });
    socket.on("close", () => {
      if (!stopped) onState?.("stopped");
    });
    socket.on("error", (err) => {
      if (!stopped) onState?.("error", err.message);
    });

    return {
      stop: async () => {
        stopped = true;
        socket.destroy();
        if (shellProc && !shellProc.killed) {
          shellProc.kill();
          shellProc = undefined;
        }
        try {
          await opts.adb.forward(serial, "--remove", `tcp:${localPort}`);
        } catch {
          // best-effort
        }
      },
    };
  };
}
