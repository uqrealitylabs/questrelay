import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const relay = process.env.QUESTRELAY_DEV_BACKEND ?? "http://127.0.0.1:8788";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: Number(process.env.QUESTRELAY_DEV_PORT ?? 5173),
    proxy: {
      "/api": relay,
      "/ws": {
        target: relay.replace(/^http/, "ws"),
        ws: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test-setup.ts"],
  },
});
