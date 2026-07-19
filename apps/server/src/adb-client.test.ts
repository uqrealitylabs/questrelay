import { describe, expect, it } from "vitest";
import { AdbClient, type CommandRunner } from "./adb-client.js";

function fakeRunner(script: Record<string, string>): CommandRunner {
  return async (args) => {
    const key = args.join(" ");
    if (!(key in script)) {
      throw new Error(`Unexpected adb args: ${key}`);
    }
    return { stdout: script[key], stderr: "", code: 0 };
  };
}

describe("AdbClient", () => {
  it("lists connected devices from adb devices -l", async () => {
    const adb = new AdbClient(
      fakeRunner({
        "devices -l":
          "List of devices attached\n" +
          "1A2B3C4D             device usb:1-1 product:quest3 model:Quest_3 device:hollywood\n" +
          "192.168.1.20:5555    device product:quest3 model:Quest_3\n" +
          "192.168.1.21:5555    unauthorized\n",
      }),
    );

    const devices = await adb.listDevices();

    expect(devices).toEqual([
      {
        serial: "1A2B3C4D",
        state: "device",
        transport: "usb",
        model: "Quest_3",
      },
      {
        serial: "192.168.1.20:5555",
        state: "device",
        transport: "tcp",
        model: "Quest_3",
      },
      {
        serial: "192.168.1.21:5555",
        state: "unauthorized",
        transport: "tcp",
        model: undefined,
      },
    ]);
  });

  it("pairs using adb pair host:port code", async () => {
    const calls: string[][] = [];
    const adb = new AdbClient(async (args) => {
      calls.push(args);
      return { stdout: "Successfully paired to 192.168.1.30:37100", stderr: "", code: 0 };
    });

    const result = await adb.pair("192.168.1.30", 37100, "123456");

    expect(calls[0]).toEqual(["pair", "192.168.1.30:37100", "123456"]);
    expect(result.ok).toBe(true);
  });

  it("connects to wireless ADB endpoint", async () => {
    const adb = new AdbClient(
      fakeRunner({
        "connect 192.168.1.40:5555": "connected to 192.168.1.40:5555",
      }),
    );

    const result = await adb.connect("192.168.1.40", 5555);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("connected");
  });

  it("enables wireless ADB over USB and reports WLAN IP", async () => {
    const adb = new AdbClient(
      fakeRunner({
        "-s 1A2B3C4D tcpip 5555": "restarting in TCP mode port: 5555",
        "-s 1A2B3C4D shell ip -f inet addr show wlan0":
          "3: wlan0: <BROADCAST> mtu 1500\n    inet 192.168.1.50/24 brd 192.168.1.255 scope global wlan0\n",
      }),
    );

    const result = await adb.enableWirelessAdb("1A2B3C4D");

    expect(result).toEqual({
      ok: true,
      host: "192.168.1.50",
      port: 5555,
    });
  });
});
