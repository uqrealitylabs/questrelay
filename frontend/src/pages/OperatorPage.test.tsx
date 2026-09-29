import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AdminState, api } from "../api";
import { OperatorPage } from "./OperatorPage";

vi.mock("../api", () => ({
  api: { admin: vi.fn(), auth: vi.fn(), login: vi.fn(), save: vi.fn(), saveRoom: vi.fn(), logout: vi.fn(), media: vi.fn() },
  loginPasskey: vi.fn(),
  registerPasskey: vi.fn(),
}));

const admin: AdminState = {
  settings: {
    id: "abc123",
    title: "Quest night",
    isPublic: true,
    accessCode: "",
    theme: {
      base: "dark",
      accent: "#5865f2",
      density: "comfortable",
      motion: "subtle",
    },
  },
  relay: {
    healthy: true,
    viewers: 2,
    uptimeSeconds: 120,
    history: [
      { at: 1000, healthy: true, headsets: 1, viewers: 2 },
      { at: 6000, healthy: false, headsets: 1, viewers: 2 },
    ],
    rtcPort: 44444,
    announcedAddress: "relay.example.test",
    headsets: [],
  },
};

describe("OperatorPage", () => {
  beforeEach(() => {
    vi.mocked(api.admin).mockReset();
    vi.mocked(api.login).mockReset();
    vi.mocked(api.save).mockReset();
    vi.mocked(api.saveRoom).mockReset();
    vi.mocked(api.media).mockReset();
    vi.mocked(api.auth).mockReset();
    vi.mocked(api.auth).mockResolvedValue({ enabled: true, currentId: "owner", owner: true, accounts: [
      { id: "owner", name: "Owner", owner: true, passkeys: [] },
    ] });
  });
  afterEach(() => cleanup());

  it("keeps admin controls behind sign-in and saves room settings", async () => {
    vi.mocked(api.admin)
      .mockRejectedValueOnce(new Error("Admin sign-in required"))
      .mockResolvedValue(admin);
    vi.mocked(api.login).mockResolvedValue({ ok: true });
    vi.mocked(api.save).mockResolvedValue({ settings: admin.settings });
    render(
      <MemoryRouter>
        <OperatorPage />
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole("heading", { name: "Welcome back, operator" }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Rooms" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Admin key"), {
      target: { value: "test-admin-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open control room" }));
    expect(await screen.findByRole("heading", { name: "Rooms" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("tab", { name: "Room defaults" }));
    fireEvent.change(screen.getByLabelText("Room name"), {
      target: { value: "New room name" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save room defaults" }));
    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith(
        expect.objectContaining({ title: "New room name" }),
      ),
    );
  });

  it("shows measured relay history and headset diagnostics without setup controls", async () => {
    vi.mocked(api.admin).mockResolvedValue({
      ...admin,
      relay: {
        ...admin.relay,
        headsets: [
          {
            id: "quest-a",
            video: "video-producer",
            audio: "audio-producer",
            connectedSeconds: 95,
            statsAgeMs: 1800,
            controlRttMs: 42,
            videoEnabled: true,
            audioEnabled: true,
            capture: { videoEnabled: true, audioEnabled: true, queueBytes: 9000,
              targetBitrateBps: 8_000_000, width: 1920, height: 1080, fps: 60 },
            history: [{ at: 1000, videoBitrate: 1_600_000, queueBytes: 9000 }],
            stats: {
              video: { packets: 1200, bytes: 400_000, bitrate: 1_600_000 },
              audio: { packets: 90, bytes: 9000, bitrate: 32_000 },
            },
          },
        ],
      },
    });
    render(
      <MemoryRouter>
        <OperatorPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText("quest-a")).toBeTruthy();
    expect(
      screen.getByRole("img", { name: /50.0 percent availability/i }),
    ).toBeTruthy();
    const summary = screen.getByText("quest-a").closest("summary");
    if (!summary) throw new Error("Headset diagnostics missing");
    fireEvent.click(summary);
    expect(summary?.parentElement?.hasAttribute("open")).toBe(true);
    expect(screen.getByText("Glass-to-glass")).toBeTruthy();
    expect(screen.getByText("Capture profile")).toBeTruthy();
    vi.mocked(api.media).mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: "◉ Video on" }));
    await waitFor(() => expect(api.media).toHaveBeenCalledWith("quest-a", false, true));
    expect(
      screen.queryByRole("button", { name: "Copy publisher key" }),
    ).toBeNull();
  });

  it("saves a headset room's own mascot and access settings", async () => {
    vi.mocked(api.admin).mockResolvedValue({
      ...admin,
      rooms: [{ headsetId: "quest-a", settings: {
        ...admin.settings, id: "feed01", title: "Quest A", mascot: {
          name: "Mochi", mood: "playful", accessory: "leaf",
        },
      } }],
    });
    vi.mocked(api.saveRoom).mockResolvedValue({ settings: {
      ...admin.settings, id: "feed01", title: "Quest A", mascot: {
        name: "Pip", mood: "gentle", accessory: "leaf",
      },
    } });
    render(<MemoryRouter><OperatorPage /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "Rooms" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("tab", { name: "Room defaults" }));
    fireEvent.change(screen.getByLabelText("Edit room"), { target: { value: "feed01" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Pip" } });
    fireEvent.change(screen.getByLabelText("Mood"), { target: { value: "gentle" } });
    fireEvent.click(screen.getByRole("button", { name: "Save room defaults" }));
    await waitFor(() => expect(api.saveRoom).toHaveBeenCalledWith("feed01", expect.objectContaining({
      title: "Quest A", mascot: { name: "Pip", mood: "gentle", accessory: "leaf" },
    })));
  });
});
