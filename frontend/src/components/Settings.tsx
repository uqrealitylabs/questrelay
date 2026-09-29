import { useRef, useState } from "react";
import { api, type AdminSettings, type Mascot, type RoomSettings, type Theme } from "../api";
import { Capybara } from "./Capybara";

const palettes: Array<{ name: string; base: Theme["base"]; accent: string }> = [
  { name: "Midnight", base: "dark", accent: "#5865f2" },
  { name: "Graphite", base: "ash", accent: "#8b9bea" },
  { name: "Pitch", base: "onyx", accent: "#d5a6ff" },
  { name: "Daylight", base: "light", accent: "#5865f2" },
  { name: "Moss", base: "grove", accent: "#77c498" },
  { name: "Tide", base: "lagoon", accent: "#54c7ce" },
  { name: "Ember", base: "dusk", accent: "#ed9b7c" },
];

const defaultMascot: Mascot = { name: "Mochi", mood: "playful", accessory: "leaf" };

function ThemeControls({ value, change }: { value: Theme; change: (theme: Theme) => void }) {
  return <div className="appearance-controls">
    <div className="setting-block">
      <span className="setting-label">Palette</span>
      <div className="palette-grid">
        {palettes.map(({ name, base, accent }) => <button key={base} type="button"
          className={`palette-tile palette-${base}`} aria-pressed={value.base === base}
          onClick={() => change({ ...value, base, accent })}>
          <span className="palette-scene"><i /><b /><em /></span>
          <span>{name}</span>
        </button>)}
      </div>
    </div>
    <div className="setting-block setting-inline">
      <label htmlFor={`accent-${value.base}`}>Accent colour</label>
      <input id={`accent-${value.base}`} type="color" value={/^#[0-9a-f]{6}$/i.test(value.accent) ? value.accent : "#5865f2"}
        onChange={(event) => change({ ...value, accent: event.target.value })} />
      <input aria-label="Accent hex colour" type="text" pattern="#[0-9A-Fa-f]{6}" maxLength={7}
        value={value.accent} onChange={(event) => change({ ...value, accent: event.target.value })} />
    </div>
    <div className="setting-selects">
      <label>Spacing<select value={value.density} onChange={(event) => change({ ...value, density: event.target.value as Theme["density"] })}>
        <option value="comfortable">Comfortable</option><option value="compact">Compact</option>
      </select></label>
      <label>Corners<select value={value.radius ?? "rounded"} onChange={(event) => change({ ...value, radius: event.target.value as Theme["radius"] })}>
        <option value="soft">Soft</option><option value="rounded">Rounded</option><option value="square">Square</option>
      </select></label>
      <label>Surface<select value={value.surface ?? "solid"} onChange={(event) => change({ ...value, surface: event.target.value as Theme["surface"] })}>
        <option value="solid">Solid</option><option value="translucent">Translucent</option>
      </select></label>
      <label>Motion<select value={value.motion} onChange={(event) => change({ ...value, motion: event.target.value as Theme["motion"] })}>
        <option value="subtle">On</option><option value="quiet">Quiet</option>
      </select></label>
    </div>
  </div>;
}

export function Settings({ theme, personal, setPersonal, room, rooms = [], onSaved, report }: {
  theme: Theme;
  personal: Theme | null;
  setPersonal: (theme: Theme | null) => void;
  room?: RoomSettings;
  rooms?: Array<{ headsetId: string; settings: AdminSettings }>;
  onSaved?: (settings: AdminSettings) => void;
  report?: (message: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<"mine" | "room">("mine");
  const [draft, setDraft] = useState<AdminSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const choices = room ? [{ headsetId: "", settings: room as AdminSettings }, ...rooms] : [];
  const open = () => {
    setTab("mine");
    setDraft(room ? { ...room, accessCode: (room as AdminSettings).accessCode ?? "", mascot: room.mascot ?? defaultMascot } : null);
    setError("");
    if (dialog.current?.showModal) dialog.current.showModal();
    else if (dialog.current) dialog.current.open = true;
  };
  const close = () => { if (dialog.current?.close) dialog.current.close(); else if (dialog.current) dialog.current.open = false; };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    setBusy(true); setError("");
    try {
      const { id, headsetId: _headsetId, ...input } = draft;
      const { settings } = id === room?.id ? await api.save(input) : await api.saveRoom(id, input);
      setDraft(settings);
      onSaved?.(settings);
      report?.("Room settings saved");
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const mascot = draft?.mascot ?? defaultMascot;
  return <>
    <button type="button" className="gear-button" aria-label="Settings" aria-haspopup="dialog" onClick={open} title="Settings">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m10.4 2.8-.4 1.6a8 8 0 0 0-1.7.7L6.9 4.2 4.2 6.9l.9 1.4a8 8 0 0 0-.7 1.7l-1.6.4v3.2l1.6.4c.2.6.4 1.2.7 1.7l-.9 1.4 2.7 2.7 1.4-.9c.5.3 1.1.5 1.7.7l.4 1.6h3.2l.4-1.6c.6-.2 1.2-.4 1.7-.7l1.4.9 2.7-2.7-.9-1.4c.3-.5.5-1.1.7-1.7l1.6-.4v-3.2l-1.6-.4a8 8 0 0 0-.7-1.7l.9-1.4-2.7-2.7-1.4.9a8 8 0 0 0-1.7-.7l-.4-1.6h-3.2Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/><circle cx="12" cy="12" r="3.1" stroke="currentColor" strokeWidth="1.7"/></svg>
    </button>
    <dialog ref={dialog} className="settings-dialog" aria-label="Settings" onClick={(event) => { if (event.target === dialog.current) close(); }} onKeyDown={(event) => { if (event.key === "Escape") close(); }}>
      <div className="settings-head"><div><h2>Settings</h2><p>Make this room feel like yours</p></div>
        <button type="button" className="settings-close" aria-label="Close settings" onClick={close}>×</button></div>
      {onSaved && <div className="settings-tabs" role="tablist" aria-label="Settings section">
        <button type="button" role="tab" aria-selected={tab === "mine"} onClick={() => setTab("mine")}>My view</button>
        <button type="button" role="tab" aria-selected={tab === "room"} onClick={() => setTab("room")}>Room defaults</button>
      </div>}
      {tab === "mine" || !onSaved ? <div className="settings-body">
        <p className="settings-note">Your changes stay in this browser. Room defaults remain available for everyone else</p>
        <ThemeControls value={personal ?? theme} change={setPersonal} />
        <button type="button" className="quiet-button settings-reset" disabled={!personal} onClick={() => setPersonal(null)}>Use room appearance</button>
      </div> : <form className="settings-body" onSubmit={(event) => void save(event)}>
        <p className="settings-note">These defaults and the capybara belong to the selected room. Viewers can still choose their own appearance</p>
        {choices.length > 1 && <label className="setting-full">Edit room<select value={draft?.id ?? ""} onChange={(event) => {
          const selected = choices.find(({ settings }) => settings.id === event.target.value)?.settings;
          if (selected) setDraft({ ...selected, mascot: selected.mascot ?? defaultMascot });
        }}>{choices.map(({ headsetId, settings }) => <option value={settings.id} key={settings.id}>{headsetId ? `${headsetId} · ${settings.title}` : `Lounge · ${settings.title}`}</option>)}</select></label>}
        {draft && <>
          <div className="setting-selects room-fields">
            <label>Room name<input value={draft.title} maxLength={60} required onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
            <label>Who can watch<select value={draft.isPublic ? "public" : "private"} onChange={(event) => setDraft({ ...draft, isPublic: event.target.value === "public" })}>
              <option value="public">Anyone with the link</option><option value="private">People with the code</option>
            </select></label>
          </div>
          {!draft.isPublic && <label className="setting-full">Access code<input type="password" value={draft.accessCode} minLength={10} maxLength={64} required
            onChange={(event) => setDraft({ ...draft, accessCode: event.target.value })} /></label>}
          <ThemeControls value={draft.theme} change={(value) => setDraft({ ...draft, theme: value })} />
          <div className="mascot-settings">
            <div className="mascot-preview"><Capybara mascot={mascot} /><span>{mascot.name}</span></div>
            <div><h3>Room capybara</h3><p>Give this room its own little host</p>
              <label>Name<input maxLength={24} required value={mascot.name} onChange={(event) => setDraft({ ...draft, mascot: { ...mascot, name: event.target.value } })} /></label>
              <div className="setting-selects"><label>Mood<select value={mascot.mood} onChange={(event) => setDraft({ ...draft, mascot: { ...mascot, mood: event.target.value as Mascot["mood"] } })}>
                <option value="playful">Playful</option><option value="gentle">Gentle</option><option value="sleepy">Sleepy</option>
              </select></label><label>Accessory<select value={mascot.accessory} onChange={(event) => setDraft({ ...draft, mascot: { ...mascot, accessory: event.target.value as Mascot["accessory"] } })}>
                <option value="headphones">Headphones</option><option value="leaf">Leaf</option><option value="crown">Crown</option><option value="none">None</option>
              </select></label></div>
            </div>
          </div>
          {error && <p role="alert" className="form-message">{error}</p>}
          <div className="settings-footer"><button className="primary-button" type="submit" disabled={busy}>{busy ? "Saving…" : "Save room defaults"}</button></div>
        </>}
      </form>}
    </dialog>
  </>;
}
