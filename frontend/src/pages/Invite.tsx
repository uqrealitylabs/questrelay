import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { registerPasskey } from "../api";
import { Capybara } from "../components/Capybara";
import { Shell } from "../components/Shell";

export function Invite() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <Shell theme={{ base: "dark", accent: "#5865f2", density: "comfortable", motion: "subtle" }}
    active="admin" title="Join the control room" subtitle="Your own secure admin access">
    <div className="login-wrap"><div className="login-card invite-card">
      <Capybara className="card-capybara" mood={error ? "oops" : "idle"} />
      <h2>Make yourself at home</h2>
      <p>This invitation lets you create a personal passkey. Your device unlock will sign you in next time</p>
      <form onSubmit={(event) => { event.preventDefault(); if (!token) return; setBusy(true); setError("");
        void registerPasskey(label, token).then(() => navigate("/admin", { replace: true }))
          .catch((problem) => setError((problem as Error).message)).finally(() => setBusy(false));
      }}>
        <label htmlFor="invite-label">Passkey name</label>
        <input id="invite-label" value={label} onChange={(event) => setLabel(event.target.value)}
          placeholder="My MacBook" minLength={2} maxLength={40} required />
        <button className="primary-button" type="submit" disabled={busy}>{busy ? "Creating passkey…" : "Create my passkey"}</button>
      </form>
      {error && <p className="form-message" role="alert">{error}</p>}
      <Link className="invite-back" to="/admin">Back to sign-in</Link>
    </div></div>
  </Shell>;
}
