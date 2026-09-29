import { useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { AdminSettings, RoomSettings, Theme } from "../api";
import { Capybara, type MascotSituation } from "./Capybara";
import { Settings } from "./Settings";

function readPersonalTheme(): Theme | null {
  try {
    const saved = JSON.parse(localStorage.getItem("questrelay-appearance") ?? "null") as Theme | null;
    if (!saved || !["dark", "ash", "onyx", "light", "grove", "lagoon", "dusk"].includes(saved.base) ||
      !/^#[0-9a-f]{6}$/i.test(saved.accent) ||
      !["comfortable", "compact"].includes(saved.density) ||
      !["subtle", "quiet"].includes(saved.motion) ||
      (saved.radius && !["soft", "rounded", "square"].includes(saved.radius)) ||
      (saved.surface && !["solid", "translucent"].includes(saved.surface))) return null;
    return saved;
  } catch { return null; }
}

export function Shell({
  theme,
  active,
  title,
  subtitle,
  sidebar,
  actions,
  children,
  roomId,
  room,
  rooms,
  onSaved,
  report,
  mascotSituation,
  feedCount,
}: {
  theme: Theme;
  active: "public" | "admin";
  title: string;
  subtitle: string;
  sidebar?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  roomId?: string;
  room?: RoomSettings;
  rooms?: Array<{ headsetId: string; settings: AdminSettings }>;
  onSaved?: (settings: AdminSettings) => void;
  report?: (message: string) => void;
  mascotSituation?: MascotSituation;
  feedCount?: number;
}) {
  const [personal, updatePersonal] = useState<Theme | null>(readPersonalTheme);
  const appearance = personal ?? theme;
  const setPersonal = (next: Theme | null) => {
    updatePersonal(next);
    try {
      if (next) localStorage.setItem("questrelay-appearance", JSON.stringify(next));
      else localStorage.removeItem("questrelay-appearance");
    } catch { /* Personal appearance still works for this visit */ }
  };
  return (
    <div
      className={`app-shell ${sidebar ? "has-sidebar" : "no-sidebar"}`}
      data-base={appearance.base}
      data-density={appearance.density}
      data-motion={appearance.motion}
      data-radius={appearance.radius ?? "rounded"}
      data-surface={appearance.surface ?? "solid"}
      style={{ "--accent": appearance.accent } as CSSProperties}
    >
      <div className="window-bar">
        <span className="window-name">QuestRelay</span>
        <span className="window-room">
          {active === "admin" ? "Control room" : title}
        </span>
      </div>
      <nav className="server-rail" aria-label="Primary navigation">
        <Capybara className="server-icon home-icon" home mascot={room?.mascot}
          situation={mascotSituation} feedCount={feedCount} />
        <span className="rail-rule" />
        <Link
          className={`server-icon ${active === "public" ? "selected" : ""}`}
          to={roomId ? `/livestream/${roomId}` : "/"}
          aria-label="Public lounge"
          title="Public lounge"
        >
          Q
        </Link>
        <Link
          className={`server-icon admin-icon ${active === "admin" ? "selected" : ""}`}
          to="/admin"
          aria-label="Admin"
          title="Admin"
        >
          ✦
        </Link>
      </nav>
      {sidebar && <aside className="channel-panel">
        <div className="channel-brand">
          <span>{active === "admin" ? "Control room" : "Live feeds"}</span>
        </div>
        <div className="channel-content">{sidebar}</div>
      </aside>}
      <main className="workspace">
        <header className="workspace-header">
          <div className="workspace-title">
            <span className="header-hash">#</span>
            <span>
              <h1>{title}</h1>
              <p>{subtitle}</p>
            </span>
          </div>
          <div className="workspace-actions">{actions}<Settings theme={theme} personal={personal}
            setPersonal={setPersonal} room={room} rooms={rooms} onSaved={onSaved} report={report} /></div>
        </header>
        {children}
      </main>
    </div>
  );
}
