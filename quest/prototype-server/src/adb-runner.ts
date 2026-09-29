import { spawn } from "node:child_process";
import type { CommandRunner } from "./adb-client.js";

export function createAdbCommandRunner(adbPath = "adb"): CommandRunner {
  return (args) =>
    new Promise((resolve) => {
      const child = spawn(adbPath, args, { windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (err) => {
        resolve({ stdout, stderr: err.message, code: 1 });
      });
      child.on("close", (code) => {
        resolve({ stdout, stderr, code: code ?? 1 });
      });
    });
}
