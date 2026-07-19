import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { StreamStatus } from "@vr-livestream/shared";
import { api } from "../api";
import { StreamPlayer } from "../components/StreamPlayer";

export function AudiencePage() {
  const [streams, setStreams] = useState<StreamStatus[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const list = await api.listStreams();
        if (!cancelled) {
          setStreams(list.filter((s) => s.state === "streaming" || s.state === "starting"));
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="shell">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1 className="brand">Quest LAN Livestream</h1>
        <Link className="nav-link" to="/operator">
          Operator
        </Link>
      </div>
      <p className="sub">Live headset feeds on your LAN — view only.</p>

      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}

      {streams.length === 0 ? (
        <div className="empty" data-testid="audience-empty">
          No active streams. An operator can start up to two headsets.
        </div>
      ) : (
        <div
          className={`grid-streams ${streams.length > 1 ? "dual" : ""}`}
          data-testid="audience-grid"
        >
          {streams.map((s) => (
            <StreamPlayer key={s.deviceId} deviceId={s.deviceId} label={s.label} />
          ))}
        </div>
      )}
    </div>
  );
}
