import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Feed, type Mascot, type RoomSettings } from "../api";
import { Capybara } from "../components/Capybara";
import { Shell } from "../components/Shell";
import { StreamPlayer } from "../components/StreamPlayer";
import type { Viewer } from "../viewer";

const fallback = {
  base: "dark" as const,
  accent: "#5865f2",
  density: "comfortable" as const,
  motion: "subtle" as const,
};

function readPins(roomId?: string): string[] {
  if (!roomId) return [];
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(`questrelay-pins:${roomId}`) ?? "[]");
    return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id)).slice(0, 16) : [];
  } catch { return []; }
}

function FeedDock({ feeds, pinned, selected, watch, togglePin }: {
  feeds: Feed[]; pinned: string[]; selected: string[];
  watch: (id: string) => void; togglePin: (id: string) => void;
}) {
  return <div className="side-feeds">
    {feeds.map((feed) => {
      const live = Boolean(feed.video || feed.audio);
      const isPinned = pinned.includes(feed.headsetId);
      return <div className={`side-feed-row ${live ? "" : "offline"}`} key={feed.headsetId}>
        <button type="button" className="side-watch" aria-pressed={selected.includes(feed.headsetId)}
          onClick={() => watch(feed.headsetId)} disabled={!live}
          aria-label={`Watch ${feed.headsetId}`}>
          <span className="side-avatar">{feed.headsetId.slice(0, 1).toUpperCase()}</span>
          <span>{feed.headsetId}</span><i title={live ? "Live" : "Offline"} />
        </button>
        <button type="button" className="side-pin" aria-label={isPinned ? `Unpin ${feed.headsetId}` : `Pin ${feed.headsetId}`}
          aria-pressed={isPinned} onClick={() => togglePin(feed.headsetId)} title={isPinned ? "Unpin" : "Pin"}>
          {isPinned ? "◆" : "◇"}
        </button>
      </div>;
    })}
    {!feeds.length && <p className="sidebar-hint">Headsets appear here when they start sharing</p>}
  </div>;
}

function EmptyStage({ title, prompt, mascot }: { title: string; prompt: string; mascot?: Mascot }) {
  const frame = useRef<HTMLDivElement>(null);
  const animation = useRef(0);
  useEffect(() => () => cancelAnimationFrame(animation.current), []);
  return (
    <div
      className="empty-stage"
      ref={frame}
      onPointerMove={(event) => {
        if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        cancelAnimationFrame(animation.current);
        const rect = event.currentTarget.getBoundingClientRect();
        const x = (event.clientX - rect.left - rect.width / 2) / rect.width;
        const y = (event.clientY - rect.top - rect.height / 2) / rect.height;
        animation.current = requestAnimationFrame(() => {
          frame.current?.style.setProperty("--look-x", `${x * 14}px`);
          frame.current?.style.setProperty("--look-y", `${y * 10}px`);
        });
      }}
      onPointerLeave={() => {
        frame.current?.style.setProperty("--look-x", "0px");
        frame.current?.style.setProperty("--look-y", "0px");
      }}
    >
      <Capybara className="empty-capybara" mascot={mascot} />
      <h2>{title}</h2>
      <p>{prompt}</p>
    </div>
  );
}

export function HomePage() {
  const [room, setRoom] = useState<RoomSettings | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api
      .site()
      .then(setRoom)
      .catch((cause) => setError((cause as Error).message));
  }, []);
  return (
    <Shell
      theme={room?.theme ?? fallback}
      room={room ?? undefined}
      active="public"
      title="Headset lounge"
      subtitle="QuestRelay"
      actions={
        <Link className="header-button" to="/admin">
          Admin
        </Link>
      }
    >
      <div className="home-content">
        <EmptyStage
          title="Pull up a seat"
          prompt="Live Quest feeds appear here with game audio, ready to watch together"
          mascot={room?.mascot}
        />
        {room ? (
          <Link className="primary-button" to={`/livestream/${room.id}`}>
            Open the lounge
          </Link>
        ) : (
          <p role={error ? "alert" : "status"}>
            {error || "Finding your room…"}
          </p>
        )}
      </div>
    </Shell>
  );
}

