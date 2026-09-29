import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudiencePage } from "./AudiencePage";

vi.mock("../api", () => ({ api: { listStreams: vi.fn() } }));
vi.mock("../components/StreamPlayer", () => ({
  StreamPlayer: ({ deviceId }: { deviceId: string }) => (
    <div data-testid={`stream-${deviceId}`} />
  ),
}));

import { api } from "../api";

function showAudience() {
  return render(
    <MemoryRouter>
      <AudiencePage />
    </MemoryRouter>,
  );
}

describe("AudiencePage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
  beforeEach(() => {
    const saved = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
    });
    vi.mocked(api.listStreams).mockReset();
  });

  it("shows an actionable empty state without claiming audio support", async () => {
    vi.mocked(api.listStreams).mockResolvedValue([]);
    showAudience();
    expect(await screen.findByTestId("audience-empty")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Audio unavailable" }),
    ).toBeDisabled();
  });

  it("only mounts selected feeds and stops them on request", async () => {
    vi.mocked(api.listStreams).mockResolvedValue([
      { deviceId: "a", label: "Quest A", state: "streaming" },
      { deviceId: "b", label: "Quest B", state: "streaming" },
      { deviceId: "c", label: "Quest C", state: "starting" },
    ]);
    showAudience();
    await screen.findByTestId("audience-grid");
    expect(screen.queryByTestId("stream-a")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Watch stream from Quest A" }),
    );
    expect(screen.getByTestId("stream-a")).toBeTruthy();
    expect(screen.queryByTestId("stream-b")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Focus Quest A" }));
    expect(
      screen.getByRole("button", { name: "Focus Quest A" }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(
      screen.getByRole("button", { name: "Stop watching Quest A" }),
    );
    expect(screen.queryByTestId("stream-a")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Watch stream from Quest C" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop watching" }));
    expect(screen.queryByTestId("stream-c")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Watch all streams" }));
    expect(screen.getByTestId("stream-a")).toBeTruthy();
    expect(screen.getByTestId("stream-b")).toBeTruthy();
    expect(screen.getByTestId("stream-c")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Focus Quest B" }));
    fireEvent.click(screen.getByRole("button", { name: "Return to grid" }));
    expect(
      screen.getByRole("button", { name: "Focus Quest B" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("aborts an in-flight refresh when leaving the page", () => {
    vi.mocked(api.listStreams).mockReturnValue(new Promise(() => {}));
    const view = showAudience();
    const signal = vi.mocked(api.listStreams).mock.calls[0][0];
    expect(signal?.aborted).toBe(false);
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("validates stored preferences and persists appearance changes", async () => {
    window.localStorage.setItem(
      "questrelay.appearance",
      '{"theme":"unknown","density":"compact","accent":"blue"}',
    );
    vi.mocked(api.listStreams).mockResolvedValue([]);
    const view = showAudience();
    await screen.findByTestId("audience-empty");
    expect(view.container.firstChild).toHaveAttribute("data-theme", "dark");
    expect(view.container.firstChild).toHaveAttribute(
      "data-density",
      "compact",
    );
    fireEvent.click(screen.getByText("Appearance"));
    fireEvent.change(screen.getByLabelText("Theme"), {
      target: { value: "light" },
    });
    expect(
      JSON.parse(window.localStorage.getItem("questrelay.appearance") ?? "{}")
        .theme,
    ).toBe("light");
    fireEvent.click(screen.getByRole("button", { name: "Reset appearance" }));
    expect(view.container.firstChild).toHaveAttribute("data-theme", "dark");
    expect(view.container.firstChild).toHaveAttribute(
      "data-density",
      "comfortable",
    );
  });
});
