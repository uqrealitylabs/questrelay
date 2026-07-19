import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SavedDevice } from "@vr-livestream/shared";

type DevicesFile = {
  devices: SavedDevice[];
};

export class DeviceRegistry {
  private devices = new Map<string, SavedDevice>();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as DevicesFile;
      this.devices.clear();
      for (const device of parsed.devices ?? []) {
        this.devices.set(device.id, device);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.devices.clear();
        return;
      }
      throw err;
    }
  }

  list(): SavedDevice[] {
    return [...this.devices.values()];
  }

  get(id: string): SavedDevice | undefined {
    return this.devices.get(id);
  }

  async upsert(device: SavedDevice): Promise<SavedDevice> {
    this.devices.set(device.id, device);
    await this.persist();
    return device;
  }

  async clearCache(): Promise<void> {
    this.devices.clear();
    try {
      await unlink(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const payload: DevicesFile = { devices: this.list() };
    await writeFile(this.filePath, JSON.stringify(payload, null, 2), "utf8");
  }
}
