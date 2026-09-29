import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type Feed, type RoomSettings } from "../api";
import { Viewer } from "../viewer";
import { AudiencePage } from "./AudiencePage";

vi.mock("../api", () => ({ api: { room: vi.fn(), ticket: vi.fn() } }));
vi.mock("../viewer", () => ({ Viewer: { connect: vi.fn() } }));

const room: RoomSettings = {
  id: "abc123",
  title: "Quest night",
  isPublic: false,
  theme: {
    base: "dark",
    accent: "#5865f2",
    density: "comfortable",
    motion: "subtle",
  },
};

function show() {
  return render(
    <MemoryRouter initialEntries={["/livestream/abc123"]}>
      <Routes>
        <Route path="/livestream/:id" element={<AudiencePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("AudiencePage", () => {
  beforeEach(() => {
    vi.mocked(api.room).mockResolvedValue(room);
    vi.mocked(api.ticket).mockReset();
    vi.mocked(Viewer.connect).mockReset();
  });
  afterEach(() => cleanup());

  it("requires the admin access code before joining a private room", async () => {
    vi.mocked(api.ticket).mockRejectedValue(new Error("Incorrect access code"));
    show();
    expect(await screen.findByText("Welcome to Quest night")).toBeTruthy();
    expect(api.ticket).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Access code"), {
      target: { value: "wrong-code" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Join the lounge" }));
    await waitFor(() =>
      expect(api.ticket).toHaveBeenCalledWith("abc123", "wrong-code"),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Incorrect access code",
    );
  });

  it("does not count a selected headset after it stops sharing", async () => {
    let updateFeeds: (feeds: Feed[]) => void = () => {};
    vi.mocked(api.room).mockResolvedValue({ ...room, isPublic: true });
    vi.mocked(api.ticket).mockResolvedValue({ ticket: "viewer-ticket" });
    vi.mocked(Viewer.connect).mockImplementation(async (_ticket, onFeeds) => {
      updateFeeds = onFeeds;
      return {
        watch: vi.fn().mockResolvedValue(undefined),
        stream: () => undefined,
        unwatch: vi.fn(),
        close: vi.fn(),
      } as unknown as Viewer;
    });

    show();
    await waitFor(() => expect(Viewer.connect).toHaveBeenCalled());
    act(() =>
      updateFeeds([{ headsetId: "quest-a", video: "video-1", audio: null }]),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Watch stream" }),
    );
    expect(screen.getByText("1 headset live · 1 watching")).toBeTruthy();

    act(() => updateFeeds([]));
    expect(screen.getByText("0 headsets live · 0 watching")).toBeTruthy();
    expect(screen.getByText(/Sharing stops when Quest sleeps/)).toBeTruthy();
  });
});
