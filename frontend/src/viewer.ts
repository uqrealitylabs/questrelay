import { Device, type types } from "mediasoup-client";
import type { Feed } from "./api";

type Reply<T> = { id: number; ok: boolean; data?: T; error?: string };
type FeedEvent = { event: "feeds"; feeds: Feed[] };

class Signal {
  private id = 1;
  private pending = new Map<
    number,
    {
      resolve: (data: unknown) => void;
      reject: (error: Error) => void;
      timer: number;
    }
  >();
  onFeeds?: (feeds: Feed[]) => void;
  onClosed?: () => void;

  private constructor(private socket: WebSocket) {
    socket.onmessage = (event) => {
      let message: Reply<unknown> | FeedEvent;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if ("event" in message) {
        if (message.event === "feeds") this.onFeeds?.(message.feeds);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.data);
      else pending.reject(new Error(message.error ?? "Relay request failed"));
    };
    socket.onclose = () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Relay connection closed"));
      }
      this.pending.clear();
      this.onClosed?.();
    };
  }

  static async open(): Promise<Signal> {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${location.host}/ws/relay`);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("Could not connect to relay"));
      socket.onclose = () => reject(new Error("Relay closed before joining"));
    });
    return new Signal(socket);
  }

  request<T>(action: object): Promise<T> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Relay is disconnected"));
    }
    const id = this.id++;
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Relay did not respond"));
      }, 10_000);
      this.pending.set(id, {
        resolve: resolve as (data: unknown) => void,
        reject,
        timer,
      });
      this.socket.send(JSON.stringify({ id, ...action }));
    });
  }

  close() {
    this.onClosed = undefined;
    this.socket.close();
  }
}

type Subscription = {
  stream: MediaStream;
  consumers: types.Consumer[];
  producers: string[];
};

export type NerdStats = {
  connection: string;
  video?: {
    codec: string;
    resolution: string;
    fps: number;
    bitrate: number;
    packets: number;
    lost: number;
    jitter: number;
  };
  audio?: {
    codec: string;
    bitrate: number;
    packets: number;
    lost: number;
    jitter: number;
  };
  rtt?: number;
};

export class Viewer {
  private feeds: Feed[] = [];
  private selected = new Set<string>();
  private subscriptions = new Map<string, Subscription>();
  private inflight = new Map<string, Promise<void>>();
  private previous = new Map<string, { bytes: number; at: number }>();
  private closed = false;

  private constructor(
    private signal: Signal,
    private device: Device,
    private transport: types.Transport,
    private onFeeds: (feeds: Feed[]) => void,
    private onStreams: () => void,
  ) {}

  static async connect(
    ticket: string,
    onFeeds: (feeds: Feed[]) => void,
    onStreams: () => void,
    onClosed: () => void,
  ): Promise<Viewer> {
    const signal = await Signal.open();
    try {
      const joined = await signal.request<{
        rtpCapabilities: types.RtpCapabilities;
        feeds: Feed[];
      }>({ action: "join", role: "viewer", key: ticket });
      const device = await Device.factory();
      await device.load({ routerRtpCapabilities: joined.rtpCapabilities });
      const options = await signal.request<types.TransportOptions>({
        action: "createTransport",
        direction: "recv",
      });
      const transport = device.createRecvTransport(options);
      transport.on("connect", ({ dtlsParameters }, callback, errback) => {
        signal
          .request({
            action: "connectTransport",
            transportId: transport.id,
            dtlsParameters,
          })
          .then(() => callback(), errback);
      });
      const viewer = new Viewer(signal, device, transport, onFeeds, onStreams);
      signal.onFeeds = (feeds) => viewer.updateFeeds(feeds);
      signal.onClosed = onClosed;
      viewer.updateFeeds(joined.feeds);
      return viewer;
    } catch (error) {
      signal.close();
      throw error;
    }
  }

  private updateFeeds(feeds: Feed[]) {
    this.feeds = feeds;
    for (const [id, subscription] of this.subscriptions) {
      const feed = feeds.find((candidate) => candidate.headsetId === id);
      if (
        !feed ||
        subscription.producers.join() !==
          [feed.video, feed.audio].filter(Boolean).join()
      ) {
        this.unwatch(id);
        this.selected.add(id);
      }
    }
    this.onFeeds(feeds);
    for (const id of this.selected) void this.watch(id).catch(() => undefined);
  }

  stream(id: string): MediaStream | undefined {
    return this.subscriptions.get(id)?.stream;
  }

  async watch(id: string): Promise<void> {
    this.selected.add(id);
    if (this.closed || this.subscriptions.has(id)) return;
    const existing = this.inflight.get(id);
    if (existing) return existing;
    const task = this.subscribe(id).finally(() => this.inflight.delete(id));
    this.inflight.set(id, task);
    return task;
  }

  private async subscribe(id: string) {
    const feed = this.feeds.find((candidate) => candidate.headsetId === id);
    if (!feed) return;
    const consumers: types.Consumer[] = [];
    try {
      for (const producerId of [feed.video, feed.audio]) {
        if (!producerId || !this.selected.has(id) || this.closed) continue;
        const data = await this.signal.request<types.ConsumerOptions>({
          action: "consume",
          transportId: this.transport.id,
          producerId,
          rtpCapabilities: this.device.rtpCapabilities,
        });
        const consumer = await this.transport.consume(data);
        consumers.push(consumer);
        await this.signal.request({
          action: "resumeConsumer",
          consumerId: consumer.id,
        });
      }
      if (!this.selected.has(id) || this.closed) {
        for (const consumer of consumers) consumer.close();
        return;
      }
      this.subscriptions.set(id, {
        consumers,
        stream: new MediaStream(consumers.map((consumer) => consumer.track)),
        producers: [feed.video, feed.audio].filter(
          (value): value is string => !!value,
        ),
      });
      this.onStreams();
    } catch (error) {
      for (const consumer of consumers) consumer.close();
      throw error;
    }
  }

  unwatch(id: string) {
    this.selected.delete(id);
    const subscription = this.subscriptions.get(id);
    if (!subscription) return;
    this.subscriptions.delete(id);
    for (const consumer of subscription.consumers) {
      consumer.close();
      void this.signal
        .request({ action: "closeConsumer", consumerId: consumer.id })
        .catch(() => undefined);
    }
    this.onStreams();
  }

  async stats(id: string): Promise<NerdStats | null> {
    const subscription = this.subscriptions.get(id);
    if (!subscription) return null;
    const result: NerdStats = { connection: this.transport.connectionState };
    for (const consumer of subscription.consumers) {
      const report = await consumer.getStats();
      let inbound: RTCStats | undefined;
      let codec = "Unknown";
      report.forEach((entry) => {
        if (entry.type === "inbound-rtp") inbound = entry;
        if (entry.type === "codec")
          codec = String(
            (entry as RTCStats & { mimeType?: string }).mimeType ?? "Unknown",
          );
      });
      if (!inbound) continue;
      const data = inbound as RTCStats & Record<string, number>;
      const now = performance.now();
      const previous = this.previous.get(consumer.id);
      const bitrate = previous
        ? Math.max(
            0,
            Math.round(
              ((data.bytesReceived - previous.bytes) * 8_000) /
                (now - previous.at),
            ),
          )
        : 0;
      this.previous.set(consumer.id, { bytes: data.bytesReceived, at: now });
      const common = {
        codec,
        bitrate,
        packets: data.packetsReceived ?? 0,
        lost: data.packetsLost ?? 0,
        jitter: data.jitter ?? 0,
      };
      if (consumer.kind === "video") {
        result.video = {
          ...common,
          resolution:
            data.frameWidth && data.frameHeight
              ? `${data.frameWidth} × ${data.frameHeight}`
              : "Waiting",
          fps: data.framesPerSecond ?? 0,
        };
      } else {
        result.audio = common;
      }
    }
    const transportReport = await this.transport.getStats();
    transportReport.forEach((entry) => {
      if (
        entry.type === "candidate-pair" &&
        (entry as RTCStats & { state?: string }).state === "succeeded"
      ) {
        result.rtt = (
          entry as RTCStats & { currentRoundTripTime?: number }
        ).currentRoundTripTime;
      }
    });
    return result;
  }

  close() {
    this.closed = true;
    for (const id of this.subscriptions.keys()) this.unwatch(id);
    this.transport.close();
    this.signal.close();
  }
}
