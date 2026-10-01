export type Theme = {
  base: "light" | "ash" | "dark" | "onyx" | "grove" | "lagoon" | "dusk";
  accent: string;
  density: "comfortable" | "compact";
  motion: "subtle" | "quiet";
  radius?: "soft" | "rounded" | "square";
  surface?: "solid" | "translucent";
};

export type Mascot = {
  name: string;
  mood: "playful" | "gentle" | "sleepy";
  accessory: "headphones" | "leaf" | "crown" | "none";
};

export type RoomSettings = {
  id: string;
  title: string;
  isPublic: boolean;
  theme: Theme;
  mascot?: Mascot;
  headsetId?: string;
};

export type AdminSettings = RoomSettings & { accessCode: string };

export type AdminAccount = {
  id: string;
  name: string;
  owner: boolean;
  passkeys: Array<{ id: string; label: string }>;
};

export type AuthState = {
  enabled: boolean;
  currentId?: string;
  owner?: boolean;
  accounts?: AdminAccount[];
};

export type BeatSaberStats = {
  score: number;
  goodCuts: number;
  badCuts: number;
  missedNotes: number;
  combo: number;
};

export type Feed = {
  headsetId: string;
  video: string | null;
  audio: string | null;
  beatSaber?: BeatSaberStats | null;
};

export type TrackStats = { packets: number; bytes: number; bitrate: number };

export type AdminState = {
  settings: AdminSettings;
  rooms?: Array<{ headsetId: string; settings: AdminSettings }>;
  relay: {
    healthy: boolean;
    viewers: number;
    uptimeSeconds: number;
    history: Array<{
      at: number;
      healthy: boolean;
      headsets: number;
      viewers: number;
    }>;
    rtcPort: number;
    announcedAddress: string | null;
    headsets: Array<{
      id: string;
      video: string | null;
      audio: string | null;
      stats: { video?: TrackStats; audio?: TrackStats } | null;
      connectedSeconds: number;
      statsAgeMs: number | null;
      controlRttMs: number | null;
      videoEnabled: boolean;
      audioEnabled: boolean;
      capture: {
        videoEnabled: boolean;
        audioEnabled: boolean;
        queueBytes: number;
        targetBitrateBps: number;
        width: number;
        height: number;
        fps: number;
      } | null;
      history: Array<{ at: number; videoBitrate: number; queueBytes: number }>;
    }>;
  };
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(body.error ?? `Request failed (${response.status})`);
  return body as T;
}

export const api = {
  site: () => request<RoomSettings>("/api/site"),
  room: (id: string) =>
    request<RoomSettings>(`/api/livestream/${encodeURIComponent(id)}`),
  ticket: (id: string, accessCode: string) =>
    request<{ ticket: string }>(
      `/api/livestream/${encodeURIComponent(id)}/ticket`,
      {
        method: "POST",
        body: JSON.stringify({ accessCode }),
      },
    ),
  login: (key: string) =>
    request<{ ok: boolean }>("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ key }),
    }),
  logout: () =>
    request<{ ok: boolean }>("/api/admin/logout", { method: "POST" }),
  admin: () => request<AdminState>("/api/admin/state"),
  auth: () => request<AuthState>("/api/admin/auth"),
  media: (id: string, videoEnabled: boolean, audioEnabled: boolean) =>
    request<{ ok: boolean }>(`/api/admin/headsets/${encodeURIComponent(id)}/media`, {
      method: "PUT",
      body: JSON.stringify({ videoEnabled, audioEnabled }),
    }),
  publisherKey: () => request<{ key: string }>("/api/admin/publisher-key"),
  save: (settings: Omit<AdminSettings, "id">) =>
    request<{ settings: AdminSettings }>("/api/admin/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    }),
  saveRoom: (id: string, settings: Omit<AdminSettings, "id">) =>
    request<{ settings: AdminSettings }>(`/api/admin/rooms/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(settings),
    }),
  addAdmin: (name: string) => request<{ id: string; inviteToken: string }>("/api/admin/accounts", {
    method: "POST", body: JSON.stringify({ name }),
  }),
  renameAdmin: (id: string, name: string) => request<{ ok: boolean }>(`/api/admin/accounts/${encodeURIComponent(id)}`, {
    method: "PUT", body: JSON.stringify({ name }),
  }),
  removeAdmin: (id: string) => request<{ ok: boolean }>(`/api/admin/accounts/${encodeURIComponent(id)}`, { method: "DELETE" }),
  inviteAdmin: (id: string) => request<{ inviteToken: string }>(`/api/admin/accounts/${encodeURIComponent(id)}/invite`, { method: "POST" }),
  removePasskey: (id: string) => request<{ ok: boolean }>(`/api/admin/passkeys/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

function browserPasskeys() {
  if (!window.isSecureContext || !window.PublicKeyCredential?.parseCreationOptionsFromJSON)
    throw new Error("Passkeys need HTTPS and a current browser");
}

export async function registerPasskey(label: string, inviteToken?: string) {
  browserPasskeys();
  const { challengeId, options } = await request<{challengeId: string; options: {publicKey: PublicKeyCredentialCreationOptionsJSON}}>(
    "/api/admin/passkeys/register/start", {
      method: "POST", body: JSON.stringify({ label, inviteToken }),
    });
  const credential = await navigator.credentials.create({
    publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options.publicKey),
  });
  if (!(credential instanceof PublicKeyCredential)) throw new Error("Passkey creation was cancelled");
  return request<{ok: boolean}>("/api/admin/passkeys/register/finish", {
    method: "POST", body: JSON.stringify({ challengeId, credential: credential.toJSON() }),
  });
}

export async function loginPasskey(name: string) {
  browserPasskeys();
  const { challengeId, options } = await request<{challengeId: string; options: {publicKey: PublicKeyCredentialRequestOptionsJSON}}>(
    "/api/admin/passkeys/login/start", { method: "POST", body: JSON.stringify({ name }) });
  const credential = await navigator.credentials.get({
    publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options.publicKey),
  });
  if (!(credential instanceof PublicKeyCredential)) throw new Error("Passkey sign-in was cancelled");
  return request<{ok: boolean}>("/api/admin/passkeys/login/finish", {
    method: "POST", body: JSON.stringify({ challengeId, credential: credential.toJSON() }),
  });
}
