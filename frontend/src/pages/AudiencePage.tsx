import type { StreamStatus } from "@questrelay/shared";
import { type ComponentType, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { StreamPlayer } from "../components/StreamPlayer";

const preferenceKey = "questrelay.appearance";
const defaults = { theme: "dark", density: "comfortable", accent: "violet" };

function readPreferences() {
  try {
    const saved = JSON.parse(
      window.localStorage.getItem(preferenceKey) ?? "null",
    );
    return {
      theme: saved?.theme === "light" ? "light" : defaults.theme,
      density: saved?.density === "compact" ? "compact" : defaults.density,
      accent: saved?.accent === "blue" ? "blue" : defaults.accent,
    };
  } catch {
    return defaults;
  }
}

function Icon({
  name,
}: {
  name: "headset" | "sound" | "settings" | "end" | "grid" | "screen";
}) {
  const paths = {
    headset:
      "M4 13v-1a8 8 0 0 1 16 0v1M4 12H3v7h4v-7H4m16 0h1v7h-4v-7h3M17 19c0 2-2 3-5 3",
    sound: "M11 5 6 9H3v6h3l5 4V5m4 4 6 6m0-6-6 6",
    settings: "M4 7h16M4 17h16M8 4v6m8 4v6",
    grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
    screen: "M3 4h18v13H3zM8 21h8m-4-4v4",
    end: "M4 16v-4c5-4 11-4 16 0v4h-5v-3H9v3H4Z",
  };
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}

export function AudiencePage({
  Player = StreamPlayer,
}: {
  Player?: ComponentType<{ deviceId: string; label: string }>;
}) {
  const [streams, setStreams] = useState<StreamStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [watching, setWatching] = useState<string[]>([]);
  const [focused, setFocused] = useState<string | null>(null);
  const [preferences, setPreferences] = useState(readPreferences);
  const [storageError, setStorageError] = useState(false);

  useEffect(() => {
    try {
      window.localStorage.setItem(preferenceKey, JSON.stringify(preferences));
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }, [preferences]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const list = await api.listStreams(controller.signal);
        if (!cancelled) {
          const active = list.filter(
            (s) => s.state === "streaming" || s.state === "starting",
          );
          const activeIds = new Set(active.map((stream) => stream.deviceId));
          setStreams(active);
          setWatching((ids) => ids.filter((id) => activeIds.has(id)));
          setFocused((id) => (id !== null && activeIds.has(id) ? id : null));
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) timer = setTimeout(tick, 2000);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, []);

  const stopWatching = (id: string) => {
    setWatching((ids) => ids.filter((other) => other !== id));
    if (focused === id) setFocused(null);
  };

  return (
    <div
      className="room"
      data-theme={preferences.theme}
      data-density={preferences.density}
      data-accent={preferences.accent}
    >
      <div className="room-titlebar">
        <Icon name="headset" />
        <span>QuestRelay</span>
      </div>
      <nav className="room-rail" aria-label="Main navigation">
        <Link
          to="/"
          className="room-rail-home"
          aria-label="QuestRelay home"
          title="QuestRelay"
        >
          <Icon name="headset" />
        </Link>
        <span className="room-rail-divider" />
        <a
          href="#stage"
          className="room-rail-session"
          aria-label="Headset lounge"
          title="Headset lounge"
          aria-current="page"
        >
          Q
        </a>
        <Link
          to="/operator"
          className="room-rail-manage"
          aria-label="Manage headsets"
          title="Manage headsets"
        >
          +
        </Link>
      </nav>
      <aside className="room-sidebar" aria-label="Session navigation">
        <Link className="room-brand" to="/" aria-label="QuestRelay home">
          QuestRelay{" "}
          <span className="room-brand-chevron" aria-hidden="true">
            ⌄
          </span>
        </Link>
        <div className="room-sidebar-body">
          <div className="room-section-label">⌄&nbsp; Your channels</div>
          <a className="room-channel" href="#stage" aria-current="page">
            <Icon name="headset" /> Headset lounge
            <span className="room-count">{streams.length}</span>
          </a>
          <ul className="room-members" aria-label="Headsets">
            {streams.map((stream) => (
              <li key={stream.deviceId}>
                <span className="room-avatar small" aria-hidden="true">
                  {stream.label.slice(0, 1).toUpperCase()}
                </span>
                <span className="room-member-name" title={stream.label}>
                  {stream.label}
                </span>
                <span className="room-live">
                  {stream.state === "starting" ? "Starting" : "Live"}
                </span>
              </li>
            ))}
          </ul>
          {streams.length === 0 && (
            <p className="room-sidebar-hint">
              Headsets will appear here when an operator starts a stream
            </p>
          )}
          <Link className="room-operator" to="/operator">
            <span aria-hidden="true">＋</span> Manage headsets
          </Link>
        </div>
        <div className="room-session-status">
          <span
            className={`room-status-dot ${error ? "warning" : ""}`}
            aria-hidden="true"
          />
          <div>
            <strong>
              {error ? "Connection interrupted" : "Audience view"}
            </strong>
            <small>Headset lounge</small>
          </div>
        </div>
        <div className="room-profile">
          <span className="room-avatar small" aria-hidden="true">
            Y
          </span>
          <div>
            <strong>You</strong>
            <small>Viewer</small>
          </div>
        </div>
      </aside>

      <main className="room-main" id="stage">
        <header className="room-header">
          <div className="room-heading">
            <span className="room-channel-icon" aria-hidden="true">
              <Icon name="headset" />
            </span>
            <div>
              <h1>Headset lounge</h1>
              <p>
                {streams.length} {streams.length === 1 ? "headset" : "headsets"}{" "}
                · {watching.length} watching
              </p>
            </div>
          </div>
          <details className="room-settings">
            <summary>
              <Icon name="settings" />
              <span>Appearance</span>
            </summary>
            <div className="room-settings-panel">
              <h2>Make it yours</h2>
              <label>
                Theme
                <select
                  value={preferences.theme}
                  onChange={(e) =>
                    setPreferences({ ...preferences, theme: e.target.value })
                  }
                >
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </select>
              </label>
              <label>
                Tile density
                <select
                  value={preferences.density}
                  onChange={(e) =>
                    setPreferences({ ...preferences, density: e.target.value })
                  }
                >
                  <option value="comfortable">Comfortable</option>
                  <option value="compact">Compact</option>
                </select>
              </label>
              <label>
                Accent colour
                <select
                  value={preferences.accent}
                  onChange={(e) =>
                    setPreferences({ ...preferences, accent: e.target.value })
                  }
                >
                  <option value="violet">Violet</option>
                  <option value="blue">Blue</option>
                </select>
              </label>
              <button type="button" onClick={() => setPreferences(defaults)}>
                Reset appearance
              </button>
              <p role="status">
                {storageError
                  ? "Settings apply here, but this browser could not save them"
                  : "Saved on this browser"}
              </p>
            </div>
          </details>
        </header>

        {error && (
          <p className="room-error" role="alert">
            Couldn’t refresh headsets: {error}. Retrying automatically
          </p>
        )}
        <section className="room-stage" aria-label="Headset feeds">
          {streams.length === 0 ? (
            <div className="room-empty" data-testid="audience-empty">
              <div className="room-empty-symbol" aria-hidden="true">
                <Icon name="headset" />
              </div>
              <h2>No one’s streaming yet</h2>
              <p>Start a stream from Manage headsets to join the lounge</p>
              <Link to="/operator">
                Manage headsets <span aria-hidden="true">→</span>
              </Link>
            </div>
          ) : (
            <div
              className={`room-grid ${focused ? "has-focus" : ""}`}
              data-testid="audience-grid"
            >
              {streams.map((stream) => {
                const isWatching = watching.includes(stream.deviceId);
                return (
                  <article
                    className={`room-feed ${focused === stream.deviceId ? "is-focused" : ""}`}
                    key={stream.deviceId}
                    aria-label={stream.label}
                  >
                    {isWatching ? (
                      <Player deviceId={stream.deviceId} label={stream.label} />
                    ) : (
                      <div className="room-feed-preview">
                        <span className="room-avatar" aria-hidden="true">
                          {stream.label.slice(0, 1).toUpperCase()}
                        </span>
                        <button
                          type="button"
                          className="room-watch"
                          onClick={() =>
                            setWatching((ids) => [...ids, stream.deviceId])
                          }
                        >
                          Watch stream
                          <span className="sr-only"> from {stream.label}</span>
                        </button>
                      </div>
                    )}
                    <span className="room-feed-status">
                      {stream.state === "starting" ? "Starting" : "Live"}
                    </span>
                    <div className="room-feed-bar">
                      <strong>{stream.label}</strong>

                      {isWatching && (
                        <div className="room-feed-actions">
                          <button
                            type="button"
                            aria-label={`Focus ${stream.label}`}
                            aria-pressed={focused === stream.deviceId}
                            onClick={() =>
                              setFocused(
                                focused === stream.deviceId
                                  ? null
                                  : stream.deviceId,
                              )
                            }
                          >
                            Focus
                          </button>
                          <button
                            type="button"
                            aria-label={`Stop watching ${stream.label}`}
                            onClick={() => stopWatching(stream.deviceId)}
                          >
                            Stop
                          </button>
                        </div>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
        <footer className="room-controls">
          <div className="room-source-note">
            <span>Video only</span>
          </div>
          <div className="room-control-buttons">
            <div className="room-control-group">
              <button
                type="button"
                disabled
                aria-label="Audio unavailable"
                title="Audio is unavailable from the current source"
              >
                <Icon name="sound" />
              </button>
              <button
                type="button"
                title="Watch all streams"
                aria-label="Watch all streams"
                disabled={streams.length === 0}
                onClick={() =>
                  setWatching(streams.map((stream) => stream.deviceId))
                }
              >
                <Icon name="screen" />
              </button>
            </div>
            <button
              type="button"
              title="Return to grid"
              aria-label="Return to grid"
              disabled={!focused}
              onClick={() => setFocused(null)}
            >
              <Icon name="grid" />
            </button>
            <button
              type="button"
              className="room-stop"
              aria-label="Stop watching"
              title="Stop watching"
              disabled={watching.length === 0}
              onClick={() => {
                setWatching([]);
                setFocused(null);
              }}
            >
              <Icon name="end" />
            </button>
          </div>
          <span className="room-latency">Latency not measured</span>
        </footer>
      </main>
    </div>
  );
}
