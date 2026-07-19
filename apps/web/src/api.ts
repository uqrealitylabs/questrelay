import type { DeviceInfo, DeviceSettings, StreamStatus } from "@vr-livestream/shared";

async function parse<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body.error ?? res.statusText);
  }
  return body as T;
}

export const api = {
  listDevices: () =>
    parse<{ devices: DeviceInfo[] }>(fetch("/api/devices")).then((b) => b.devices),

  saveDevice: (
    id: string,
    payload: { host: string; port: number; serial?: string; settings: DeviceSettings },
  ) =>
    parse<{ device: DeviceInfo }>(
      fetch(`/api/devices/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    ),

  clearCache: () =>
    parse<{ ok: boolean }>(fetch("/api/devices/cache", { method: "DELETE" })),

  listStreams: () =>
    parse<{ streams: StreamStatus[] }>(fetch("/api/streams")).then((b) => b.streams),

  startStream: (deviceId: string, serial?: string) =>
    parse<{ stream: StreamStatus }>(
      fetch("/api/streams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId, serial }),
      }),
    ),

  stopStream: (deviceId: string) =>
    parse<{ ok: boolean }>(
      fetch(`/api/streams/${encodeURIComponent(deviceId)}`, { method: "DELETE" }),
    ),

  pair: (host: string, port: number, code: string) =>
    parse<{ ok: boolean; message: string }>(
      fetch("/api/adb/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host, port, code }),
      }),
    ),

  connect: (host: string, port: number) =>
    parse<{ ok: boolean; message: string }>(
      fetch("/api/adb/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host, port }),
      }),
    ),

  enableWireless: (serial: string) =>
    parse<{ ok: boolean; host?: string; port?: number; message?: string }>(
      fetch("/api/adb/enable-wireless", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serial }),
      }),
    ),
};
