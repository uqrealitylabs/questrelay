import type { Feed } from "./api";
import type { LocalViewer } from "./localviewer";

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
    recentLossPercent?: number;
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

export type Viewer = Pick<LocalViewer, "stream" | "watch" | "unwatch" | "stats" | "close">;

export const Viewer = {
  async connect(
    ticket: string,
    onFeeds: (feeds: Feed[]) => void,
    onStreams: () => void,
    onClosed: () => void,
  ): Promise<Viewer> {
    const health = await fetch("/health", { cache: "no-store" })
      .then((response) => response.json())
      .catch(() => null) as { media?: string } | null;
    if (health?.media === "Cloudflare Realtime") {
      const { EdgeViewer } = await import("./edgeviewer");
      return EdgeViewer.connect(ticket, onFeeds, onStreams, onClosed);
    }
    const { LocalViewer } = await import("./localviewer");
    return LocalViewer.connect(ticket, onFeeds, onStreams, onClosed);
  },
};
