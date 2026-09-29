import { useEffect, useRef, useState } from "react";
import type { NerdStats, Viewer } from "../viewer";

function rate(bits: number) {
  return bits >= 1_000_000
    ? `${(bits / 1_000_000).toFixed(1)} Mb/s`
    : `${Math.round(bits / 1_000)} kb/s`;
}

export function StreamPlayer({
  id,
  label,
  stream,
  viewer,
  focused,
  pinned,
  muted,
  onFocus,
  onPin,
  onMute,
  onStop,
}: {
  id: string;
  label: string;
  stream: MediaStream;
  viewer: Viewer;
  focused: boolean;
  pinned: boolean;
  muted: boolean;
  onFocus: () => void;
  onPin: () => void;
  onMute: () => void;
  onStop: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [nerds, setNerds] = useState(false);
  const [stats, setStats] = useState<NerdStats | null>(null);

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    element.srcObject = stream;
    void element.play().catch(() => setNeedsGesture(true));
    return () => {
      element.pause();
      element.srcObject = null;
    };
  }, [stream]);

  useEffect(() => {
    if (!nerds) return;
    let active = true;
    const update = () => {
      void viewer
        .stats(id)
        .then((value) => {
          if (active) setStats(value);
        })
        .catch(() => {
          if (active) setStats(null);
        });
    };
    update();
    const timer = window.setInterval(update, 2_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [id, nerds, viewer]);

  const enableSound = () => {
    if (video.current) video.current.muted = !muted;
    onMute();
    if (video.current) {
      void video.current
        .play()
        .then(() => setNeedsGesture(false))
        .catch(() => setNeedsGesture(true));
    }
  };

  return (
    <article
      className={`feed ${focused ? "feed-focus" : ""}`}
      data-testid={`stream-${id}`}
    >
      <div className="feed-screen">
        <video
          ref={video}
          autoPlay
          playsInline
          muted={muted}
          aria-label={`${label} live video`}
        />
        <span className="live-badge">
          <i /> Live
        </span>
        {needsGesture && (
          <button
            className="play-prompt"
            type="button"
            onClick={() => {
              void video.current?.play().then(() => setNeedsGesture(false));
            }}
          >
            Play stream
          </button>
        )}
        {nerds && (
          <section
            className="nerd-overlay"
            aria-label={`${label} stream statistics`}
          >
            <div className="nerd-title">
              <strong>Stats for nerds</strong>
              <span>Live receiver</span>
            </div>
            <dl>
              <div>
                <dt>Connection</dt>
                <dd>{stats?.connection ?? "Connecting"}</dd>
              </div>
              <div>
                <dt>Video</dt>
                <dd>
                  {stats?.video
                    ? `${stats.video.resolution} · ${stats.video.fps} fps`
                    : "Waiting"}
                </dd>
              </div>
              <div>
                <dt>Video codec</dt>
                <dd>{stats?.video?.codec ?? "—"}</dd>
              </div>
              <div>
                <dt>Video rate</dt>
                <dd>{stats?.video ? rate(stats.video.bitrate) : "—"}</dd>
              </div>
              <div>
                <dt>Audio</dt>
                <dd>
                  {stats?.audio
                    ? `${stats.audio.codec} · ${rate(stats.audio.bitrate)}`
                    : "Waiting"}
                </dd>
              </div>
              <div>
                <dt>Packets lost</dt>
                <dd>{(stats?.video?.lost ?? 0) + (stats?.audio?.lost ?? 0)}</dd>
              </div>
              <div>
                <dt>Network RTT</dt>
                <dd>
                  {stats?.rtt == null
                    ? "—"
                    : `${Math.round(stats.rtt * 1_000)} ms`}
                </dd>
              </div>
              <div>
                <dt>Glass-to-glass</dt>
                <dd>Not measured</dd>
              </div>
            </dl>
          </section>
        )}
      </div>
      <div className="feed-footer">
        <div className="feed-person">
          <span className="avatar">{label.slice(0, 1).toUpperCase()}</span>
          <span>
            <strong>{label}</strong>
            <small>Quest headset</small>
          </span>
        </div>
        <div className="feed-actions">
          <button type="button" aria-label={pinned ? `Unpin ${label}` : `Pin ${label}`}
            aria-pressed={pinned} onClick={onPin}>{pinned ? "Pinned" : "Pin"}</button>
          <button
            type="button"
            aria-label={muted ? `Unmute ${label}` : `Mute ${label}`}
            aria-pressed={!muted}
            onClick={enableSound}
          >
            {muted ? "Sound off" : "Sound on"}
          </button>
          <button
            type="button"
            aria-label={`Stats for nerds ${label}`}
            aria-pressed={nerds}
            onClick={() => setNerds(!nerds)}
          >
            Stats
          </button>
          <button
            type="button"
            aria-label={focused ? `Return ${label} to grid` : `Focus ${label}`}
            aria-pressed={focused}
            onClick={onFocus}
          >
            {focused ? "Grid" : "Focus"}
          </button>
          <button
            type="button"
            aria-label={`Stop watching ${label}`}
            onClick={onStop}
          >
            Leave
          </button>
        </div>
      </div>
    </article>
  );
}
