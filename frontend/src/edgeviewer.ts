import type { Feed } from "./api";
import type { NerdStats } from "./viewer";

async function post<T>(path: string, body: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `Relay returned HTTP ${response.status}`);
  return value as T;
}

async function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return;
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", changed);
      reject(new Error("ICE gathering timed out"));
    }, 10_000);
    const changed = () => {
      if (pc.iceGatheringState !== "complete") return;
      clearTimeout(timeout);
      pc.removeEventListener("icegatheringstatechange", changed);
      resolve();
    };
    pc.addEventListener("icegatheringstatechange", changed);
  });
}

type Subscription = {
  pc: RTCPeerConnection;
  stream: MediaStream;
  controller: AbortController;
  sessionId: string;
};

export class EdgeViewer {
  private feeds: Feed[] = [];
  private selected = new Set<string>();
  private subscriptions = new Map<string, Subscription>();
  private inflight = new Map<string, Promise<void>>();
  private pending = new Map<string, AbortController>();
  private previous = new Map<string, { bytes: number; packets: number; lost: number; at: number }>();
  private timer = 0;
  private closed = false;

  private constructor(
    private token: string,
    private onFeeds: (feeds: Feed[]) => void,
    private onStreams: () => void,
    private onClosed: () => void,
  ) {}

  static async connect(
    ticket: string,
    onFeeds: (feeds: Feed[]) => void,
    onStreams: () => void,
    onClosed: () => void,
  ): Promise<EdgeViewer> {
    const joined = await post<{ token: string; feeds: Feed[] }>("/api/viewer/join", { ticket });
    const viewer = new EdgeViewer(joined.token, onFeeds, onStreams, onClosed);
    viewer.updateFeeds(joined.feeds);
    viewer.timer = window.setInterval(() => void viewer.refresh(), 5_000);
    return viewer;
  }

  private async refresh() {
    if (this.closed) return;
    try {
      const { feeds } = await post<{ feeds: Feed[] }>("/api/viewer/feeds", { token: this.token });
      if (!this.closed) this.updateFeeds(feeds);
    } catch {
      this.close();
      this.onClosed();
    }
  }

  private updateFeeds(feeds: Feed[]) {
    const previous = this.feeds;
    this.feeds = feeds;
    for (const id of this.subscriptions.keys()) {
      const old = previous.find((feed) => feed.headsetId === id);
      const current = feeds.find((feed) => feed.headsetId === id);
      if (!current || old?.video !== current.video || old?.audio !== current.audio) {
        this.unwatch(id);
        this.selected.add(id);
      }
    }
    this.onFeeds(feeds);
    for (const id of this.selected) {
      if (feeds.some((feed) => feed.headsetId === id)) void this.watch(id).catch(() => undefined);
    }
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
    const feed = this.feeds.find((item) => item.headsetId === id);
    if (!feed || (!feed.video && !feed.audio)) return;
    const controller = new AbortController();
    this.pending.set(id, controller);
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
      bundlePolicy: "max-bundle",
    });
    const stream = new MediaStream();
    let sessionId = "";
    pc.ontrack = ({ track }) => {
      stream.addTrack(track);
      this.onStreams();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        if (this.subscriptions.get(id)?.pc === pc) {
          this.unwatch(id);
          this.selected.add(id);
        }
      }
    };
    try {
      const offer = await post<{ sessionId: string; sessionDescription: RTCSessionDescriptionInit }>(
        "/api/viewer/watch", { token: this.token, headsetId: id }, controller.signal,
      );
      sessionId = offer.sessionId;
      if (this.closed || !this.selected.has(id)) return;
      await pc.setRemoteDescription(offer.sessionDescription);
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered(pc);
      if (this.closed || !this.selected.has(id) || !pc.localDescription) return;
      await post("/api/viewer/answer", {
        token: this.token,
        headsetId: id,
        sessionId: offer.sessionId,
        sessionDescription: { type: "answer", sdp: pc.localDescription.sdp },
      }, controller.signal);
      if (this.closed || !this.selected.has(id)) return;
      this.subscriptions.set(id, { pc, stream, controller, sessionId: offer.sessionId });
      this.onStreams();
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      if (this.pending.get(id) === controller) this.pending.delete(id);
      if (this.subscriptions.get(id)?.pc !== pc) {
        controller.abort();
        pc.close();
        if (sessionId) void post("/api/viewer/leave", {
          token: this.token, headsetId: id, sessionId,
        }).catch(() => undefined);
      }
    }
  }

  unwatch(id: string) {
    this.selected.delete(id);
    this.pending.get(id)?.abort();
    const subscription = this.subscriptions.get(id);
    if (!subscription) return;
    this.subscriptions.delete(id);
    subscription.controller.abort();
    subscription.pc.close();
    void post("/api/viewer/leave", {
      token: this.token, headsetId: id, sessionId: subscription.sessionId,
    }).catch(() => undefined);
    this.onStreams();
  }

  async stats(id: string): Promise<NerdStats | null> {
    const subscription = this.subscriptions.get(id);
    if (!subscription) return null;
    const result: NerdStats = { connection: subscription.pc.connectionState };
    const report = await subscription.pc.getStats();
    report.forEach((entry) => {
      if (entry.type === "candidate-pair" && entry.state === "succeeded")
        result.rtt = entry.currentRoundTripTime;
      if (entry.type !== "inbound-rtp") return;
      const codec = entry.codecId ? report.get(entry.codecId)?.mimeType ?? "Unknown" : "Unknown";
      const now = performance.now();
      const prior = this.previous.get(entry.id);
      const bitrate = prior ? Math.max(0, Math.round((entry.bytesReceived - prior.bytes) * 8_000 / (now - prior.at))) : 0;
      const packets = entry.packetsReceived ?? 0;
      const lost = entry.packetsLost ?? 0;
      const deliveredNow = prior ? Math.max(0, packets - prior.packets) : 0;
      const lostNow = prior ? Math.max(0, lost - prior.lost) : 0;
      const recentLossPercent = deliveredNow + lostNow > 0
        ? Math.round(100 * lostNow / (deliveredNow + lostNow)) : undefined;
      this.previous.set(entry.id, { bytes: entry.bytesReceived, packets, lost, at: now });
      const common = { codec, bitrate, packets: entry.packetsReceived ?? 0,
        lost, jitter: entry.jitter ?? 0 };
      if (entry.kind === "video") result.video = {
        ...common,
        recentLossPercent,
        resolution: entry.frameWidth && entry.frameHeight
          ? `${entry.frameWidth} × ${entry.frameHeight}` : "Waiting",
        fps: entry.framesPerSecond ?? 0,
      };
      else if (entry.kind === "audio") result.audio = common;
    });
    return result;
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const id of this.subscriptions.keys()) this.unwatch(id);
  }
}
