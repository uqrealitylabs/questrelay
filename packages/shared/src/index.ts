/** Quest 3 / 3S one-eye spectator defaults (tunable per device). */
export const QUEST3_ONE_EYE_DEFAULTS = {
  crop: "1600:900:2017:90",
  angle: 11,
  maxSize: 1280,
  bitRate: 10_000_000,
  maxFps: 30,
} as const;

export const MAX_CONCURRENT_STREAMS = 2;

export const ADB_PORTS = [5555, 5556, 37000, 37001, 37100, 37101] as const;

export type DeviceSettings = {
  label: string;
  crop: string;
  angle: number;
  bitRate: number;
  maxFps: number;
  maxSize: number;
};

export type SavedDevice = {
  id: string;
  host: string;
  port: number;
  serial?: string;
  settings: DeviceSettings;
};

export type DevicePresence = "saved" | "scanned" | "connected" | "usb";

export type DeviceInfo = SavedDevice & {
  presence: DevicePresence[];
  online: boolean;
  streaming: boolean;
  state?: string;
};

export type StreamStatus = {
  deviceId: string;
  label: string;
  state: "starting" | "waiting_auth" | "streaming" | "error" | "stopped";
  error?: string;
};

export type GlobalStreamDefaults = {
  bitRate: number;
  maxFps: number;
  maxSize: number;
  crop: string;
  angle: number;
};

export function defaultDeviceSettings(
  overrides: Partial<DeviceSettings> = {},
): DeviceSettings {
  return {
    label: overrides.label ?? "Quest",
    crop: overrides.crop ?? QUEST3_ONE_EYE_DEFAULTS.crop,
    angle: overrides.angle ?? QUEST3_ONE_EYE_DEFAULTS.angle,
    bitRate: overrides.bitRate ?? QUEST3_ONE_EYE_DEFAULTS.bitRate,
    maxFps: overrides.maxFps ?? QUEST3_ONE_EYE_DEFAULTS.maxFps,
    maxSize: overrides.maxSize ?? QUEST3_ONE_EYE_DEFAULTS.maxSize,
  };
}

export function deviceIdFromHostPort(host: string, port: number): string {
  return `${host}:${port}`;
}
