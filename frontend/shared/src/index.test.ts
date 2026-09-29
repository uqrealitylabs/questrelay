import { describe, expect, it } from "vitest";
import {
  defaultDeviceSettings,
  deviceIdFromHostPort,
  MAX_CONCURRENT_STREAMS,
} from "./index.js";

describe("shared defaults", () => {
  it("caps concurrent streams at 2", () => {
    expect(MAX_CONCURRENT_STREAMS).toBe(2);
  });

  it("builds device ids from host and port", () => {
    expect(deviceIdFromHostPort("192.168.1.5", 5555)).toBe("192.168.1.5:5555");
  });

  it("applies Quest 3 one-eye defaults", () => {
    const settings = defaultDeviceSettings({ label: "A" });
    expect(settings.label).toBe("A");
    expect(settings.maxFps).toBe(30);
    expect(settings.crop.length).toBeGreaterThan(0);
  });
});
