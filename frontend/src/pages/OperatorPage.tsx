import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { type AdminSettings, type AdminState, type AuthState, api, loginPasskey, type Theme } from "../api";
import { Access } from "../components/Access";
import { Capybara } from "../components/Capybara";
import { Shell } from "../components/Shell";

const fallback: Theme = {
  base: "dark",
  accent: "#5865f2",
  density: "comfortable",
  motion: "subtle",
};

function formatRate(bits?: number) {
  if (bits == null) return "Waiting";
  return bits >= 1_000_000
    ? `${(bits / 1_000_000).toFixed(1)} Mb/s`
    : `${Math.round(bits / 1_000)} kb/s`;
}

function duration(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

type Headset = AdminState["relay"]["headsets"][number];

function advice(headset: Headset) {
  if (headset.capture?.queueBytes != null && headset.capture.queueBytes > 128_000)
    return "Send queue is rising. Auto quality will reduce the target; check Wi-Fi and relay capacity";
  if (headset.capture && (headset.capture.videoEnabled !== headset.videoEnabled || headset.capture.audioEnabled !== headset.audioEnabled))
    return "Waiting for the headset to apply the operator's media change";
  if (!headset.video && !headset.audio)
    return "Connected, but no tracks have reached the relay. Check screen capture consent in QuestRelay";
  if (headset.statsAgeMs == null)
    return "Waiting for the app's first stats sample. If it stays here, check its connection";
  if (headset.statsAgeMs > 12_000)
    return "Stats have stopped updating. Check the headset's Wi-Fi and app status";
  if (headset.video && headset.stats?.video?.packets === 0)
    return "Video track is open, but no video packets have reached the relay";
  if (headset.audio && headset.stats?.audio?.packets === 0)
    return "Audio track is open, but no audio packets have reached the relay";
  if (headset.controlRttMs != null && headset.controlRttMs > 250)
    return "High control RTT. Check Wi-Fi signal and route to the relay";
  return "Media is reaching the relay. Open the public view to check playback and viewer-side loss";
}

function Uptime({ relay }: { relay: AdminState["relay"] }) {
  const history = relay.history ?? [];
  const healthy = history.filter((sample) => sample.healthy).length;
  const percentage = history.length ? (healthy / history.length) * 100 : 0;
  return (
    <div className="uptime-card">
      <div className="uptime-heading">
        <div>
          <span className="eyebrow">Relay history</span>
          <strong>Uptime</strong>
        </div>
        <div className="uptime-value">
          <strong>{percentage.toFixed(1)}%</strong>
          <small>{duration(relay.uptimeSeconds)} since restart</small>
        </div>
      </div>
      <div
        className="uptime-graph"
        role="img"
        aria-label={`${percentage.toFixed(1)} percent availability across ${history.length} observed samples in the last 15 minutes`}
      >
        {Array.from({ length: 180 }, (_, slot) => ({
          slot,
          sample: history[slot - (180 - history.length)],
        })).map(({ slot, sample }) => (
          <i
            key={slot}
            className={sample ? (sample.healthy ? "up" : "down") : "unobserved"}
            title={
              sample
                ? `${new Date(sample.at).toLocaleTimeString()} · ${sample.healthy ? "Healthy" : "Unavailable"} · ${sample.headsets} headsets · ${sample.viewers} viewers`
                : "No observation yet"
            }
          />
        ))}
      </div>
      <div className="uptime-axis">
        <span>Up to 15 minutes ago</span>
        <span>Now · sampled every 5 seconds</span>
      </div>
    </div>
  );
}

function HeadsetRow({ headset, onToggle, busy }: { headset: Headset; onToggle: (video: boolean, audio: boolean) => void; busy: boolean }) {
  const stale = headset.statsAgeMs != null && headset.statsAgeMs > 12_000;
  const video = headset.stats?.video;
  const audio = headset.stats?.audio;
  const peak = Math.max(1, ...headset.history.map((sample) => sample.videoBitrate));
  return (
    <details className="headset-detail">
      <summary className="headset-row">
        <span className="headset-identity">
          <span className="side-avatar">
            {headset.id.slice(0, 1).toUpperCase()}
          </span>
          <span>
            <strong>{headset.id}</strong>
            <small>
              <i className={`signal-dot ${stale ? "warning" : ""}`} />
              {stale
                ? "Stats stale"
                : headset.video || headset.audio
                  ? "Sharing"
                  : "Connected"}{" "}
              · {headset.video ? "Video" : "No video"} ·{" "}
              {headset.audio ? "Audio" : "No audio"}
            </small>
          </span>
        </span>
        <span className="headset-numbers">
          <span>
            <small>Video rate</small>
            <strong>{formatRate(video?.bitrate)}</strong>
          </span>
          <span>
            <small>Audio rate</small>
            <strong>{formatRate(audio?.bitrate)}</strong>
          </span>
          <span>
            <small>Control RTT</small>
            <strong>
              {headset.controlRttMs == null
                ? "—"
                : `${headset.controlRttMs} ms`}
            </strong>
          </span>
          <span>
            <small>Send queue</small>
            <strong>{headset.capture ? `${Math.round(headset.capture.queueBytes / 1000)} KB` : "—"}</strong>
          </span>
        </span>
        <span className="row-chevron" aria-hidden="true">
          ⌄
        </span>
      </summary>
      <div className="headset-nerds">
        <div className="headset-control">
          <div>
            <strong>Publishing controls</strong>
            <small>Changes what this headset sends · screen capture stays active until stopped in QuestRelay</small>
          </div>
          <div className="media-buttons">
            <button type="button" aria-pressed={headset.videoEnabled} disabled={busy}
              onClick={() => onToggle(!headset.videoEnabled, headset.audioEnabled)}>
              {headset.videoEnabled ? "◉ Video on" : "○ Video off"}
            </button>
            <button type="button" aria-pressed={headset.audioEnabled} disabled={busy}
              onClick={() => onToggle(headset.videoEnabled, !headset.audioEnabled)}>
              {headset.audioEnabled ? "◉ Audio on" : "○ Audio off"}
            </button>
          </div>
        </div>
        {headset.capture && (headset.capture.videoEnabled !== headset.videoEnabled || headset.capture.audioEnabled !== headset.audioEnabled) &&
          <p className="control-pending" role="status">Applying on headset…</p>}
        {headset.history.length > 0 && (
          <div className="headset-trend">
            <div><span>Video bitrate · last {Math.min(5, Math.ceil(headset.history.length / 12))} min</span><strong>{formatRate(video?.bitrate)}</strong></div>
            <div className="trend-bars" role="img" aria-label={`Video bitrate history, latest ${formatRate(video?.bitrate)}`}>
              {headset.history.map((sample) => <i key={sample.at} title={`${new Date(sample.at).toLocaleTimeString()} · ${formatRate(sample.videoBitrate)} · ${Math.round(sample.queueBytes / 1000)} KB queued`} style={{ height: `${Math.max(4, Math.round(sample.videoBitrate / peak * 100))}%` }} />)}
            </div>
            <div className="trend-axis"><span>Older</span><span>Latest</span></div>
          </div>
        )}
        <div className="nerd-heading">
          <strong>Stats for nerds</strong>
          <span>Quest → relay · sampled by the app</span>
        </div>
        <div className="nerd-columns">
          <dl>
            <div>
              <dt>Video packets</dt>
              <dd>{video?.packets.toLocaleString() ?? "—"}</dd>
            </div>
            <div>
              <dt>Video bytes</dt>
              <dd>{video?.bytes.toLocaleString() ?? "—"}</dd>
            </div>
            <div><dt>Capture profile</dt><dd>{headset.capture ? `${headset.capture.width} × ${headset.capture.height} · ${headset.capture.fps} fps` : "Waiting for app"}</dd></div>
            <div><dt>Encoder target</dt><dd>{formatRate(headset.capture?.targetBitrateBps)}</dd></div>
            <div>
              <dt>Video producer</dt>
              <dd className="mono">{headset.video ?? "—"}</dd>
            </div>
          </dl>
          <dl>
            <div>
              <dt>Audio packets</dt>
              <dd>{audio?.packets.toLocaleString() ?? "—"}</dd>
            </div>
            <div>
              <dt>Audio bytes</dt>
              <dd>{audio?.bytes.toLocaleString() ?? "—"}</dd>
            </div>
            <div>
              <dt>Audio producer</dt>
              <dd className="mono">{headset.audio ?? "—"}</dd>
            </div>
          </dl>
          <dl>
            <div>
              <dt>Stats age</dt>
              <dd>
                {headset.statsAgeMs == null
                  ? "—"
                  : `${(headset.statsAgeMs / 1000).toFixed(1)} s`}
              </dd>
            </div>
            <div>
              <dt>Control RTT</dt>
              <dd>
                {headset.controlRttMs == null
                  ? "Waiting for ping"
                  : `${headset.controlRttMs} ms`}
              </dd>
            </div>
            <div><dt>Send queue</dt><dd>{headset.capture ? `${headset.capture.queueBytes.toLocaleString()} bytes` : "—"}</dd></div>
            <div><dt>Connected</dt><dd>{duration(headset.connectedSeconds)}</dd></div>
            <div>
              <dt>Glass-to-glass</dt>
              <dd>Not measured</dd>
            </div>
          </dl>
        </div>
        <p className="diagnostic-note">{advice(headset)}</p>
      </div>
    </details>
  );
}

export function OperatorPage() {
  const [state, setState] = useState<AdminState | null>(null);
  const [auth, setAuth] = useState<AuthState>({ enabled: false });
  const [draft, setDraft] = useState<AdminSettings | null>(null);
  const [key, setKey] = useState("");
  const [adminName, setAdminName] = useState("Owner");
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState(false);
  const [probe, setProbe] = useState("");
  const [mutatingId, setMutatingId] = useState("");
  const copiedTimer = useRef(0);
  const signedIn = state !== null;

  const refresh = useCallback(async () => {
    try {
      const value = await api.admin();
      setState(value);
      setDraft((previous) => previous ?? value.settings);
      setChecking(false);
    } catch (error) {
      if ((error as Error).message === "Admin sign-in required") {
        setState(null);
        setDraft(null);
      }
      throw error;
    }
  }, []);

  useEffect(() => {
    void refresh().catch(() => setChecking(false));
    void api.auth().then(setAuth).catch(() => {});
    return () => clearTimeout(copiedTimer.current);
  }, [refresh]);

  useEffect(() => {
    if (!signedIn) return;
    const timer = window.setInterval(() => {
      void refresh().catch((error) => setMessage((error as Error).message));
    }, 5_000);
    return () => clearInterval(timer);
  }, [signedIn, refresh]);

  const signIn = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      await api.login(key);
      setKey("");
      await refresh();
      setAuth(await api.auth());
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggleMedia = async (id: string, video: boolean, audio: boolean) => {
    setMutatingId(id);
    setMessage("");
    try {
      await api.media(id, video, audio);
      await refresh();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setMutatingId("");
    }
  };

  const signInPasskey = async () => {
    setBusy(true);
    setMessage("");
    try {
      await loginPasskey(adminName.trim());
      await refresh();
      setAuth(await api.auth());
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const shareUrl = draft ? `${location.origin}/livestream/${draft.id}` : "";
  const theme = draft?.theme ?? fallback;

  return (
    <Shell
      theme={theme}
      room={draft ?? undefined}
      rooms={state?.rooms}
      onSaved={signedIn ? (settings) => {
        if (settings.id === draft?.id) setDraft(settings);
        void refresh().catch((error) => setMessage((error as Error).message));
      } : undefined}
      report={setMessage}
      active="admin"
      roomId={draft?.id}
      title="Control room"
      subtitle="Feeds, rooms and relay health"
      sidebar={signedIn ? (
        <>
          <p className="nav-caption feeds-caption">Operations</p>
          <div className="side-list">
            <a href="#overview">Overview</a>
            <a href="#headsets">Headsets</a>
            <a href="#rooms">Rooms</a>
            <a href="#access">Admin access</a>
            <a href="#diagnostics">Diagnostics</a>
          </div>
        </>
      ) : undefined}
      actions={
        state ? (
          <>
            <span
              className={`connection-label ${state.relay.healthy ? "online" : ""}`}
            >
              <i />
              {state.relay.healthy ? "Relay healthy" : "Relay unavailable"}
            </span>
            <button
              className="header-button"
              type="button"
              onClick={() =>
                void api.logout().then(() => {
                  setState(null);
                  setDraft(null);
                  setAuth({ enabled: auth.enabled });
                })
              }
            >
              Sign out
            </button>
          </>
        ) : (
          <Link className="header-button" to="/">
            Public lounge
          </Link>
        )
      }
    >
      {checking && (
        <div className="loading-view" role="status">
          Opening the control room…
        </div>
      )}
      {!checking && !state && (
        <div className="login-wrap">
          <div className="login-card">
            <Capybara
              className="card-capybara"
              mood={message ? "oops" : "idle"}
            />
            <h2>Welcome back, operator</h2>
            <p>Sign in to open the control room</p>
            {auth.enabled && <div className="passkey-login">
              <label htmlFor="passkey-admin">Admin name</label>
              <input id="passkey-admin" value={adminName} onChange={(event) => setAdminName(event.target.value)} autoComplete="username webauthn" />
              <button className="primary-button" type="button" disabled={busy || !adminName.trim()} onClick={() => void signInPasskey()}>
                {busy ? "Opening passkey…" : "Sign in with passkey"}
              </button>
              <span>or use the owner recovery key</span>
            </div>}
            <form onSubmit={signIn}>
              <label htmlFor="admin-key">Admin key</label>
              <input
                id="admin-key"
                type="password"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                autoComplete="current-password"
                required
              />
              <button className="primary-button" type="submit" disabled={busy}>
                Open control room
              </button>
            </form>
            {message && (
              <p className="form-message" role="alert">
                {message}
              </p>
            )}
          </div>
        </div>
      )}
      {state && draft && (
        <div className="admin-body">
          {message && (
            <div className="notice" role="status">
              {message}
            </div>
          )}
          <section className="admin-intro" id="overview">
            <div>
              <p className="section-kicker">Room status</p>
              <h2>{draft.title}</h2>
              <p>
                {draft.isPublic
                  ? "Public link"
                  : "Private room · access code required"}{" "}
                · {state.relay.headsets.length} connected headsets
              </p>
            </div>
            <div className="share-box">
              <span>Shareable link</span>
              <code>{shareUrl}</code>
              <div>
                <button
                  type="button"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(shareUrl)
                      .then(() => {
                        setCopied(true);
                        clearTimeout(copiedTimer.current);
                        copiedTimer.current = window.setTimeout(
                          () => setCopied(false),
                          2_000,
                        );
                      })
                      .catch(() => setMessage("Could not copy link"))
                  }
                >
                  {copied ? "Copied ✓" : "Copy link"}
                </button>
                <Link
                  to={`/livestream/${draft.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open view
                </Link>
              </div>
            </div>
          </section>
          <div className="metric-row">
            <div className="metric">
              <span>Headsets live</span>
              <strong>
                {
                  state.relay.headsets.filter(
                    (headset) => headset.video || headset.audio,
                  ).length
                }
              </strong>
              <small>sending video or audio</small>
            </div>
            <div className="metric">
              <span>People watching</span>
              <strong>{state.relay.viewers}</strong>
              <small>active viewer sessions</small>
            </div>
            <div className="metric">
              <span>Highest send queue</span>
              <strong className="metric-word">
                {Math.round(Math.max(0, ...state.relay.headsets.map((headset) => headset.capture?.queueBytes ?? 0)) / 1000)} KB
              </strong>
              <small>below 32 KB is ideal</small>
            </div>
            <div className="metric">
              <span>Media worker</span>
              <strong className="metric-word">
                {state.relay.healthy ? "Ready" : "Offline"}
              </strong>
              <small>
                {state.relay.healthy
                  ? "accepting connections"
                  : "needs attention"}
              </small>
            </div>
          </div>
          <section className="admin-section" id="headsets">
            <div className="section-heading">
              <div>
                <p className="section-kicker">Live signal</p>
                <h2>Headsets</h2>
              </div>
              <button
                type="button"
                className="quiet-button"
                disabled={refreshing}
                onClick={() => {
                  setRefreshing(true);
                  void refresh()
                    .catch((error) => setMessage((error as Error).message))
                    .finally(() => setRefreshing(false));
                }}
              >
                {refreshing ? "Refreshing…" : "Refresh now"}
              </button>
            </div>
            {state.relay.headsets.length ? (
              <div className="headset-list">
                {state.relay.headsets.map((headset) => (
                  <HeadsetRow headset={headset} key={headset.id} busy={mutatingId === headset.id}
                    onToggle={(video, audio) => void toggleMedia(headset.id, video, audio)} />
                ))}
              </div>
            ) : (
              <div className="admin-empty">
                <Capybara className="admin-capybara" mascot={draft.mascot} />
                <div>
                  <h3>No headset feeds</h3>
                  <p>
                    Connected headsets and their media stats will appear here as
                    soon as they start sharing
                  </p>
                </div>
              </div>
            )}
          </section>
          <section className="admin-section" id="rooms">
            <div className="section-heading"><div><h2>Rooms</h2><p>Each headset has its own link and appearance. Use the gear to edit a room</p></div></div>
            <div className="room-list">
              {[{ headsetId: "All headsets", settings: draft }, ...(state.rooms ?? [])].map(({ headsetId, settings }) => {
                const url = `${location.origin}/livestream/${settings.id}`;
                return <div className="room-row" key={settings.id}>
                  <span className="room-mark" style={{ background: settings.theme.accent }} />
                  <div><strong>{settings.title}</strong><small>{headsetId} · {settings.isPublic ? "Anyone with link" : "Access code"}</small></div>
                  <code>/livestream/{settings.id}</code>
                  <button type="button" className="quiet-button" onClick={() => void navigator.clipboard.writeText(url)
                    .then(() => setMessage(`Copied ${settings.title} link`)).catch(() => setMessage("Could not copy link"))}>Copy link</button>
                  <Link to={`/livestream/${settings.id}`} target="_blank" rel="noopener noreferrer" className="quiet-button">Open</Link>
                </div>;
              })}
            </div>
          </section>
          <section className="admin-section" id="diagnostics">
            <div className="section-heading">
              <div>
                <p className="section-kicker">Operations</p>
                <h2>Diagnostics</h2>
              </div>
              <span className="section-hint">
                Live observations, no estimated stream latency
              </span>
            </div>
            <Uptime relay={state.relay} />
            <div className="diagnostics-grid">
              <div>
                <span>Browser → relay health probe</span>
                <strong>{probe || "Not run yet"}</strong>
                <p>
                  Measures an HTTP response through this browser's route to the
                  relay, not media delay
                </p>
              </div>
              <div>
                <span>Media route</span>
                <strong>
                  {state.relay.announcedAddress ?? "Local network"} · UDP/TCP{" "}
                  {state.relay.rtcPort}
                </strong>
                <p>
                  WebRTC viewer transport. A reachable route is needed for
                  internet viewers
                </p>
              </div>
            </div>
            <div className="diagnostic-actions">
              <button
                type="button"
                onClick={() => {
                  const start = performance.now();
                  void fetch("/health", { cache: "no-store" })
                    .then((response) =>
                      setProbe(
                        `${response.ok ? "Healthy" : "Unhealthy"} · ${Math.round(performance.now() - start)} ms HTTP response`,
                      ),
                    )
                    .catch(() => setProbe("Health endpoint unreachable"));
                }}
              >
                Run health probe
              </button>
              <button
                type="button"
                onClick={() => {
                  const report = {
                    at: new Date().toISOString(),
                    room: draft.id,
                    relay: state.relay,
                  };
                  void navigator.clipboard
                    .writeText(JSON.stringify(report, null, 2))
                    .then(() =>
                      setMessage(
                        "Diagnostics copied without access codes or keys",
                      ),
                    )
                    .catch(() => setMessage("Could not copy diagnostics"));
                }}
              >
                Copy diagnostics
              </button>
            </div>
          </section>
          <Access auth={auth} update={(value) => {
            setAuth(value);
            if (!value.currentId) { setState(null); setDraft(null); }
          }} report={setMessage} />
        </div>
      )}
    </Shell>
  );
}
