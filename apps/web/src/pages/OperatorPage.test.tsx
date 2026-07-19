import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultDeviceSettings } from "@vr-livestream/shared";
import { OperatorPage } from "./OperatorPage";

vi.mock("../api", () => ({
  api: {
    listDevices: vi.fn(),
    saveDevice: vi.fn(),
    clearCache: vi.fn(),
    startStream: vi.fn(),
    stopStream: vi.fn(),
    pair: vi.fn(),
    connect: vi.fn(),
    enableWireless: vi.fn(),
  },
}));

import { api } from "../api";

describe("OperatorPage", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.mocked(api.listDevices).mockReset();
    vi.mocked(api.clearCache).mockReset();
    vi.mocked(api.startStream).mockReset();
    vi.mocked(api.saveDevice).mockReset();
    vi.stubGlobal("confirm", vi.fn(() => true));
  });

  it("lists devices and can clear the device cache", async () => {
    vi.mocked(api.listDevices)
      .mockResolvedValueOnce([
        {
          id: "192.168.1.10:5555",
          host: "192.168.1.10",
          port: 5555,
          settings: defaultDeviceSettings({ label: "Quest A" }),
          presence: ["saved", "connected"],
          online: true,
          streaming: false,
        },
      ])
      .mockResolvedValue([]);
    vi.mocked(api.clearCache).mockResolvedValue({ ok: true });

    render(
      <MemoryRouter>
        <OperatorPage />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("device-row-192.168.1.10:5555")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /clear cached devices/i }));
    await waitFor(() => expect(api.clearCache).toHaveBeenCalled());
  });

  it("starts a stream for a selected device", async () => {
    vi.mocked(api.listDevices).mockResolvedValue([
      {
        id: "192.168.1.10:5555",
        host: "192.168.1.10",
        port: 5555,
        settings: defaultDeviceSettings({ label: "Quest A" }),
        presence: ["connected"],
        online: true,
        streaming: false,
      },
    ]);
    vi.mocked(api.saveDevice).mockResolvedValue({
      device: {
        id: "192.168.1.10:5555",
        host: "192.168.1.10",
        port: 5555,
        settings: defaultDeviceSettings({ label: "Quest A" }),
        presence: ["saved"],
        online: true,
        streaming: false,
      },
    });
    vi.mocked(api.startStream).mockResolvedValue({
      stream: {
        deviceId: "192.168.1.10:5555",
        label: "Quest A",
        state: "streaming",
      },
    });

    render(
      <MemoryRouter>
        <OperatorPage />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: /start stream/i }));
    await waitFor(() =>
      expect(api.startStream).toHaveBeenCalledWith(
        "192.168.1.10:5555",
        "192.168.1.10:5555",
      ),
    );
    expect(await screen.findByTestId("operator-message")).toHaveTextContent(
      /allow usb debugging/i,
    );
  });
});
