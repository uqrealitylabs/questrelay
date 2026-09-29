import { useState } from "react";
import { type AuthState, api, registerPasskey } from "../api";

export function Access({ auth, update, report }: {
  auth: AuthState;
  update: (value: AuthState) => void;
  report: (message: string) => void;
}) {
  const [label, setLabel] = useState("");
  const [newAdmin, setNewAdmin] = useState("");
  const [names, setNames] = useState<Record<string, string>>({});
  const [invite, setInvite] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = async () => update(await api.auth());
  const run = async (task: () => Promise<unknown>) => {
    setBusy(true);
    report("");
    try { await task(); await refresh(); }
    catch (error) { report((error as Error).message); }
    finally { setBusy(false); }
  };
  const me = auth.accounts?.find((account) => account.id === auth.currentId);
  const inviteUrl = invite ? `${location.origin}/admin/invite/${invite}` : "";

  return (
    <section className="admin-section" id="access">
      <div className="section-heading">
        <div><p className="section-kicker">Security</p><h2>Admin access</h2></div>
        <span className="section-hint">Individual passkeys · owner recovery key</span>
      </div>
      {!auth.enabled ? (
        <div className="access-hint">Set <code>QUESTRELAY_WEBAUTHN_ORIGIN</code> to this site's HTTPS origin to enable passkeys</div>
      ) : (
        <div className="access-grid">
          <div className="admin-access-card">
            <div className="access-card-heading"><span className="access-glyph">✦</span><div><strong>My passkeys</strong><small>Use your device unlock to sign in</small></div></div>
            <form className="access-entry" onSubmit={(event) => { event.preventDefault(); void run(async () => {
              await registerPasskey(label);
              setLabel("");
              report("Passkey added");
            }); }}>
              <label htmlFor="passkey-label">Name this passkey</label>
              <div><input id="passkey-label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="MacBook, headset desk…" minLength={2} maxLength={40} required />
                <button type="submit" disabled={busy}>Add passkey</button></div>
            </form>
            <div className="access-list">
              {me?.passkeys.length ? me.passkeys.map((key) => <div className="access-item" key={key.id}>
                <span><strong>{key.label}</strong><small>Passkey · active</small></span>
                <button type="button" disabled={busy || (!me.owner && me.passkeys.length === 1)} onClick={() => {
                  if (window.confirm(`Remove passkey “${key.label}”? You'll need to sign in again`))
                    void run(async () => { await api.removePasskey(key.id); report("Passkey removed · sign in again"); });
                }}>Remove</button>
              </div>) : <p className="access-empty">No passkeys yet. Add one to make your next sign-in quicker</p>}
            </div>
          </div>
          {auth.owner && <div className="admin-access-card">
            <div className="access-card-heading"><span className="access-glyph">⌘</span><div><strong>People with access</strong><small>Each admin gets their own passkey</small></div></div>
            <form className="access-entry" onSubmit={(event) => { event.preventDefault(); void run(async () => {
              const result = await api.addAdmin(newAdmin);
              setNewAdmin("");
              setInvite(result.inviteToken);
              report("Admin added · share the one-time invitation");
            }); }}>
              <label htmlFor="new-admin">Invite an admin</label>
              <div><input id="new-admin" value={newAdmin} onChange={(event) => setNewAdmin(event.target.value)} placeholder="Their name" minLength={2} maxLength={48} required />
                <button type="submit" disabled={busy}>Add admin</button></div>
            </form>
            {inviteUrl && <div className="invite-box" role="status"><label htmlFor="invite-link">Invitation · expires in 15 minutes</label>
              <div><input id="invite-link" readOnly value={inviteUrl} onFocus={(event) => event.target.select()} />
                <button type="button" onClick={() => void navigator.clipboard.writeText(inviteUrl).then(() => report("Invitation link copied")).catch(() => report("Could not copy invitation"))}>Copy</button></div>
            </div>}
            <div className="access-list">
              {auth.accounts?.map((account) => <div className="access-item access-person" key={account.id}>
                <span className="access-person-name"><input aria-label={`Name for ${account.name}`} value={names[account.id] ?? account.name}
                  onChange={(event) => setNames({ ...names, [account.id]: event.target.value })} maxLength={48} />
                  <small>{account.owner ? "Owner · recovery key" : `${account.passkeys.length} passkey${account.passkeys.length === 1 ? "" : "s"}`}</small></span>
                <div>
                  {(names[account.id] ?? account.name) !== account.name && <button type="button" disabled={busy} onClick={() => void run(() => api.renameAdmin(account.id, names[account.id]))}>Save</button>}
                  {!account.owner && <><button type="button" disabled={busy} onClick={() => void run(async () => { const result = await api.inviteAdmin(account.id); setInvite(result.inviteToken); report(`New invitation for ${account.name}`); })}>Invite</button>
                    <button type="button" disabled={busy} onClick={() => {
                      if (window.confirm(`Remove ${account.name} and revoke their access?`)) void run(() => api.removeAdmin(account.id));
                    }}>Remove</button></>}
                </div>
              </div>)}
            </div>
          </div>}
        </div>
      )}
    </section>
  );
}
