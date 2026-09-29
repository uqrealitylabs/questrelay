import {
  defaultDeviceSettings,
  MAX_CONCURRENT_STREAMS,
} from "@questrelay/shared";
import { describe, expect, it, vi } from "vitest";
import {
  type ScrcpySessionFactory,
  StreamManager,
  type VideoSink,
} from "./stream-manager.js";

function makeFactory(): {
  factory: ScrcpySessionFactory;
  started: string[];
  stopped: string[];
} {
  const started: string[] = [];
  const stopped: string[] = [];
  const factory: ScrcpySessionFactory = async ({ deviceId, onVideo }) => {
    started.push(deviceId);
    let closed = false;
    const interval = setInterval(() => {
      if (!closed) onVideo(Buffer.from([0, 0, 0, 1, 0x65]));
    }, 5);
    return {
      stop: async () => {
        closed = true;
        clearInterval(interval);
        stopped.push(deviceId);
      },
    };
  };
  return { factory, started, stopped };
}

describe("StreamManager", () => {
  it("starts a stream and fans video frames to subscribers", async () => {
    const { factory, started } = makeFactory();
    const manager = new StreamManager({
      factory,
      maxSessions: MAX_CONCURRENT_STREAMS,
    });
    const frames: Buffer[] = [];
    const sink: VideoSink = {
      send: (chunk) => {
        frames.push(Buffer.from(chunk));
      },
    };

    const request = {
      deviceId: "192.168.1.10:5555",
      serial: "192.168.1.10:5555",
      label: "Quest A",
      settings: defaultDeviceSettings(),
    };
    const status = await manager.start(request);
    expect(await manager.start(request)).toEqual(status);
    expect(started).toEqual([request.deviceId]);
    manager.subscribe("192.168.1.10:5555", sink);

    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
    expect(manager.listActive().map((s) => s.deviceId)).toEqual([
      "192.168.1.10:5555",
    ]);
    expect(manager.listActive()[0].state).toBe("streaming");

    await manager.stop("192.168.1.10:5555");
    expect(manager.listActive()).toEqual([]);
  });

  it("rejects a third concurrent stream", async () => {
    const { factory } = makeFactory();
    const manager = new StreamManager({
      factory,
      maxSessions: MAX_CONCURRENT_STREAMS,
    });
    const settings = defaultDeviceSettings();

    await manager.start({
      deviceId: "a:5555",
      serial: "a:5555",
      label: "A",
      settings,
    });
    await manager.start({
      deviceId: "b:5555",
      serial: "b:5555",
      label: "B",
      settings,
    });

    await expect(
      manager.start({
        deviceId: "c:5555",
        serial: "c:5555",
        label: "C",
        settings,
      }),
    ).rejects.toThrow(/max/i);
  });

  it("stops cleanly and unsubscribes sinks", async () => {
    const { factory, stopped } = makeFactory();
    const manager = new StreamManager({ factory, maxSessions: 2 });
    await manager.start({
      deviceId: "a:5555",
      serial: "a:5555",
      label: "A",
      settings: defaultDeviceSettings(),
    });
    const sink: VideoSink = { send: () => undefined };
    manager.subscribe("a:5555", sink);
    await manager.stop("a:5555");
    expect(stopped).toEqual(["a:5555"]);
    expect(manager.subscriberCount("a:5555")).toBe(0);
  });
});
