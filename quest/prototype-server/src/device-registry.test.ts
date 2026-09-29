import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultDeviceSettings } from "@questrelay/shared";
import { describe, expect, it } from "vitest";
import { DeviceRegistry } from "./device-registry.js";

describe("DeviceRegistry", () => {
  it("persists a saved device so it can be listed after reload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vr-ls-"));
    const file = join(dir, "devices.json");
    const registry = new DeviceRegistry(file);

    await registry.upsert({
      id: "192.168.1.10:5555",
      host: "192.168.1.10",
      port: 5555,
      settings: defaultDeviceSettings({ label: "Quest A" }),
    });

    const reloaded = new DeviceRegistry(file);
    await reloaded.load();
    const devices = reloaded.list();

    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      id: "192.168.1.10:5555",
      host: "192.168.1.10",
      port: 5555,
      settings: expect.objectContaining({ label: "Quest A" }),
    });
  });

  it("clearCache removes devices.json and empties the in-memory list", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vr-ls-"));
    const file = join(dir, "devices.json");
    const registry = new DeviceRegistry(file);

    await registry.upsert({
      id: "192.168.1.11:5555",
      host: "192.168.1.11",
      port: 5555,
      settings: defaultDeviceSettings(),
    });
    await registry.clearCache();

    expect(registry.list()).toEqual([]);
    await expect(access(file)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(file, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("updates settings for an existing device id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vr-ls-"));
    const file = join(dir, "devices.json");
    const registry = new DeviceRegistry(file);

    await registry.upsert({
      id: "192.168.1.12:5555",
      host: "192.168.1.12",
      port: 5555,
      settings: defaultDeviceSettings({ label: "Old" }),
    });
    await registry.upsert({
      id: "192.168.1.12:5555",
      host: "192.168.1.12",
      port: 5555,
      settings: defaultDeviceSettings({ label: "New", bitRate: 8_000_000 }),
    });

    expect(registry.list()).toHaveLength(1);
    expect(registry.get("192.168.1.12:5555")?.settings.label).toBe("New");
    expect(registry.get("192.168.1.12:5555")?.settings.bitRate).toBe(8_000_000);
  });
});
