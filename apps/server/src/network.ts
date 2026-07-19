import { createConnection } from "node:net";
import { networkInterfaces } from "node:os";
import type { PortProbe } from "./device-discovery.js";

export function createTcpPortProbe(timeoutMs = 200): PortProbe {
  return (host, port) =>
    new Promise((resolve) => {
      const socket = createConnection({ host, port });
      const done = (open: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(open);
      };
      socket.setTimeout(timeoutMs);
      socket.once("connect", () => done(true));
      socket.once("timeout", () => done(false));
      socket.once("error", () => done(false));
    });
}

/** Enumerate host addresses on private /24 subnets for scanning. */
export function localSubnetHosts(): string[] {
  const hosts = new Set<string>();
  const ifaces = networkInterfaces();
  for (const entries of Object.values(ifaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      const parts = entry.address.split(".").map(Number);
      if (parts.length !== 4) continue;
      // Skip link-local
      if (parts[0] === 169 && parts[1] === 254) continue;
      const prefix = `${parts[0]}.${parts[1]}.${parts[2]}`;
      for (let i = 1; i <= 254; i++) {
        hosts.add(`${prefix}.${i}`);
      }
    }
  }
  return [...hosts];
}
