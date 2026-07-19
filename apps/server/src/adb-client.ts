export type CommandResult = {
  stdout: string;
  stderr: string;
  code: number;
};

export type CommandRunner = (args: string[]) => Promise<CommandResult>;

export type AdbDevice = {
  serial: string;
  state: string;
  transport: "usb" | "tcp" | "unknown";
  model?: string;
};

export type AdbActionResult = {
  ok: boolean;
  message: string;
};

export type WirelessEnableResult =
  | { ok: true; host: string; port: number }
  | { ok: false; message: string };

function detectTransport(serial: string): AdbDevice["transport"] {
  if (serial.includes(":")) return "tcp";
  if (/^[0-9A-Fa-f]+$/.test(serial) || serial.length >= 6) return "usb";
  return "unknown";
}

export class AdbClient {
  constructor(private readonly run: CommandRunner) {}

  async listDevices(): Promise<AdbDevice[]> {
    const { stdout } = await this.run(["devices", "-l"]);
    const lines = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("List of devices"));

    return lines.map((line) => {
      const [serial, state, ...rest] = line.split(/\s+/);
      const meta = rest.join(" ");
      const modelMatch = /model:(\S+)/.exec(meta);
      return {
        serial,
        state,
        transport: detectTransport(serial),
        model: modelMatch?.[1],
      };
    });
  }

  async pair(host: string, port: number, code: string): Promise<AdbActionResult> {
    const { stdout, stderr, code: exit } = await this.run([
      "pair",
      `${host}:${port}`,
      code,
    ]);
    const message = (stdout || stderr).trim();
    return { ok: exit === 0 && /paired/i.test(message), message };
  }

  async connect(host: string, port: number): Promise<AdbActionResult> {
    const { stdout, stderr, code } = await this.run([
      "connect",
      `${host}:${port}`,
    ]);
    const message = (stdout || stderr).trim();
    const ok =
      code === 0 &&
      (/connected/i.test(message) || /already connected/i.test(message));
    return { ok, message };
  }

  async disconnect(host: string, port: number): Promise<AdbActionResult> {
    const { stdout, stderr, code } = await this.run([
      "disconnect",
      `${host}:${port}`,
    ]);
    const message = (stdout || stderr).trim();
    return { ok: code === 0, message };
  }

  async enableWirelessAdb(serial: string): Promise<WirelessEnableResult> {
    const tcpip = await this.run(["-s", serial, "tcpip", "5555"]);
    if (tcpip.code !== 0) {
      return { ok: false, message: tcpip.stderr || tcpip.stdout };
    }

    const ipResult = await this.run([
      "-s",
      serial,
      "shell",
      "ip",
      "-f",
      "inet",
      "addr",
      "show",
      "wlan0",
    ]);
    const match = /inet\s+(\d+\.\d+\.\d+\.\d+)/.exec(ipResult.stdout);
    if (!match) {
      return {
        ok: false,
        message: "Could not read WLAN IP from wlan0",
      };
    }
    return { ok: true, host: match[1], port: 5555 };
  }

  async push(serial: string, localPath: string, remotePath: string): Promise<void> {
    const result = await this.run([
      "-s",
      serial,
      "push",
      localPath,
      remotePath,
    ]);
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || "adb push failed");
    }
  }

  async reverse(serial: string, remote: string, local: string): Promise<void> {
    const result = await this.run(["-s", serial, "reverse", remote, local]);
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || "adb reverse failed");
    }
  }

  async forward(serial: string, local: string, remote: string): Promise<void> {
    const result = await this.run(["-s", serial, "forward", local, remote]);
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || "adb forward failed");
    }
  }

  async shell(serial: string, command: string): Promise<CommandResult> {
    return this.run(["-s", serial, "shell", command]);
  }
}
