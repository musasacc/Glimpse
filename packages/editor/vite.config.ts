import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, the Glimpse server (`glimpse open`, default port 4321) serves the
// preview, the API and the live-mode websocket; Vite only serves the editor UI.
// A React project's preview runs on its own Vite, whose HMR websocket is under
// /preview/. Start the server with GLIMPSE_DEV_ORIGIN=http://localhost:5173, or it
// refuses the editor's POSTs and websockets (they come from another origin).
const server = process.env.GLIMPSE_SERVER ?? "http://127.0.0.1:4321";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: {
      "/api": server,
      "/preview": { target: server, ws: true },
      "/snapshot": server,
      "/variant/": server,
      "/__glimpse": { target: server, ws: true },
    },
  },
});
