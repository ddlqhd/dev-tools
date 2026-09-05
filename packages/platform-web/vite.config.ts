import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4800",
        // String shorthand only forwards HTTP. Without this the browser
        // socket to /api/stream never upgrades and the hub stays "connecting".
        ws: true,
      },
      "/webhooks": "http://127.0.0.1:4800",
      "/health": "http://127.0.0.1:4800",
    },
  },
});