export function AudiencePage() {
  const { id } = useParams();
  const [room, setRoom] = useState<RoomSettings | null>(null);
  const [accessCode, setAccessCode] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [selected, setSelected] = useState<string[]>(() => readPins(id));
  const [pinned, setPinned] = useState<string[]>(() => readPins(id));
  const [audible, setAudible] = useState<string[]>([]);
  const [layout, setLayout] = useState<"grid" | "compact" | "theatre">("grid");
  const [focused, setFocused] = useState<string | null>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [, setRevision] = useState(0);
  const [connection, setConnection] = useState("Finding room");
  const [error, setError] = useState("");
  const viewerRef = useRef<Viewer | null>(null);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    const load = async () => {
      try {
        const details = await api.room(id);
        if (!alive) return;
        setRoom(details);
        if (details.isPublic) setUnlocked(true);
        setError("");
      } catch (cause) {
        if (alive) setError((cause as Error).message);
      }
    };
    void load();
    const timer = window.setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [id]);

  useEffect(() => {
    const feedId = room?.headsetId;
    if (feedId) setSelected((ids) => ids.includes(feedId) ? ids : [...ids, feedId]);
  }, [room?.headsetId]);

  useEffect(() => {
    if (!id || !unlocked) return;
    let alive = true;
    let retry: number;
    const connect = async () => {
      setConnection("Connecting");
      try {
        const { ticket } = await api.ticket(id, accessCode);
        if (!alive) return;
        const { Viewer } = await import("../viewer");
        const instance = await Viewer.connect(
          ticket,
          setFeeds,
          () => setRevision((value) => value + 1),
          () => {
            if (!alive) return;
            viewerRef.current = null;
            setViewer(null);
            setConnection("Reconnecting");
            retry = window.setTimeout(connect, 2_000);
          },
        );
        if (!alive) {
          instance.close();
          return;
        }
        viewerRef.current = instance;
        setViewer(instance);
        setConnection("Connected");
        setError("");
      } catch (cause) {
        if (!alive) return;
        const message = (cause as Error).message;
        setError(message);
        if (/access code|access attempts|Room not found/i.test(message)) {
          setUnlocked(false);
          setConnection("Access required");
        } else {
          setConnection("Reconnecting");
          retry = window.setTimeout(connect, 2_000);
        }
      }
    };
    void connect();
    return () => {
      alive = false;
      clearTimeout(retry);
      viewerRef.current?.close();
      viewerRef.current = null;
    };
  }, [id, unlocked, accessCode]);

  useEffect(() => {
    if (!viewer) return;
    for (const feedId of selected) {
      void viewer
        .watch(feedId)
        .catch((cause) => setError((cause as Error).message));
    }
  }, [viewer, selected]);

  const leave = (feedId: string) => {
    viewer?.unwatch(feedId);
    setSelected((ids) => ids.filter((candidate) => candidate !== feedId));
    setAudible((ids) => ids.filter((candidate) => candidate !== feedId));
    if (focused === feedId) setFocused(null);
  };
  const watch = (feedId: string) =>
    setSelected((ids) => (ids.includes(feedId) ? ids : [...ids, feedId]));
  const active = feeds.filter((feed) => feed.video || feed.audio);
  const waiting = [...new Set([...pinned, ...(room?.headsetId ? [room.headsetId] : [])])];
  const visible = [...active, ...waiting.filter((feedId) => !active.some((feed) => feed.headsetId === feedId))
    .map((headsetId) => ({ headsetId, video: null, audio: null }))].sort((left, right) => {
      const leftPin = pinned.indexOf(left.headsetId);
      const rightPin = pinned.indexOf(right.headsetId);
      if (leftPin !== -1 || rightPin !== -1) return (leftPin === -1 ? 999 : leftPin) - (rightPin === -1 ? 999 : rightPin);
      return Number(selected.includes(right.headsetId)) - Number(selected.includes(left.headsetId));
    });
  const togglePin = (feedId: string) => {
    const next = pinned.includes(feedId) ? pinned.filter((id) => id !== feedId) : [...pinned, feedId];
    setPinned(next);
    try { localStorage.setItem(`questrelay-pins:${id}`, JSON.stringify(next)); } catch { /* Browsing still works without storage */ }
    if (!pinned.includes(feedId) && active.some((feed) => feed.headsetId === feedId)) watch(feedId);
  };
  const watching = selected.filter((feedId) =>
    active.some((feed) => feed.headsetId === feedId),
  ).length;
  const shareUrl = location.href;

  return (
    <Shell
      theme={room?.theme ?? fallback}
      room={room ?? undefined}
      active="public"
      roomId={id}
      title={room?.title ?? "Headset lounge"}
      subtitle={`${active.length} ${active.length === 1 ? "headset" : "headsets"} live · ${watching} watching`}
      sidebar={
        <>
          <p className="nav-caption feeds-caption">
            Live headsets <span>{active.length}</span>
          </p>
          <FeedDock feeds={visible} pinned={pinned} selected={selected} watch={watch} togglePin={togglePin} />
          <p className="sidebar-hint">Pin a feed to keep it here and reconnect automatically</p>
        </>
      }
      actions={
        <>
          <span
            className={`connection-label ${connection === "Connected" ? "online" : ""}`}
          >
            <i />
            {connection}
          </span>
          <button
            className="header-button"
            type="button"
            onClick={() =>
              void navigator.clipboard
                .writeText(shareUrl)
                .catch(() => setError("Could not copy link"))
            }
          >
            Copy link
          </button>
        </>
      }
    >
      {error && (
        <div className="notice" role="alert">
          {error}
        </div>
      )}
      {!room && !error && (
        <div className="loading-view" role="status">
          Finding the room…
        </div>
      )}
      {room && !unlocked && !room.isPublic && (
        <div className="access-wrap">
          <div className="access-card">
            <Capybara className="card-capybara" mascot={room.mascot} />
            <h2>Welcome to {room.title}</h2>
            <p>
              This lounge is private. Ask the room admin for its access code
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                setUnlocked(true);
                setError("");
              }}
            >
              <label htmlFor="access-code">Access code</label>
              <input
                id="access-code"
                type="password"
                value={accessCode}
                onChange={(event) => setAccessCode(event.target.value)}
                autoComplete="off"
                required
              />
              <button className="primary-button" type="submit">
                Join the lounge
              </button>
            </form>
          </div>
        </div>
      )}
      {room && unlocked && (
        <>
          <div className="mobile-feeds" aria-label="Live feed shortcuts">
            <FeedDock feeds={visible} pinned={pinned} selected={selected} watch={watch} togglePin={togglePin} />
          </div>
          {visible.length === 0 ? (
            <EmptyStage
              title="The lounge is quiet"
              prompt="Wake the headset, open QuestRelay, and tap Start sharing. Sharing stops when Quest sleeps"
              mascot={room.mascot}
            />
          ) : (
            <section
              className={`feed-grid layout-${layout} ${focused ? "has-focus" : ""}`}
              aria-label="Live Quest feeds"
              data-testid="audience-grid"
            >
              {visible.map((feed) => {
                const watching = selected.includes(feed.headsetId);
                const stream = viewer?.stream(feed.headsetId);
                const live = Boolean(feed.video || feed.audio);
                if (focused && focused !== feed.headsetId) return null;
                return watching && stream && viewer ? (
                  <StreamPlayer
                    key={feed.headsetId}
                    id={feed.headsetId}
                    label={feed.headsetId}
                    stream={stream}
                    viewer={viewer}
                    focused={focused === feed.headsetId}
                    pinned={pinned.includes(feed.headsetId)}
                    muted={!audible.includes(feed.headsetId)}
                    onPin={() => togglePin(feed.headsetId)}
                    onMute={() => setAudible((ids) => ids.includes(feed.headsetId) ? ids.filter((id) => id !== feed.headsetId) : [...ids, feed.headsetId])}
                    onFocus={() =>
                      setFocused(
                        focused === feed.headsetId ? null : feed.headsetId,
                      )
                    }
                    onStop={() => leave(feed.headsetId)}
                  />
                ) : (
                  <article key={feed.headsetId} className={`feed feed-preview ${live ? "" : "feed-offline"}`}>
                    <div className="preview-body">
                      <span className="preview-avatar">
                        {feed.headsetId.slice(0, 1).toUpperCase()}
                      </span>
                      <h2>{feed.headsetId}</h2>
                      <p>
                        {!live ? "Pinned · waiting for the headset" : watching
                          ? "Connecting video and audio…"
                          : "Sharing a Quest view"}
                      </p>
                      <button
                        type="button"
                        className="watch-button"
                        onClick={() => watch(feed.headsetId)}
                        disabled={!live || watching || !viewer}
                      >
                        {!live ? "Offline" : watching ? "Connecting…" : "Watch stream"}
                      </button>
                    </div>
                    <div className="preview-footer">
                      <span>
                        <i className="live-dot" /> {live ? "Live now" : "Waiting to reconnect"}
                      </span>
                      <button type="button" className="preview-pin" aria-pressed={pinned.includes(feed.headsetId)} onClick={() => togglePin(feed.headsetId)}>
                        {pinned.includes(feed.headsetId) ? "◆ Pinned" : "◇ Pin"}
                      </button>
                    </div>
                  </article>
                );
              })}
            </section>
          )}
          <fieldset className="control-dock" aria-label="Viewing controls">
            <span className="dock-room">
              <i />
              {connection}
            </span>
            <span className="dock-divider" />
            <button
              type="button"
              onClick={() => setSelected(active.map((feed) => feed.headsetId))}
              disabled={!active.length}
            >
              Watch all
            </button>
            <label className="dock-layout">Layout
              <select aria-label="Viewing layout" value={layout} onChange={(event) => { setLayout(event.target.value as typeof layout); setFocused(null); }}>
                <option value="grid">Grid</option><option value="compact">Compact</option><option value="theatre">Theatre</option>
              </select>
            </label>
            <button type="button" onClick={() => setAudible(audible.length ? [] : selected.filter((feedId) => active.some((feed) => feed.headsetId === feedId)))}
              disabled={!watching}>{audible.length ? "Mute all" : "Sound on"}</button>
            <button
              type="button"
              className="dock-leave"
              onClick={() => {
                for (const feedId of selected) viewer?.unwatch(feedId);
                setSelected([]);
                setFocused(null);
              }}
              disabled={!selected.length}
            >
              Leave streams
            </button>
          </fieldset>
        </>
      )}
    </Shell>
  );
}
