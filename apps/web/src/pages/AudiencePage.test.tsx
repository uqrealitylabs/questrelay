import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudiencePage } from "./AudiencePage";

vi.mock("../api", () => ({
  api: {
    listStreams: vi.fn(),
  },
}));

import { api } from "../api";

describe("AudiencePage", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.mocked(api.listStreams).mockReset();
  });

  it("shows empty state when no streams are active", async () => {
    vi.mocked(api.listStreams).mockResolvedValue([]);
    render(
      <MemoryRouter>
        <AudiencePage />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("audience-empty")).toBeTruthy();
  });

  it("renders a tile per active stream", async () => {
    vi.mocked(api.listStreams).mockResolvedValue([
      { deviceId: "192.168.1.10:5555", label: "Quest A", state: "streaming" },
      { deviceId: "192.168.1.11:5555", label: "Quest B", state: "streaming" },
    ]);
    render(
      <MemoryRouter>
        <AudiencePage />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("audience-grid")).toBeTruthy();
    expect(screen.getByTestId("stream-192.168.1.10:5555")).toBeTruthy();
    expect(screen.getByTestId("stream-192.168.1.11:5555")).toBeTruthy();
  });
});
