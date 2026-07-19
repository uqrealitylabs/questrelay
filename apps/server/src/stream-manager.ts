import type { DeviceSettings, StreamStatus } from "@vr-livestream/shared";

export type VideoSink = {
  send: (chunk: Uint8Array) => void;
};

export type ScrcpySession = {
  stop: () => Promise<void>;
};

export type ScrcpySessionStart = {
  deviceId: string;
  serial: string;
  settings: DeviceSettings;
  onVideo: (chunk: Buffer) => void;
  onState?: (state: StreamStatus["state"], error?: string) => void;
};

export type ScrcpySessionFactory = (
  opts: ScrcpySessionStart,
) => Promise<ScrcpySession>;

export type StreamStartRequest = {
  deviceId: string;
  serial: string;
  label: string;
  settings: DeviceSettings;
};

type ActiveSession = {
  status: StreamStatus;
  session: ScrcpySession;
  sinks: Set<VideoSink>;
};

export type StreamManagerOptions = {
  factory: ScrcpySessionFactory;
  maxSessions: number;
};

export class StreamManager {
  private sessions = new Map<string, ActiveSession>();

  constructor(private readonly opts: StreamManagerOptions) {}

  listActive(): StreamStatus[] {
    return [...this.sessions.values()].map((s) => ({ ...s.status }));
  }

  activeIds(): Set<string> {
    return new Set(this.sessions.keys());
  }

  subscriberCount(deviceId: string): number {
    return this.sessions.get(deviceId)?.sinks.size ?? 0;
  }

  subscribe(deviceId: string, sink: VideoSink): () => void {
    const active = this.sessions.get(deviceId);
    if (!active) {
      throw new Error(`No active stream for ${deviceId}`);
    }
    active.sinks.add(sink);
    return () => {
      active.sinks.delete(sink);
    };
  }

  async start(req: StreamStartRequest): Promise<StreamStatus> {
    if (this.sessions.has(req.deviceId)) {
      return this.sessions.get(req.deviceId)!.status;
    }
    if (this.sessions.size >= this.opts.maxSessions) {
      throw new Error(
        `Max concurrent streams reached (${this.opts.maxSessions})`,
      );
    }

    const status: StreamStatus = {
      deviceId: req.deviceId,
      label: req.label,
      state: "starting",
    };

    const sinks = new Set<VideoSink>();
    const session = await this.opts.factory({
      deviceId: req.deviceId,
      serial: req.serial,
      settings: req.settings,
      onVideo: (chunk) => {
        const active = this.sessions.get(req.deviceId);
        if (!active) return;
        if (active.status.state !== "streaming") {
          active.status.state = "streaming";
        }
        for (const sink of active.sinks) {
          sink.send(chunk);
        }
      },
      onState: (state, error) => {
        const active = this.sessions.get(req.deviceId);
        if (!active) return;
        active.status.state = state;
        active.status.error = error;
      },
    });

    this.sessions.set(req.deviceId, { status, session, sinks });
    status.state = "streaming";
    return { ...status };
  }

  async stop(deviceId: string): Promise<void> {
    const active = this.sessions.get(deviceId);
    if (!active) return;
    this.sessions.delete(deviceId);
    active.sinks.clear();
    await active.session.stop();
  }

  async stopAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.stop(id)));
  }
}
